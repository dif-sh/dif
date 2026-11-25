//! `dif site setup` and `dif site check`: site analytics via the cloud.

use super::connect::report_no_workspace;
use super::project::project_session;
use super::CmdError;
use crate::cloud::{print_json, rejected, ApiError, Client, Clock, CloudEnv, Failure, RealClock};
use clap::{Args as ClapArgs, Subcommand, ValueEnum};
use dif_core::workspace::WorkspaceError;
use dif_core::Workspace;
use serde_json::{json, Value};
use std::process::ExitCode;
use std::time::Duration;

/// The route's cap on origins.
const MAX_ORIGINS: usize = 32;
const POLL: Duration = Duration::from_secs(10);

#[derive(ClapArgs, Debug)]
pub struct Args {
    #[command(subcommand)]
    pub command: SiteCommand,
}

#[derive(Subcommand, Debug)]
pub enum SiteCommand {
    /// Turn on site analytics for an env and allow origins.
    Setup(SetupArgs),
    /// Check that site events arrive.
    Check(CheckArgs),
}

#[derive(ValueEnum, Clone, Copy, Debug)]
pub enum Env {
    Live,
    Test,
}

impl Env {
    fn as_str(self) -> &'static str {
        match self {
            Env::Live => "live",
            Env::Test => "test",
        }
    }
}

#[derive(ClapArgs, Debug)]
pub struct SetupArgs {
    #[arg(long, value_enum)]
    pub env: Env,
    /// Allowed origin, `scheme://host[:port]`. Repeat for more.
    #[arg(long = "origin", required = true)]
    pub origins: Vec<String>,
    /// Events per minute allowed for the key.
    #[arg(long)]
    pub rate_limit: Option<u32>,
    /// Replace the stored origins. Default: add to them.
    #[arg(long)]
    pub replace: bool,
    /// Project slug. Default: from the git remote.
    #[arg(long)]
    pub project: Option<String>,
}

#[derive(ClapArgs, Debug)]
pub struct CheckArgs {
    #[arg(long, value_enum)]
    pub env: Env,
    /// Seconds to wait for events. 0: check once.
    #[arg(long, default_value_t = 0)]
    pub wait: u64,
    /// Project slug. Default: from the git remote.
    #[arg(long)]
    pub project: Option<String>,
}

pub fn run(args: Args, json: bool) -> Result<ExitCode, CmdError> {
    let cwd = std::env::current_dir()?;
    let workspace = match Workspace::load(&cwd) {
        Ok(ws) => ws,
        Err(WorkspaceError::NotFound(_)) => {
            report_no_workspace(json);
            return Ok(ExitCode::from(2));
        }
        Err(e) => return Err(e.into()),
    };
    let env = CloudEnv::from_process();
    let (project, env_name) = match &args.command {
        SiteCommand::Setup(a) => (a.project.as_deref(), a.env),
        SiteCommand::Check(a) => (a.project.as_deref(), a.env),
    };
    // Refuse bad origins before any request.
    if let SiteCommand::Setup(a) = &args.command {
        if let Err(f) = normalize_all(&a.origins) {
            return Ok(f.report(json));
        }
    }
    let (client, session, slug) = match project_session(&workspace.root, project, &env) {
        Ok(t) => t,
        Err(f) => return Ok(f.report(json)),
    };
    let result = match &args.command {
        SiteCommand::Setup(a) => setup(&client, &slug, a),
        SiteCommand::Check(a) => check(
            &client,
            &slug,
            env_name,
            Duration::from_secs(a.wait),
            &RealClock,
        ),
    };
    let value = match result {
        Ok(v) => v,
        Err(e) => return Ok(rejected(&env, &session, e).report(json)),
    };
    if !print_json(json, &value) {
        print_human(&args.command, &value);
    }
    Ok(ExitCode::from(0))
}

fn print_human(cmd: &SiteCommand, value: &Value) {
    match cmd {
        SiteCommand::Setup(a) => {
            let origins = normalize_all(&a.origins).unwrap_or_default();
            println!(
                "✓ site analytics on for {}: {}",
                a.env.as_str(),
                origins.join(", ")
            );
        }
        SiteCommand::Check(_) => {
            for line in value["lines"].as_array().into_iter().flatten() {
                if let Some(s) = line.as_str() {
                    println!("{s}");
                }
            }
        }
    }
}

/// `scheme://host[:port]`, no path, no trailing slash.
/// Returns the trimmed origin, lowercase scheme and host.
fn normalize_origin(raw: &str) -> Result<String, Failure> {
    let bad = |why: &str| {
        Failure::new(
            "usage",
            2,
            format!("origin {raw:?} {why}; use scheme://host[:port]"),
        )
    };
    let raw_trim = raw.trim();
    let (scheme, rest) = raw_trim
        .split_once("://")
        .ok_or_else(|| bad("has no scheme"))?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(bad("must use http or https"));
    }
    if rest.contains(['/', '?', '#']) {
        return Err(bad("must not have a path, query or fragment"));
    }
    if rest.contains('@') || rest.chars().any(char::is_whitespace) {
        return Err(bad("is not a plain host"));
    }
    let (host, port) = if let Some(inner) = rest.strip_prefix('[') {
        // Bracketed IPv6 host, then an optional port.
        let (addr, tail) = inner
            .split_once(']')
            .ok_or_else(|| bad("has an open bracket"))?;
        if addr.is_empty()
            || !addr
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.')
        {
            return Err(bad("has a bad IPv6 host"));
        }
        let port = match tail {
            "" => None,
            t => Some(t.strip_prefix(':').ok_or_else(|| bad("has a bad port"))?),
        };
        (&rest[..addr.len() + 2], port)
    } else {
        match rest.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (rest, None),
        }
    };
    if host.is_empty() {
        return Err(bad("has no host"));
    }
    if let Some(p) = port {
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return Err(bad("has a bad port"));
        }
    }
    Ok(match port {
        Some(p) => format!("{scheme}://{}:{p}", host.to_ascii_lowercase()),
        None => format!("{scheme}://{}", host.to_ascii_lowercase()),
    })
}

fn normalize_all(raw: &[String]) -> Result<Vec<String>, Failure> {
    if raw.len() > MAX_ORIGINS {
        return Err(Failure::new(
            "usage",
            2,
            format!("at most {MAX_ORIGINS} --origin values"),
        ));
    }
    raw.iter().map(|o| normalize_origin(o)).collect()
}

fn with_project(mut v: Value, slug: &str) -> Value {
    if let Some(o) = v.as_object_mut() {
        o.insert("ok".into(), json!(true));
        o.insert("project".into(), json!(slug));
    }
    v
}

fn setup(client: &Client, slug: &str, a: &SetupArgs) -> Result<Value, ApiError> {
    // Callers refuse bad origins first; keep the guard here too.
    let origins = normalize_all(&a.origins).map_err(|_| ApiError::BadBody)?;
    let mut body = json!({
        "env": a.env.as_str(),
        "allowed_origins": origins,
        "replace": a.replace,
    });
    if let Some(n) = a.rate_limit {
        body["rate_limit_per_min"] = json!(n);
    }
    let resp = client.post(&format!("/v1/cli/projects/{slug}/site/setup"), &body)?;
    Ok(with_project(resp, slug))
}

fn seen_events(v: &Value) -> bool {
    v["status"] == "seen" && v["accepted_last_hour"].as_u64().is_some_and(|n| n > 0)
}

fn check(
    client: &Client,
    slug: &str,
    env: Env,
    wait: Duration,
    clock: &dyn Clock,
) -> Result<Value, ApiError> {
    let path = format!("/v1/cli/projects/{slug}/site/install-check");
    client.post(&path, &json!({ "env": env.as_str() }))?;
    let get_path = format!("{path}?env={}", env.as_str());
    // A wait past the clock's range has no deadline.
    let deadline = clock.now().checked_add(wait);
    loop {
        let resp = client.get(&get_path)?;
        let left = deadline.map_or(Duration::MAX, |d| d.saturating_duration_since(clock.now()));
        if wait.is_zero() || seen_events(&resp) || left.is_zero() {
            return Ok(with_project(resp, slug));
        }
        clock.sleep(POLL.min(left));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::fake_server::FakeServer;
    use std::cell::{Cell, RefCell};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    struct FakeClock {
        now: Cell<Instant>,
        sleeps: RefCell<Vec<u64>>,
    }

    impl FakeClock {
        fn new() -> Self {
            FakeClock {
                now: Cell::new(Instant::now()),
                sleeps: RefCell::new(Vec::new()),
            }
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            self.now.get()
        }
        fn sleep(&self, d: Duration) {
            self.sleeps.borrow_mut().push(d.as_secs());
            self.now.set(self.now.get() + d);
        }
    }

    fn client(server: &FakeServer) -> Client {
        Client::new(&server.url, Some("dif_cli_x".into()))
    }

    fn setup_args(origins: Vec<String>) -> SetupArgs {
        SetupArgs {
            env: Env::Live,
            origins,
            rate_limit: None,
            replace: false,
            project: None,
        }
    }

    fn usage(f: Failure) -> (&'static str, u8) {
        (f.code, f.exit)
    }

    #[test]
    fn normalize_origin_accepts_scheme_host_port() {
        assert_eq!(
            normalize_origin("https://Example.com:8443").unwrap(),
            "https://example.com:8443"
        );
        assert_eq!(
            normalize_origin(" HTTP://Localhost ").unwrap(),
            "http://localhost"
        );
    }

    #[test]
    fn normalize_origin_handles_ipv6_hosts() {
        assert_eq!(normalize_origin("http://[::1]").unwrap(), "http://[::1]");
        assert_eq!(
            normalize_origin("http://[::1]:5173").unwrap(),
            "http://[::1]:5173"
        );
        for raw in ["http://[::1", "http://[::1]x", "http://[::1]:", "http://[]"] {
            assert_eq!(
                usage(normalize_origin(raw).unwrap_err()),
                ("usage", 2),
                "{raw}"
            );
        }
    }

    #[test]
    fn normalize_origin_refuses_path_and_slash() {
        for raw in [
            "https://example.com/",
            "https://example.com/app",
            "https://example.com?x=1",
            "https://example.com#top",
        ] {
            assert_eq!(
                usage(normalize_origin(raw).unwrap_err()),
                ("usage", 2),
                "{raw}"
            );
        }
    }

    #[test]
    fn normalize_origin_refuses_other_schemes() {
        assert_eq!(
            usage(normalize_origin("ftp://x").unwrap_err()),
            ("usage", 2)
        );
        assert_eq!(
            usage(normalize_origin("example.com").unwrap_err()),
            ("usage", 2)
        );
    }

    #[test]
    fn setup_posts_the_contract_body() {
        let server = FakeServer::start(|_| (200, r#"{"env":"live"}"#.into()));
        let a = setup_args(vec!["https://Example.com".into()]);
        let out = setup(&client(&server), "acme", &a).unwrap();
        let reqs = server.requests.lock().unwrap();
        assert_eq!(reqs[0].method, "POST");
        assert_eq!(reqs[0].path, "/v1/cli/projects/acme/site/setup");
        let body: Value = serde_json::from_str(&reqs[0].body).unwrap();
        assert_eq!(
            body,
            json!({"env":"live","allowed_origins":["https://example.com"],"replace":false})
        );
        assert_eq!(out["ok"], true);
        assert_eq!(out["project"], "acme");
    }

    #[test]
    fn setup_sends_rate_limit_only_when_set() {
        let server = FakeServer::start(|_| (200, "{}".into()));
        let mut a = setup_args(vec!["https://example.com".into()]);
        a.rate_limit = Some(120);
        a.replace = true;
        setup(&client(&server), "acme", &a).unwrap();
        let body: Value = serde_json::from_str(&server.requests.lock().unwrap()[0].body).unwrap();
        assert_eq!(body["rate_limit_per_min"], 120);
        assert_eq!(body["replace"], true);
    }

    #[test]
    fn setup_refuses_more_than_32_origins() {
        let server = FakeServer::start(|_| (200, "{}".into()));
        let origins: Vec<String> = (0..33).map(|i| format!("https://a{i}.com")).collect();
        let f = normalize_all(&origins).unwrap_err();
        assert_eq!(usage(f), ("usage", 2));
        assert!(setup(&client(&server), "acme", &setup_args(origins)).is_err());
        assert!(server.paths().is_empty());
    }

    /// Answer GETs from `gets` in order, then repeat the last.
    fn check_server(gets: Vec<&'static str>) -> FakeServer {
        let n = AtomicUsize::new(0);
        FakeServer::start(move |req| {
            if req.method == "POST" {
                return (200, "{}".into());
            }
            let i = n.fetch_add(1, Ordering::SeqCst).min(gets.len() - 1);
            (200, gets[i].into())
        })
    }

    const ZERO: &str = r#"{"status":"seen","accepted_last_hour":0,"pageviews_last_hour":0}"#;
    const THREE: &str = r#"{"status":"seen","accepted_last_hour":3,"pageviews_last_hour":2}"#;

    fn get_count(server: &FakeServer) -> usize {
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.method == "GET")
            .count()
    }

    #[test]
    fn check_posts_then_gets_once_without_wait() {
        let server = check_server(vec![ZERO]);
        let clock = FakeClock::new();
        let out = check(&client(&server), "acme", Env::Test, Duration::ZERO, &clock).unwrap();
        assert_eq!(
            server.paths(),
            [
                "/v1/cli/projects/acme/site/install-check",
                "/v1/cli/projects/acme/site/install-check?env=test"
            ]
        );
        assert_eq!(out["accepted_last_hour"], 0);
        assert_eq!(out["ok"], true);
        assert!(clock.sleeps.borrow().is_empty());
    }

    #[test]
    fn check_wait_stops_when_events_arrive() {
        let server = check_server(vec![ZERO, THREE]);
        let clock = FakeClock::new();
        let out = check(
            &client(&server),
            "acme",
            Env::Live,
            Duration::from_secs(60),
            &clock,
        )
        .unwrap();
        assert_eq!(server.paths().len(), 3);
        assert_eq!(out["accepted_last_hour"], 3);
    }

    #[test]
    fn check_wait_gives_up_after_the_wait() {
        let server = check_server(vec![ZERO]);
        let clock = FakeClock::new();
        let out = check(
            &client(&server),
            "acme",
            Env::Live,
            Duration::from_secs(25),
            &clock,
        )
        .unwrap();
        assert_eq!(get_count(&server), 4);
        assert_eq!(*clock.sleeps.borrow(), vec![10, 10, 5]);
        assert_eq!(out["ok"], true);
    }

    #[test]
    fn check_huge_wait_does_not_panic() {
        let server = check_server(vec![THREE]);
        let clock = FakeClock::new();
        let wait = Duration::from_secs(u64::MAX);
        let out = check(&client(&server), "acme", Env::Live, wait, &clock).unwrap();
        assert_eq!(out["accepted_last_hour"], 3);
    }

    #[test]
    fn check_wait_keeps_polling_on_unknown_key() {
        let server = check_server(vec![
            r#"{"status":"unknown_key","accepted_last_hour":null,"pageviews_last_hour":null}"#,
            r#"{"status":"seen","accepted_last_hour":2,"pageviews_last_hour":1}"#,
        ]);
        let clock = FakeClock::new();
        check(
            &client(&server),
            "acme",
            Env::Live,
            Duration::from_secs(60),
            &clock,
        )
        .unwrap();
        assert_eq!(get_count(&server), 2);
    }

    #[test]
    fn check_passes_null_counts_through() {
        let server = check_server(vec![
            r#"{"status":"unavailable","accepted_last_hour":null,"pageviews_last_hour":null}"#,
        ]);
        let clock = FakeClock::new();
        let out = check(&client(&server), "acme", Env::Live, Duration::ZERO, &clock).unwrap();
        assert!(out["accepted_last_hour"].is_null());
        assert!(out["pageviews_last_hour"].is_null());
    }
}

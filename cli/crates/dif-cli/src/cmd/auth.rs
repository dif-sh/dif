//! `dif auth`: sign in to dif.sh Cloud by device code.

use super::CmdError;
use crate::cloud::credentials::{PendingLogin, StoredCredential};
use crate::cloud::{print_json, rejected, ApiError, Client, CloudEnv, Failure, Source};
use clap::{Args as ClapArgs, Subcommand};
use console::style;
use serde_json::{json, Value};
use std::io::IsTerminal;
use std::process::ExitCode;
use std::time::{Duration, Instant};

/// `dif auth` flags.
#[derive(ClapArgs, Debug)]
pub struct Args {
    #[command(subcommand)]
    pub command: AuthCommand,
}

#[derive(Subcommand, Debug)]
pub enum AuthCommand {
    /// Sign in with a code you approve in the browser.
    Login(LoginArgs),
    /// Show the current login. No network call unless --verify.
    Status(StatusArgs),
    /// Revoke the token and delete the local credential.
    Logout,
}

#[derive(ClapArgs, Debug)]
pub struct LoginArgs {
    /// Start the login, print the URL and code, then return.
    #[arg(long, conflicts_with = "resume")]
    pub no_wait: bool,
    /// Wait for the login that --no-wait started.
    #[arg(long)]
    pub resume: bool,
    /// Stop waiting after this many seconds.
    #[arg(long, default_value_t = 600)]
    pub timeout: u64,
    /// Print the URL only. Do not open a browser.
    #[arg(long)]
    pub no_browser: bool,
}

#[derive(ClapArgs, Debug)]
pub struct StatusArgs {
    /// Ask dif.sh Cloud if the token is still valid.
    #[arg(long)]
    pub verify: bool,
}

/// Entrypoint.
pub fn run(args: Args, json: bool) -> Result<ExitCode, CmdError> {
    let env = CloudEnv::from_process();
    let result = match args.command {
        AuthCommand::Login(a) => login(&a, &env, json),
        AuthCommand::Status(a) => status(&a, &env, json),
        AuthCommand::Logout => logout(&env, json),
    };
    Ok(match result? {
        Ok(()) => ExitCode::from(0),
        Err(f) => f.report(json),
    })
}

type Outcome = Result<Result<(), Failure>, CmdError>;

fn login(args: &LoginArgs, env: &CloudEnv, json: bool) -> Outcome {
    let pending = if args.resume {
        match env.load_pending() {
            Some(p) => p,
            None => {
                return Ok(Err(Failure::new(
                    "no_pending_login",
                    2,
                    "no login to resume; run dif auth login --no-wait first",
                )))
            }
        }
    } else {
        match start_login(env)? {
            Ok(p) => p,
            Err(f) => return Ok(Err(f)),
        }
    };

    if args.no_wait {
        let payload = json!({
            "ok": true,
            "status": "pending",
            "verification_uri": pending.verification_uri,
            "verification_uri_complete": pending.verification_uri_complete,
            "user_code": pending.user_code,
            "expires_in": pending.expires_in,
        });
        if !print_json(json, &payload) {
            print_code(&pending);
            eprintln!(
                "  then run {} to finish",
                style("dif auth login --resume").bold()
            );
        }
        return Ok(Ok(()));
    }

    if !args.resume {
        print_code(&pending);
        if !args.no_browser && std::io::stderr().is_terminal() {
            open_browser(&pending.verification_uri_complete);
        }
    }

    let cred = match finish_login(env, &pending, Duration::from_secs(args.timeout))? {
        Ok(c) => c,
        Err(f) => return Ok(Err(f)),
    };

    let payload = json!({
        "ok": true,
        "status": "logged_in",
        "user": cred.user,
        "expires_at": cred.expires_at,
    });
    if !print_json(json, &payload) {
        println!(
            "{} logged in as {}",
            style("✓").green().bold(),
            cred.user
                .as_ref()
                .and_then(|u| u["email"].as_str())
                .unwrap_or("unknown user"),
        );
    }
    Ok(Ok(()))
}

/// Wait for the person to approve `pending`, then save the token.
/// Shared by `dif auth login` and the `dif init` sign-in step.
pub(crate) fn finish_login(
    env: &CloudEnv,
    pending: &PendingLogin,
    timeout: Duration,
) -> Result<Result<StoredCredential, Failure>, CmdError> {
    let client = Client::new(&pending.cloud_url, None);
    let outcome = poll_for_token(
        &client,
        &pending.device_code,
        Duration::from_secs(pending.interval),
        timeout,
        &RealClock,
    );
    let token = match outcome {
        Ok(PollOutcome::Approved(v)) => v,
        Ok(PollOutcome::Pending) => {
            return Ok(Err(Failure::new(
                "authorization_pending",
                2,
                "still waiting for approval; run dif auth login --resume",
            )))
        }
        Ok(PollOutcome::Denied) => {
            env.delete_pending()?;
            return Ok(Err(Failure::new(
                "access_denied",
                1,
                "the login was denied",
            )));
        }
        Ok(PollOutcome::Expired) => {
            env.delete_pending()?;
            return Ok(Err(Failure::new(
                "expired_token",
                1,
                "the login code expired; run dif auth login again",
            )));
        }
        Err(e) => return Ok(Err(e.into_failure())),
    };

    let Some(tok) = token["token"].as_str() else {
        return Ok(Err(ApiError::BadBody.into_failure()));
    };
    let cred = StoredCredential {
        token: tok.to_string(),
        cloud_url: pending.cloud_url.clone(),
        user: token.get("user").cloned(),
        expires_at: token["expires_at"].as_str().map(String::from),
    };
    env.save_credential(&cred)?;
    env.delete_pending()?;
    Ok(Ok(cred))
}

pub(crate) fn start_login(env: &CloudEnv) -> Result<Result<PendingLogin, Failure>, CmdError> {
    let base = env.login_url();
    let client = Client::new(&base, None);
    let body = json!({
        "client_name": "dif",
        "client_version": env!("CARGO_PKG_VERSION"),
        "hostname": hostname(),
    });
    let v = match client.post("/v1/cli/device", &body) {
        Ok(v) => v,
        Err(e) => return Ok(Err(e.into_failure())),
    };
    let text = |k: &str| v[k].as_str().map(String::from);
    let (Some(device_code), Some(user_code), Some(uri), Some(uri_complete)) = (
        text("device_code"),
        text("user_code"),
        text("verification_uri"),
        text("verification_uri_complete"),
    ) else {
        return Ok(Err(ApiError::BadBody.into_failure()));
    };
    let pending = PendingLogin {
        device_code,
        user_code,
        verification_uri: uri,
        verification_uri_complete: uri_complete,
        interval: v["interval"].as_u64().unwrap_or(5),
        expires_in: v["expires_in"].as_u64().unwrap_or(600),
        cloud_url: client.base().to_string(),
    };
    env.save_pending(&pending)?;
    Ok(Ok(pending))
}

fn print_code(p: &PendingLogin) {
    eprintln!("Open {}", style(&p.verification_uri_complete).bold());
    eprintln!("and confirm the code {}", style(&p.user_code).bold());
}

fn hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Best effort. The URL is on stderr if this fails.
pub(crate) fn open_browser(url: &str) {
    let mut cmd = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
    } else if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        // `start` reads the first quoted word as a window title.
        c.args(["/C", "start", ""]);
        c
    } else {
        std::process::Command::new("xdg-open")
    };
    let _ = cmd
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

#[derive(Debug)]
enum PollOutcome {
    Approved(Value),
    Pending,
    Denied,
    Expired,
}

trait Clock {
    fn now(&self) -> Instant;
    fn sleep(&self, d: Duration);
}

struct RealClock;

impl Clock for RealClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
    fn sleep(&self, d: Duration) {
        std::thread::sleep(d);
    }
}

fn poll_for_token(
    client: &Client,
    device_code: &str,
    interval: Duration,
    timeout: Duration,
    clock: &dyn Clock,
) -> Result<PollOutcome, ApiError> {
    let deadline = clock.now() + timeout;
    // A zero interval from the server makes a busy loop.
    let mut interval = if interval.is_zero() {
        Duration::from_secs(5)
    } else {
        interval
    };
    loop {
        clock.sleep(interval.min(deadline.saturating_duration_since(clock.now())));
        match client.post("/v1/cli/token", &json!({ "device_code": device_code })) {
            Ok(v) => return Ok(PollOutcome::Approved(v)),
            Err(e) => match e.code() {
                Some("authorization_pending") => {}
                Some("slow_down") => interval += Duration::from_secs(5),
                Some("access_denied") => return Ok(PollOutcome::Denied),
                Some("expired_token") => return Ok(PollOutcome::Expired),
                _ => return Err(e),
            },
        }
        if clock.now() >= deadline {
            return Ok(PollOutcome::Pending);
        }
    }
}

fn status(args: &StatusArgs, env: &CloudEnv, json: bool) -> Outcome {
    let Some(mut session) = env.session() else {
        if !print_json(json, &json!({ "ok": true, "logged_in": false })) {
            println!("not logged in; run {}", style("dif auth login").bold());
        }
        return Ok(Ok(()));
    };
    if args.verify {
        let client = Client::new(&session.cloud_url, Some(session.token.clone()));
        match client.get("/v1/cli/whoami") {
            Ok(v) => {
                session.user = v.get("user").cloned();
                session.expires_at = v["expires_at"].as_str().map(String::from);
            }
            Err(e) => return Ok(Err(rejected(env, &session, e))),
        }
    }

    let mut payload = json!({
        "ok": true,
        "logged_in": true,
        "source": session.source.as_str(),
        "cloud_url": session.cloud_url,
    });
    if let Some(user) = &session.user {
        payload["user"] = user.clone();
    }
    if let Some(at) = &session.expires_at {
        payload["expires_at"] = json!(at);
    }
    if !print_json(json, &payload) {
        let who = session
            .user
            .as_ref()
            .and_then(|u| u["email"].as_str())
            .unwrap_or("a token");
        println!(
            "{} logged in to {} as {who} (from {})",
            style("✓").green().bold(),
            session.cloud_url,
            match session.source {
                Source::File => "the credentials file",
                Source::Env => "DIF_TOKEN",
            },
        );
    }
    Ok(Ok(()))
}

fn logout(env: &CloudEnv, json: bool) -> Outcome {
    let revoked = match env.load_credential() {
        Some(c) => Client::new(&c.cloud_url, Some(c.token))
            .post("/v1/cli/logout", &json!({}))
            .ok()
            .and_then(|v| v["revoked"].as_bool())
            .unwrap_or(false),
        None => false,
    };
    env.delete_credential()?;
    if !print_json(json, &json!({ "ok": true, "revoked": revoked })) {
        println!("{} logged out", style("✓").green().bold());
    }
    Ok(Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::fake_server::FakeServer;
    use std::cell::{Cell, RefCell};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Time moves only when the poll loop sleeps.
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

    /// Answer each poll with the next error code, then succeed.
    fn token_server(codes: &'static [&'static str]) -> FakeServer {
        let n = AtomicUsize::new(0);
        FakeServer::start(move |req| {
            assert_eq!(
                (req.method.as_str(), req.path.as_str()),
                ("POST", "/v1/cli/token")
            );
            assert!(req.body.contains("\"device_code\":\"dc-1\""));
            let i = n.fetch_add(1, Ordering::SeqCst);
            match codes.get(i) {
                Some(code) => (400, format!("{{\"error\":\"{code}\"}}")),
                None => (
                    200,
                    r#"{"token":"dif_cli_x","expires_at":"2027-02-03T00:00:00Z","user":{"id":"u1","email":"dev@example.com"}}"#
                        .into(),
                ),
            }
        })
    }

    fn poll(server: &FakeServer, timeout: u64, clock: &FakeClock) -> PollOutcome {
        let client = Client::new(&server.url, None);
        poll_for_token(
            &client,
            "dc-1",
            Duration::from_secs(5),
            Duration::from_secs(timeout),
            clock,
        )
        .unwrap()
    }

    #[test]
    fn polls_through_pending_and_slow_down_to_success() {
        let server = token_server(&["authorization_pending", "slow_down"]);
        let clock = FakeClock::new();
        match poll(&server, 600, &clock) {
            PollOutcome::Approved(v) => assert_eq!(v["token"], "dif_cli_x"),
            other => panic!("expected approval, got {other:?}"),
        }
        // slow_down adds 5 seconds to every later wait.
        assert_eq!(*clock.sleeps.borrow(), vec![5, 5, 10]);
    }

    #[test]
    fn stops_on_access_denied() {
        let server = token_server(&["authorization_pending", "access_denied"]);
        assert!(matches!(
            poll(&server, 600, &FakeClock::new()),
            PollOutcome::Denied
        ));
    }

    #[test]
    fn stops_on_expired_token() {
        let server = token_server(&["expired_token"]);
        assert!(matches!(
            poll(&server, 600, &FakeClock::new()),
            PollOutcome::Expired
        ));
    }

    #[test]
    fn returns_pending_when_timeout_comes_first() {
        let server = token_server(&["authorization_pending"; 10]);
        let clock = FakeClock::new();
        assert!(matches!(poll(&server, 12, &clock), PollOutcome::Pending));
        assert_eq!(*clock.sleeps.borrow(), vec![5, 5, 2]);
        assert_eq!(server.paths().len(), 3);
    }

    #[test]
    fn zero_interval_falls_back_to_five_seconds() {
        let server = token_server(&["authorization_pending"; 10]);
        let clock = FakeClock::new();
        let client = Client::new(&server.url, None);
        let outcome = poll_for_token(
            &client,
            "dc-1",
            Duration::ZERO,
            Duration::from_secs(12),
            &clock,
        )
        .unwrap();
        assert!(matches!(outcome, PollOutcome::Pending));
        assert_eq!(*clock.sleeps.borrow(), vec![5, 5, 2]);
    }

    #[test]
    fn logout_revokes_at_the_host_that_issued_the_token() {
        let server = FakeServer::start(|_| (200, r#"{"revoked":true}"#.into()));
        let tmp = tempfile::tempdir().unwrap();
        let env = CloudEnv {
            config_dir: Some(tmp.path().join("dif")),
            token: None,
            cloud_url: Some("http://127.0.0.1:1".into()),
        };
        env.save_credential(&StoredCredential {
            token: "dif_cli_file".into(),
            cloud_url: server.url.clone(),
            user: None,
            expires_at: None,
        })
        .unwrap();

        logout(&env, true).unwrap().unwrap();
        assert_eq!(server.paths(), ["/v1/cli/logout"]);
        assert!(env.load_credential().is_none());
    }

    #[test]
    fn unknown_error_code_is_an_error() {
        let server = token_server(&["something_else"]);
        let client = Client::new(&server.url, None);
        let err = poll_for_token(
            &client,
            "dc-1",
            Duration::from_secs(5),
            Duration::from_secs(60),
            &FakeClock::new(),
        )
        .unwrap_err();
        assert_eq!(err.code(), Some("something_else"));
    }
}

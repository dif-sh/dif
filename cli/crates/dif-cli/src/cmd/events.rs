//! `dif events`: events dif analytics has seen, joined with the plan.

use super::connect::report_no_workspace;
use super::project::project_session;
use super::CmdError;
use crate::cloud::{print_json, rejected, Client, CloudEnv, Failure};
use clap::Args as ClapArgs;
use dif_core::paths::TRACKING_PLAN_FILE;
use dif_core::tracking_plan::TrackingPlan;
use dif_core::workspace::WorkspaceError;
use dif_core::Workspace;
use serde_json::{json, Value};
use std::process::ExitCode;

#[derive(ClapArgs, Debug)]
pub struct Args {
    /// Look-back window.
    #[arg(long, default_value = "24h", value_parser = ["1h", "24h", "7d"])]
    pub since: String,
    /// Add planned events that were not seen.
    #[arg(long)]
    pub plan: bool,
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
    // Fail on a bad plan before any request.
    if args.plan && workspace.tracking_plan.is_none() {
        return Ok(plan_failure(workspace.root.join(TRACKING_PLAN_FILE).exists()).report(json));
    }
    let env = CloudEnv::from_process();
    let (client, session, slug) =
        match project_session(&workspace.root, args.project.as_deref(), &env) {
            Ok(t) => t,
            Err(f) => return Ok(f.report(json)),
        };
    let rows = match fetch(&client, &slug, &args.since) {
        Ok(r) => r,
        Err(e) => return Ok(rejected(&env, &session, e).report(json)),
    };
    let value = match build_output(
        &slug,
        &args.since,
        rows,
        workspace.tracking_plan.as_ref(),
        args.plan,
    ) {
        Ok(v) => v,
        Err(f) => return Ok(f.report(json)),
    };
    if !print_json(json, &value) {
        print_human(&value, args.plan);
    }
    Ok(ExitCode::from(0))
}

/// The failure for `--plan` without a usable plan.
fn plan_failure(file_exists: bool) -> Failure {
    let msg = if file_exists {
        "dif/tracking-plan.yaml is not valid; run dif validate"
    } else {
        "dif/tracking-plan.yaml does not exist"
    };
    Failure::new("no_tracking_plan", 2, msg)
}

fn fetch(client: &Client, slug: &str, since: &str) -> Result<Vec<Value>, crate::cloud::ApiError> {
    let resp = client.get(&format!("/v1/cli/projects/{slug}/events?since={since}"))?;
    Ok(resp["events"].as_array().cloned().unwrap_or_default())
}

/// Rows from the route, joined with the plan.
fn with_plan(rows: Vec<Value>, plan: &TrackingPlan) -> Vec<Value> {
    let mut out: Vec<Value> = rows
        .into_iter()
        .map(|mut r| {
            let in_plan = r["name"].as_str().is_some_and(|n| plan.contains(n));
            r["in_plan"] = json!(in_plan);
            r
        })
        .collect();
    for e in &plan.events {
        if !out.iter().any(|r| r["name"] == e.name.as_str()) {
            out.push(json!({
                "name": e.name,
                "count": 0,
                "last_seen_ms": null,
                "builtin": false,
                "in_plan": true,
            }));
        }
    }
    out
}

fn build_output(
    slug: &str,
    since: &str,
    rows: Vec<Value>,
    plan: Option<&TrackingPlan>,
    want_plan: bool,
) -> Result<Value, Failure> {
    let mut out = json!({ "ok": true, "project": slug, "since": since });
    if !want_plan {
        out["events"] = json!(rows);
        return Ok(out);
    }
    let plan = plan.ok_or_else(|| plan_failure(false))?;
    let events = with_plan(rows, plan);
    let missing: Vec<&Value> = events
        .iter()
        .filter(|r| r["in_plan"] == true && r["count"].as_u64() == Some(0))
        .map(|r| &r["name"])
        .collect();
    out["missing"] = json!(missing);
    out["events"] = json!(events);
    Ok(out)
}

fn print_human(value: &Value, plan: bool) {
    let events = value["events"].as_array().cloned().unwrap_or_default();
    if events.is_empty() {
        println!(
            "no events in the last {}",
            value["since"].as_str().unwrap_or("")
        );
        return;
    }
    let width = events
        .iter()
        .filter_map(|e| e["name"].as_str())
        .map(|n| n.chars().count())
        .max()
        .unwrap_or(4)
        .max(4);
    println!("{:<width$}  {:>7}  last seen", "name", "count");
    for e in &events {
        let name = e["name"].as_str().unwrap_or("");
        let count = e["count"].as_u64().unwrap_or(0);
        let seen = match e["last_seen_ms"].as_i64() {
            Some(ms) => format!("{ms}"),
            None if plan => "not seen".to_string(),
            None => "—".to_string(),
        };
        println!("{name:<width$}  {count:>7}  {seen}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::fake_server::FakeServer;
    use dif_core::tracking_plan::{EventKind, PlannedEvent};

    fn plan(names: &[&str]) -> TrackingPlan {
        TrackingPlan {
            events: names
                .iter()
                .map(|n| PlannedEvent {
                    name: n.to_string(),
                    kind: EventKind::Product,
                    location: None,
                    props: vec![],
                })
                .collect(),
        }
    }

    fn rows() -> Vec<Value> {
        vec![
            json!({"name":"$pageview","count":10,"last_seen_ms":5,"builtin":true}),
            json!({"name":"signup","count":2,"last_seen_ms":4,"builtin":false}),
        ]
    }

    #[test]
    fn with_plan_marks_rows_and_appends_unseen() {
        let out = with_plan(rows(), &plan(&["signup", "checkout_started"]));
        assert_eq!(out.len(), 3);
        assert_eq!(out[0]["in_plan"], false);
        assert_eq!(out[1]["in_plan"], true);
        assert_eq!(out[2]["name"], "checkout_started");
        assert_eq!(out[2]["count"], 0);
        assert!(out[2]["last_seen_ms"].is_null());
        assert_eq!(out[2]["builtin"], false);
    }

    #[test]
    fn with_plan_keeps_route_order_then_plan_order() {
        let out = with_plan(rows(), &plan(&["b", "signup", "a"]));
        let names: Vec<&str> = out.iter().map(|r| r["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["$pageview", "signup", "b", "a"]);
    }

    #[test]
    fn gets_the_contract_path() {
        let server =
            FakeServer::start(|_| (200, r#"{"since":"7d","events":[{"name":"x"}]}"#.into()));
        let c = Client::new(&server.url, Some("dif_cli_x".into()));
        let got = fetch(&c, "acme", "7d").unwrap();
        assert_eq!(server.paths(), ["/v1/cli/projects/acme/events?since=7d"]);
        assert_eq!(got.len(), 1);
    }

    #[test]
    fn build_output_lists_missing_planned_names() {
        let p = plan(&["signup", "checkout_started"]);
        let v = build_output("acme", "24h", rows(), Some(&p), true).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["project"], "acme");
        assert_eq!(v["since"], "24h");
        assert_eq!(v["missing"], json!(["checkout_started"]));
    }

    #[test]
    fn build_output_without_plan_flag_passes_rows_through() {
        let v = build_output("acme", "1h", rows(), None, false).unwrap();
        assert_eq!(v["events"], json!(rows()));
        assert!(v.get("missing").is_none());
    }

    #[test]
    fn plan_flag_without_file_is_no_tracking_plan() {
        let f = build_output("acme", "24h", rows(), None, true).unwrap_err();
        assert_eq!((f.code, f.exit), ("no_tracking_plan", 2));
        assert!(f.message.contains("does not exist"));
    }

    #[test]
    fn plan_flag_with_invalid_file_says_not_valid() {
        let f = plan_failure(true);
        assert_eq!((f.code, f.exit), ("no_tracking_plan", 2));
        assert!(f.message.contains("not valid"));
    }
}

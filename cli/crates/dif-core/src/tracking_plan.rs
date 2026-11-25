//! Optional tracking plan at `dif/tracking-plan.yaml`.
//!
//! Lists the events an app should send. Loading never fails hard.

use crate::{diag::Diagnostic, paths};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

const MAX_NAME_BYTES: usize = 128;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
/// The whole plan file.
pub struct TrackingPlan {
    /// Planned events, in file order.
    pub events: Vec<PlannedEvent>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
/// One planned event.
pub struct PlannedEvent {
    /// Event name sent to dif.
    pub name: String,
    /// Product or marketing event.
    pub kind: EventKind,
    /// Where in the code the event fires.
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// Property names sent with the event.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub props: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
/// Event category.
pub enum EventKind {
    /// Signed-in product behaviour.
    Product,
    /// Public marketing page behaviour.
    Marketing,
}

impl TrackingPlan {
    /// True when `name` is a planned event.
    pub fn contains(&self, name: &str) -> bool {
        self.events.iter().any(|e| e.name == name)
    }
}

fn diag(
    code: &str,
    message: String,
    line: usize,
    column: usize,
    help: Option<String>,
) -> Diagnostic {
    Diagnostic {
        code: code.to_string(),
        message,
        file: paths::TRACKING_PLAN_FILE.to_string(),
        line,
        column,
        help,
    }
}

fn name_problem(name: &str) -> Option<&'static str> {
    if name.is_empty() {
        Some("is empty")
    } else if name.len() > MAX_NAME_BYTES {
        Some("is longer than 128 bytes")
    } else if name.starts_with('$') {
        Some("starts with `$`")
    } else if name.chars().any(|c| c.is_whitespace() || c.is_control()) {
        Some("has whitespace or control characters")
    } else {
        None
    }
}

/// `(None, [])` when the file is absent.
/// Diagnostics carry E011, E012 or E013.
pub fn load(root: &Path) -> (Option<TrackingPlan>, Vec<Diagnostic>) {
    let path = root.join(paths::TRACKING_PLAN_FILE);
    if !path.exists() {
        return (None, Vec::new());
    }
    let parsed = std::fs::read_to_string(&path)
        .map_err(|e| (e.to_string(), (1, 1)))
        .and_then(|src| {
            serde_yaml::from_str::<TrackingPlan>(&src).map_err(|e| {
                let loc = e
                    .location()
                    .map(|l| (l.line(), l.column()))
                    .unwrap_or((1, 1));
                (e.to_string(), loc)
            })
        });
    let plan = match parsed {
        Ok(plan) => plan,
        Err((message, (line, column))) => {
            return (None, vec![diag("E011", message, line, column, None)]);
        }
    };

    let mut diags = Vec::new();
    let mut seen = HashSet::new();
    for event in &plan.events {
        if let Some(problem) = name_problem(&event.name) {
            diags.push(diag(
                "E012",
                format!("event name \"{}\" {problem}", event.name),
                1,
                1,
                Some(
                    "names starting with `$` are reserved for built-ins such as `$pageview`"
                        .to_string(),
                ),
            ));
        }
        if !seen.insert(event.name.as_str()) {
            diags.push(diag(
                "E013",
                format!("duplicate event name \"{}\"", event.name),
                1,
                1,
                None,
            ));
        }
    }
    (Some(plan), diags)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(yaml: Option<&str>) -> (Option<TrackingPlan>, Vec<Diagnostic>) {
        let dir = tempfile::tempdir().unwrap();
        if let Some(y) = yaml {
            std::fs::create_dir_all(dir.path().join("dif")).unwrap();
            std::fs::write(dir.path().join(paths::TRACKING_PLAN_FILE), y).unwrap();
        }
        load(dir.path())
    }

    fn codes(d: &[Diagnostic]) -> Vec<&str> {
        d.iter().map(|d| d.code.as_str()).collect()
    }

    #[test]
    fn absent_file_is_none_and_clean() {
        let (plan, diags) = run(None);
        assert!(plan.is_none());
        assert!(diags.is_empty());
    }

    #[test]
    fn parses_a_valid_plan() {
        let (plan, diags) = run(Some(
            "events:\n  - name: signup\n    kind: product\n    where: src/signup.ts\n    props: [plan]\n  - name: cta_click\n    kind: marketing\n",
        ));
        assert!(diags.is_empty());
        let plan = plan.unwrap();
        assert_eq!(plan.events.len(), 2);
        assert_eq!(plan.events[0].kind, EventKind::Product);
        assert_eq!(plan.events[0].location.as_deref(), Some("src/signup.ts"));
        assert_eq!(plan.events[0].props, vec!["plan"]);
        assert_eq!(plan.events[1].kind, EventKind::Marketing);
        assert!(plan.events[1].location.is_none());
    }

    #[test]
    fn bad_yaml_is_e011() {
        let (plan, diags) = run(Some("events: ["));
        assert!(plan.is_none());
        assert_eq!(codes(&diags), ["E011"]);
        assert_eq!(diags[0].file, "dif/tracking-plan.yaml");
    }

    #[test]
    fn unknown_key_is_e011() {
        let (plan, diags) = run(Some(
            "events:\n  - name: a\n    kind: product\n    owner: x\n",
        ));
        assert!(plan.is_none());
        assert_eq!(codes(&diags), ["E011"]);
    }

    #[test]
    fn bad_kind_is_e011() {
        let (plan, diags) = run(Some("events:\n  - name: a\n    kind: feature\n"));
        assert!(plan.is_none());
        assert_eq!(codes(&diags), ["E011"]);
    }

    #[test]
    fn dollar_name_is_e012() {
        let (plan, diags) = run(Some(
            "events:\n  - name: \"$pageview\"\n    kind: product\n",
        ));
        assert!(plan.is_some());
        assert_eq!(codes(&diags), ["E012"]);
        assert!(diags[0].message.contains("$pageview"));
        assert!(diags[0].help.as_deref().unwrap().contains("$pageview"));
    }

    #[test]
    fn whitespace_name_is_e012() {
        let (plan, diags) = run(Some(
            "events:\n  - name: Signup Completed\n    kind: product\n",
        ));
        assert!(plan.is_some());
        assert_eq!(codes(&diags), ["E012"]);
    }

    #[test]
    fn long_name_is_e012() {
        let yaml = format!(
            "events:\n  - name: {}\n    kind: product\n",
            "a".repeat(129)
        );
        let (plan, diags) = run(Some(&yaml));
        assert!(plan.is_some());
        assert_eq!(codes(&diags), ["E012"]);
    }

    #[test]
    fn duplicate_name_is_e013_once_per_repeat() {
        let (plan, diags) = run(Some(
            "events:\n  - {name: signup, kind: product}\n  - {name: signup, kind: product}\n  - {name: signup, kind: marketing}\n",
        ));
        assert!(plan.is_some());
        assert_eq!(codes(&diags), ["E013", "E013"]);
    }

    #[test]
    fn contains_matches_exactly() {
        let (plan, _) = run(Some("events:\n  - {name: signup, kind: product}\n"));
        let plan = plan.unwrap();
        assert!(plan.contains("signup"));
        assert!(!plan.contains("Signup"));
    }
}

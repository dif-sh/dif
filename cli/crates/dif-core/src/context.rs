//! Codegen for `.dif/context.json` — the agent-facing summary file.
//!
//! Read on session start by the customer's coding agent (Claude Code,
//! Codex, Cursor). Equivalent in spirit to a project's `CLAUDE.md`, but
//! scoped to experiments. Matches the shape rendered in the `context.json`
//! pane of [site/index.html](../../../../site/index.html).
//!
//! Unlike `client.ts`, this file carries a `generated_at` timestamp so agents
//! can tell freshness — it WILL change every build. That's acceptable for a
//! single-line diff; the file lives at `.dif/context.json` (not under
//! `.dif/generated/`) so it's checked in and agents see it.

use crate::{spec::Status, workspace::Workspace};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

/// The full `context.json` payload.
#[derive(Debug, Serialize, Deserialize)]
pub struct AgentContext {
    /// ISO-8601 UTC instant the file was generated.
    pub generated_at: DateTime<Utc>,
    /// One entry per active experiment.
    pub active: Vec<ActiveContext>,
    /// Surface summaries with their most recent learning.
    pub surfaces: Vec<SurfaceContext>,
    /// Project-wide conventions, surfaced so the agent doesn't need to
    /// re-derive them from the config + source.
    pub conventions: Vec<String>,
}

/// Per-experiment summary.
#[derive(Debug, Serialize, Deserialize)]
pub struct ActiveContext {
    /// Experiment id.
    pub id: String,
    /// Surface this experiment runs on.
    pub surface: String,
    /// Variant ids in declared order.
    pub variants: Vec<String>,
    /// Exclusion group, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclusion_group: Option<String>,
    /// Days since the experiment's `created` date.
    pub running_for_days: i64,
}

/// Per-surface summary.
#[derive(Debug, Serialize, Deserialize)]
pub struct SurfaceContext {
    /// Surface id.
    pub name: String,
    /// One-liner summary of the most recent learning. Omitted entirely for
    /// surfaces with no learnings, so the agent sees a clean structure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recent_learning: Option<String>,
}

/// Build the in-memory `AgentContext` from a loaded workspace.
pub fn build(workspace: &Workspace) -> AgentContext {
    build_at(workspace, Utc::now(), Utc::now().date_naive())
}

/// Build with explicit `now` + `today` — pulled out so tests can stay
/// deterministic.
pub fn build_at(workspace: &Workspace, now: DateTime<Utc>, today: NaiveDate) -> AgentContext {
    let active: Vec<ActiveContext> = workspace
        .active
        .iter()
        .filter(|p| matches!(p.spec.status, Status::Active))
        .map(|p| {
            let running_for_days = today
                .signed_duration_since(p.spec.created)
                .num_days()
                .max(0);
            ActiveContext {
                id: p.spec.id.clone(),
                surface: p.spec.surface.clone(),
                variants: p.spec.variants.iter().map(|v| v.id.clone()).collect(),
                exclusion_group: p.spec.exclusion_group.clone(),
                running_for_days,
            }
        })
        .collect();

    let surfaces: Vec<SurfaceContext> = workspace
        .surfaces
        .iter()
        .map(|s| SurfaceContext {
            name: s.surface.id.clone(),
            // Surfaces own their learning order; the most recent is first.
            recent_learning: s.surface.learnings.first().map(|l| l.summary.clone()),
        })
        .collect();

    let conventions = workspace_conventions(workspace);

    AgentContext {
        generated_at: now,
        active,
        surfaces,
        conventions,
    }
}

/// Project-wide conventions surfaced to the agent.
///
/// For v1 these are derived from the config (e.g., `fire_at: render` → "Fire
/// exposure at render, never at assignment."). A future change will let the
/// customer declare arbitrary additional conventions in `.dif/config.yaml`.
fn workspace_conventions(workspace: &Workspace) -> Vec<String> {
    let mut out = Vec::new();
    match workspace.config.exposure.fire_at {
        crate::config::FireAt::Render => {
            out.push("Fire exposure at render, never at assignment.".to_string());
        }
        crate::config::FireAt::Assignment => {
            // validate.rs should refuse this configuration; if we got here
            // anyway, don't lie about the convention.
            out.push(
                "Exposure currently fires at assignment — this is a known correctness bug."
                    .to_string(),
            );
        }
    }
    out
}

/// Serialize and write the file. Lives at `<root>/.dif/context.json`.
pub fn emit(workspace: &Workspace) -> std::io::Result<()> {
    let ctx = build(workspace);
    let json = serde_json::to_string_pretty(&ctx).map_err(std::io::Error::other)?;
    let path = workspace.root.join(".dif").join("context.json");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, json)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::{BucketingConfig, BuildConfig, Config, ExposureConfig, FireAt},
        parse::{parse_experiment_str, ParsedExperiment, ParsedSurface},
        spec::{Learning, Surface},
    };
    use std::path::PathBuf;

    fn empty_config() -> Config {
        Config {
            project: "test".into(),
            default_surface: "home".into(),
            audience_attributes: vec![],
            bucketing: BucketingConfig {
                id: "user_id".into(),
                fallback: "anon_cookie".into(),
            },
            exposure: ExposureConfig {
                sink: "webhook".into(),
                fire_at: FireAt::Render,
            },
            build: BuildConfig::default(),
        }
    }

    fn parse(yaml_body: &str, id: &str) -> ParsedExperiment {
        let source = format!("---\n{yaml_body}\n---\n");
        let mut p = parse_experiment_str(&source).expect("parse");
        p.path = PathBuf::from(format!("experiments/active/{id}.md"));
        p
    }

    const SIMPLE: &str = "id: checkout-cta-v2
status: active
owner: ada@acme.dev
surface: checkout
hypothesis: h
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
metrics:
  primary: m
exclusion_group: checkout-copy
created: 2026-01-01";

    fn make_workspace(exps: Vec<ParsedExperiment>, surfaces: Vec<ParsedSurface>) -> Workspace {
        Workspace {
            root: PathBuf::from("/tmp/test"),
            config: empty_config(),
            active: exps,
            concluded: vec![],
            surfaces,
            call_sites: vec![],
            parse_errors: vec![],
        }
    }

    #[test]
    fn build_emits_active_experiments() {
        let exp = parse(SIMPLE, "checkout-cta-v2");
        let ws = make_workspace(vec![exp], vec![]);
        let now = chrono::TimeZone::with_ymd_and_hms(&Utc, 2026, 1, 8, 0, 0, 0).unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 1, 8).unwrap();
        let ctx = build_at(&ws, now, today);
        assert_eq!(ctx.active.len(), 1);
        let a = &ctx.active[0];
        assert_eq!(a.id, "checkout-cta-v2");
        assert_eq!(a.surface, "checkout");
        assert_eq!(a.variants, vec!["control", "variant_a"]);
        assert_eq!(a.exclusion_group.as_deref(), Some("checkout-copy"));
        assert_eq!(a.running_for_days, 7);
    }

    #[test]
    fn build_emits_surface_recent_learning() {
        let surface = ParsedSurface {
            surface: Surface {
                id: "checkout".into(),
                description: String::new(),
                landmines: vec![],
                learnings: vec![
                    Learning {
                        date: NaiveDate::from_ymd_opt(2026, 5, 28).unwrap(),
                        experiment: "checkout-cta-v2".into(),
                        summary: "lifted conversion".into(),
                    },
                    Learning {
                        date: NaiveDate::from_ymd_opt(2026, 4, 11).unwrap(),
                        experiment: "trust-badges-row".into(),
                        summary: "no effect".into(),
                    },
                ],
            },
            source: String::new(),
            path: PathBuf::from("surfaces/checkout.md"),
        };
        let ws = make_workspace(vec![], vec![surface]);
        let ctx = build(&ws);
        assert_eq!(ctx.surfaces.len(), 1);
        assert_eq!(ctx.surfaces[0].name, "checkout");
        assert_eq!(
            ctx.surfaces[0].recent_learning.as_deref(),
            Some("lifted conversion")
        );
    }

    #[test]
    fn surface_without_learnings_omits_recent() {
        let surface = ParsedSurface {
            surface: Surface {
                id: "pricing".into(),
                description: String::new(),
                landmines: vec![],
                learnings: vec![],
            },
            source: String::new(),
            path: PathBuf::from("surfaces/pricing.md"),
        };
        let ws = make_workspace(vec![], vec![surface]);
        let ctx = build(&ws);
        let json = serde_json::to_string(&ctx).unwrap();
        // skip_serializing_if drops the field when None.
        assert!(!json.contains("recent_learning"));
    }

    #[test]
    fn render_convention_for_render_sink() {
        let ws = make_workspace(vec![], vec![]);
        let ctx = build(&ws);
        assert!(ctx
            .conventions
            .iter()
            .any(|c| c.contains("Fire exposure at render")));
    }
}

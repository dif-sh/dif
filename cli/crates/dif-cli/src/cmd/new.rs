//! `dif new` — draft a new experiment, primed with the surface's recent learnings.
//!
//! The body template includes an HTML comment with up to three recent
//! learnings from the surface's `## Learnings` log. That comment is the
//! structural enforcement of "yesterday's learning is in tomorrow's draft":
//! the agent (or human) drafting the brief sees prior findings before they
//! write anything.

use super::CmdError;
use chrono::{NaiveDate, Utc};
use clap::Args as ClapArgs;
use console::style;
use dif_core::{spec::Variant, ParsedExperiment, ParsedSurface, Workspace};
use std::path::PathBuf;
use std::process::ExitCode;

/// `dif new` flags.
#[derive(ClapArgs, Debug)]
pub struct Args {
    /// Experiment id (kebab-case). Becomes the filename stem.
    pub id: String,

    /// Surface this experiment will run on. Must already exist under `surfaces/`.
    #[arg(long)]
    pub surface: String,

    /// Owner email. Defaults to `git config user.email`.
    #[arg(long)]
    pub owner: Option<String>,

    /// Copy variants + audience from an existing experiment (active or concluded).
    #[arg(long)]
    pub from: Option<String>,
}

/// Entrypoint. See PLAN.md step 11.
pub fn run(args: Args, json: bool) -> Result<ExitCode, CmdError> {
    let cwd = std::env::current_dir()?;
    let workspace = Workspace::load(&cwd)?;

    // 1. Surface must exist (exit 3).
    let surface = match workspace
        .surfaces
        .iter()
        .find(|s| s.surface.id == args.surface)
    {
        Some(s) => s,
        None => {
            report_missing_surface(&args.surface, &workspace, json);
            return Ok(ExitCode::from(3));
        }
    };

    // 2. Experiment id must not already exist (exit 2).
    let conflict = workspace
        .active
        .iter()
        .chain(workspace.concluded.iter())
        .any(|p| p.spec.id == args.id);
    if conflict {
        report_id_conflict(&args.id, json);
        return Ok(ExitCode::from(2));
    }

    // 3. --from source experiment, if any.
    let source_exp: Option<&ParsedExperiment> = match &args.from {
        Some(from_id) => {
            let found = workspace
                .active
                .iter()
                .chain(workspace.concluded.iter())
                .find(|p| &p.spec.id == from_id);
            match found {
                Some(p) => Some(p),
                None => {
                    report_missing_source(from_id, json);
                    return Ok(ExitCode::from(2));
                }
            }
        }
        None => None,
    };

    // 4. Owner.
    let owner = match args.owner {
        Some(o) => o,
        None => match git_user_email() {
            Some(e) => e,
            None => {
                report_no_owner(json);
                return Ok(ExitCode::from(1));
            }
        },
    };

    // 5. Render content.
    let today = Utc::now().date_naive();
    let content = render_experiment(&args.id, &args.surface, &owner, today, source_exp, surface);

    // 6. Write to experiments/active/<id>.md.
    let path = workspace
        .root
        .join("experiments")
        .join("active")
        .join(format!("{}.md", args.id));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, &content)?;

    // 7. Report.
    let learning_count = surface.surface.learnings.len();
    let read_count = learning_count.min(3);
    let surface_rel = workspace
        .root
        .join("surfaces")
        .join(format!("{}.md", args.surface));
    let path_rel = relative(&path, &workspace.root);
    let surface_rel = relative(&surface_rel, &workspace.root);

    if json {
        let payload = serde_json::json!({
            "ok": true,
            "drafted": path_rel.display().to_string(),
            "surface": surface_rel.display().to_string(),
            "prior_learnings_read": read_count,
            "owner": owner,
        });
        println!("{}", serde_json::to_string_pretty(&payload).unwrap());
    } else {
        let arrow = style("→").dim();
        println!("{arrow} reading {}", surface_rel.display());
        println!(
            "  found {} prior learning{}",
            read_count,
            if read_count == 1 { "" } else { "s" }
        );
        println!("{arrow} drafted {}", path_rel.display());
        println!("  status: {}, owner: {}", style("draft").bold(), owner);
    }

    Ok(ExitCode::from(0))
}

// -- rendering ----------------------------------------------------------------

fn render_experiment(
    id: &str,
    surface_id: &str,
    owner: &str,
    today: NaiveDate,
    source: Option<&ParsedExperiment>,
    surface: &ParsedSurface,
) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("id: {id}\n"));
    out.push_str("status: draft\n");
    out.push_str(&format!("owner: {owner}\n"));
    out.push_str(&format!("surface: {surface_id}\n"));
    out.push_str("hypothesis: >\n");
    out.push_str("  (one sentence: what change, expected outcome, for whom)\n");

    // Audience: only emit if the source has one. Empty audience is the
    // default, so omitting the field keeps the new file tidy.
    if let Some(p) = source {
        let yaml = serde_yaml::to_string(&p.spec.audience).unwrap_or_default();
        let trimmed = yaml.trim_end();
        // serde_yaml emits `include: []\nexclude: []` for an empty audience —
        // skip that.
        if trimmed != "include: []\nexclude: []" && !trimmed.is_empty() {
            out.push_str("audience:\n");
            for line in trimmed.lines() {
                out.push_str(&format!("  {line}\n"));
            }
        }
    }

    // Variants.
    out.push_str("variants:\n");
    let variants: Vec<Variant> = match source {
        Some(p) => p.spec.variants.clone(),
        None => default_variants(),
    };
    out.push_str(&render_variants(&variants));

    // Metrics.
    out.push_str("metrics:\n");
    out.push_str("  primary: (the metric this test is moving)\n");

    // Exclusion group, if --from has one.
    if let Some(p) = source {
        if let Some(eg) = &p.spec.exclusion_group {
            out.push_str(&format!("exclusion_group: {eg}\n"));
        }
    }

    out.push_str(&format!("created: {}\n", today.format("%Y-%m-%d")));
    out.push_str("---\n\n");

    // Body.
    out.push_str("## Brief\n\n");
    let learnings_comment = render_recent_learnings(surface_id, surface);
    if !learnings_comment.is_empty() {
        out.push_str(&learnings_comment);
    }
    out.push_str("(Describe what you're testing and why.)\n\n");
    out.push_str("## Rationale\n\n");
    out.push_str(
        "(Why now? What signal points to this? Why this approach over the alternatives?)\n\n",
    );
    out.push_str("## Decision\n\n");
    out.push_str("<!-- drafted by `dif conclude` -->\n");
    out
}

fn default_variants() -> Vec<Variant> {
    vec![
        Variant {
            id: "control".to_string(),
            weight: 50,
            summary: None,
        },
        Variant {
            id: "variant_a".to_string(),
            weight: 50,
            summary: None,
        },
    ]
}

/// Manually render variants so `summary: null` doesn't pollute the file when
/// the field is unset.
fn render_variants(variants: &[Variant]) -> String {
    let mut out = String::new();
    for v in variants {
        out.push_str(&format!("  - id: {}\n", v.id));
        out.push_str(&format!("    weight: {}\n", v.weight));
        if let Some(summary) = &v.summary {
            out.push_str(&format!("    summary: {}\n", yaml_quote(summary)));
        }
    }
    out
}

/// Cheap YAML scalar quoting. Plain strings stay plain; anything with special
/// chars gets single-quoted with internal `'` doubled.
fn yaml_quote(s: &str) -> String {
    let safe = !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ' '))
        && !s.starts_with(' ')
        && !s.ends_with(' ');
    if safe {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "''"))
    }
}

fn render_recent_learnings(surface_id: &str, surface: &ParsedSurface) -> String {
    if surface.surface.learnings.is_empty() {
        return String::new();
    }
    let take = surface.surface.learnings.iter().take(3);
    let mut out = String::new();
    out.push_str("<!--\n");
    out.push_str(&format!("Recent learnings on {surface_id}:\n"));
    for l in take {
        out.push_str(&format!(
            "- {} — {}: {}\n",
            l.date.format("%Y-%m-%d"),
            l.experiment,
            l.summary
        ));
    }
    out.push_str("\nUse these to inform the brief — link to or contradict prior findings.\n");
    out.push_str("-->\n\n");
    out
}

// -- helpers ------------------------------------------------------------------

fn git_user_email() -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["config", "user.email"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn relative(path: &std::path::Path, root: &std::path::Path) -> PathBuf {
    path.strip_prefix(root)
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|_| path.to_path_buf())
}

// -- error reporters ----------------------------------------------------------

fn report_missing_surface(name: &str, workspace: &Workspace, json: bool) {
    if json {
        let available: Vec<String> = workspace
            .surfaces
            .iter()
            .map(|s| s.surface.id.clone())
            .collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ok": false,
                "error": "surface_missing",
                "surface": name,
                "available": available,
            }))
            .unwrap()
        );
        return;
    }
    eprintln!(
        "{} surface `{name}` does not exist",
        style("✗").red().bold()
    );
    if !workspace.surfaces.is_empty() {
        let available: Vec<&str> = workspace
            .surfaces
            .iter()
            .map(|s| s.surface.id.as_str())
            .collect();
        eprintln!("  available surfaces: {}", available.join(", "));
    } else {
        eprintln!("  no surfaces declared yet — create one under `surfaces/`.");
    }
}

fn report_id_conflict(id: &str, json: bool) {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ok": false,
                "error": "id_conflict",
                "id": id,
            }))
            .unwrap()
        );
        return;
    }
    eprintln!(
        "{} experiment `{id}` already exists in this workspace",
        style("✗").red().bold()
    );
    eprintln!("  rename, or `dif conclude {id}` if you're done with it.");
}

fn report_missing_source(from_id: &str, json: bool) {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ok": false,
                "error": "from_missing",
                "from": from_id,
            }))
            .unwrap()
        );
        return;
    }
    eprintln!(
        "{} --from: experiment `{from_id}` not found",
        style("✗").red().bold()
    );
}

fn report_no_owner(json: bool) {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ok": false,
                "error": "no_owner",
            }))
            .unwrap()
        );
        return;
    }
    eprintln!("{} couldn't determine owner", style("✗").red().bold());
    eprintln!("  pass `--owner <email>` or set `git config user.email` and try again.");
}

// -- tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use dif_core::{
        parse::parse_experiment_str,
        spec::{Learning, Surface},
    };

    fn make_surface_with_learnings(id: &str, learnings: Vec<Learning>) -> ParsedSurface {
        ParsedSurface {
            surface: Surface {
                id: id.to_string(),
                description: String::new(),
                landmines: vec![],
                learnings,
            },
            source: String::new(),
            path: PathBuf::from(format!("surfaces/{id}.md")),
        }
    }

    #[test]
    fn default_template_parses_and_round_trips() {
        let surface = make_surface_with_learnings("home", vec![]);
        let today = NaiveDate::from_ymd_opt(2026, 5, 21).unwrap();
        let content = render_experiment("new-exp", "home", "ada@acme.dev", today, None, &surface);
        let parsed = parse_experiment_str(&content).expect("re-parse default template");
        assert_eq!(parsed.spec.id, "new-exp");
        assert_eq!(parsed.spec.status, dif_core::Status::Draft);
        assert_eq!(parsed.spec.owner, "ada@acme.dev");
        assert_eq!(parsed.spec.surface, "home");
        assert_eq!(parsed.spec.variants.len(), 2);
        assert_eq!(parsed.spec.variants[0].id, "control");
        assert_eq!(parsed.spec.variants[1].id, "variant_a");
        assert_eq!(parsed.spec.created, today);
    }

    #[test]
    fn learnings_comment_emitted_when_present() {
        let surface = make_surface_with_learnings(
            "checkout",
            vec![
                Learning {
                    date: NaiveDate::from_ymd_opt(2026, 5, 21).unwrap(),
                    experiment: "checkout-cta-v2".into(),
                    summary: "shipped variant_a +2.1%".into(),
                },
                Learning {
                    date: NaiveDate::from_ymd_opt(2026, 4, 11).unwrap(),
                    experiment: "trust-badges-row".into(),
                    summary: "no effect".into(),
                },
            ],
        );
        let today = NaiveDate::from_ymd_opt(2026, 5, 22).unwrap();
        let content = render_experiment(
            "checkout-cta-v3",
            "checkout",
            "ada@acme.dev",
            today,
            None,
            &surface,
        );
        assert!(content.contains("Recent learnings on checkout:"));
        assert!(content.contains("checkout-cta-v2: shipped variant_a +2.1%"));
        assert!(content.contains("trust-badges-row: no effect"));
        assert!(content.contains("Use these to inform the brief"));
    }

    #[test]
    fn learnings_comment_caps_at_three() {
        let learnings: Vec<Learning> = (0..5)
            .map(|i| Learning {
                date: NaiveDate::from_ymd_opt(2026, 1, 1 + i).unwrap(),
                experiment: format!("exp-{i}"),
                summary: format!("summary {i}"),
            })
            .collect();
        let surface = make_surface_with_learnings("home", learnings);
        let today = NaiveDate::from_ymd_opt(2026, 1, 10).unwrap();
        let content = render_experiment("new", "home", "x@y.com", today, None, &surface);
        assert!(content.contains("exp-0"));
        assert!(content.contains("exp-1"));
        assert!(content.contains("exp-2"));
        assert!(!content.contains("exp-3"));
        assert!(!content.contains("exp-4"));
    }

    #[test]
    fn no_learnings_no_comment() {
        let surface = make_surface_with_learnings("home", vec![]);
        let today = NaiveDate::from_ymd_opt(2026, 5, 21).unwrap();
        let content = render_experiment("x", "home", "x@y.com", today, None, &surface);
        assert!(!content.contains("Recent learnings"));
        assert!(content.contains("## Brief"));
    }

    #[test]
    fn from_copies_variants_and_exclusion_group() {
        let source_yaml = r#"---
id: src
status: active
owner: ada@acme.dev
surface: home
hypothesis: h
variants:
  - id: control
    weight: 70
  - id: a
    weight: 20
  - id: b
    weight: 10
metrics:
  primary: m
exclusion_group: g
created: 2026-01-01
---

## Brief

x
"#;
        let mut source = parse_experiment_str(source_yaml).expect("parse source");
        source.path = PathBuf::from("experiments/active/src.md");
        let surface = make_surface_with_learnings("home", vec![]);
        let today = NaiveDate::from_ymd_opt(2026, 5, 21).unwrap();
        let content = render_experiment(
            "src-v2",
            "home",
            "ada@acme.dev",
            today,
            Some(&source),
            &surface,
        );
        let parsed = parse_experiment_str(&content).expect("re-parse from");
        assert_eq!(parsed.spec.variants.len(), 3);
        assert_eq!(parsed.spec.variants[0].weight, 70);
        assert_eq!(parsed.spec.variants[1].id, "a");
        assert_eq!(parsed.spec.exclusion_group.as_deref(), Some("g"));
    }

    #[test]
    fn yaml_quote_handles_specials() {
        assert_eq!(yaml_quote("plain"), "plain");
        assert_eq!(yaml_quote("with spaces"), "with spaces");
        assert_eq!(yaml_quote("a:b"), "'a:b'");
        assert_eq!(yaml_quote("it's"), "'it''s'");
    }
}

//! `dif conclude` — atomic archive + Decision + surface-log append.
//!
//! Reads the active experiment + its surface, computes every update in memory,
//! then commits to the filesystem in an order that allows best-effort rollback
//! on any failure:
//!
//! 1. Write new experiment content (status flipped, `concluded:` set, Decision
//!    block filled in) to the active path.
//! 2. Rename active → `dif/experiments/concluded/<YYYY-MM>-<id>.md`.
//! 3. Write the updated surface file (new learning prepended under `## Learnings`).
//!
//! Output matches the design's `dif conclude` mockup.

use super::CmdError;
use chrono::{NaiveDate, Utc};
use clap::Args as ClapArgs;
use console::style;
use dif_core::{parse, paths, Workspace};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// `dif conclude` flags.
#[derive(ClapArgs, Debug)]
pub struct Args {
    /// Experiment id to conclude. Must exist under `dif/experiments/active/`.
    pub id: String,

    /// Inline decision text. If omitted, `$EDITOR` is opened on a template.
    #[arg(long)]
    pub decision: Option<String>,

    /// Skip appending a learning line to the surface file. CI-only escape
    /// hatch; rare.
    #[arg(long)]
    pub skip_learning: bool,
}

/// Entrypoint. See PLAN.md step 10.
pub fn run(args: Args, json: bool) -> Result<ExitCode, CmdError> {
    let cwd = std::env::current_dir()?;
    let workspace = Workspace::load(&cwd)?;

    // 1. Locate the experiment + its surface.
    let parsed = workspace
        .active
        .iter()
        .find(|p| p.spec.id == args.id)
        .ok_or(CmdError::Other(
            "experiment not found under dif/experiments/active/",
        ))?;
    let surface = workspace
        .surfaces
        .iter()
        .find(|s| s.surface.id == parsed.spec.surface)
        .ok_or(CmdError::Other(
            "surface for this experiment not found under dif/surfaces/",
        ))?;

    // 2. Get decision text. --decision wins; otherwise $EDITOR; non-empty required.
    let decision = match args.decision {
        Some(d) if !d.trim().is_empty() => d.trim().to_string(),
        Some(_) => return Err(CmdError::Other("--decision is empty")),
        None => prompt_editor(&args.id)?,
    };

    // 3. Compute today + paths.
    let today = Utc::now().date_naive();
    let active_path = parsed.path.clone();
    let concluded_filename = format!("{}-{}.md", today.format("%Y-%m"), parsed.spec.id);
    let concluded_path = workspace
        .root
        .join(paths::EXPERIMENTS_CONCLUDED)
        .join(&concluded_filename);

    // 4. Compute new contents — all in memory before touching disk.
    let new_experiment = build_experiment_content(parsed, &decision, today);
    let new_surface = if args.skip_learning {
        None
    } else {
        let learning = format_learning_line(today, &parsed.spec.id, &decision);
        Some(append_learning_to_surface(&surface.source, &learning))
    };

    // 5. Commit, with best-effort rollback.
    let original_surface = surface.source.clone();
    commit(
        &active_path,
        &concluded_path,
        &new_experiment,
        surface.path.as_path(),
        new_surface.as_deref(),
        &original_surface,
    )?;

    // 6. Report.
    let surface_rel = relative(&surface.path, &workspace.root);
    let concluded_rel = relative(&concluded_path, &workspace.root);
    if json {
        let payload = serde_json::json!({
            "ok": true,
            "moved_to": concluded_rel.display().to_string(),
            "decision_drafted": true,
            "surface_appended": new_surface.is_some(),
            "summary": first_line(&decision),
        });
        println!("{}", serde_json::to_string_pretty(&payload).unwrap());
    } else {
        let arrow = style("→").dim();
        println!("{arrow} moved {}", concluded_rel.display());
        println!("{arrow} drafted {} block", style("## Decision").bold());
        if new_surface.is_some() {
            println!("{arrow} appended to {}", surface_rel.display());
            println!(
                "  {}",
                style(format!("\"{}\"", first_line(&decision))).dim()
            );
        }
    }

    Ok(ExitCode::from(0))
}

// -- commit + rollback --------------------------------------------------------

fn commit(
    active_path: &Path,
    concluded_path: &Path,
    new_experiment: &str,
    surface_path: &Path,
    new_surface: Option<&str>,
    original_surface: &str,
) -> Result<(), CmdError> {
    // Make sure the concluded/ dir exists.
    if let Some(parent) = concluded_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Ordered so the original active file is never mutated until the very
    // last step — a crash or kill at any point leaves it intact. The worst
    // interrupted state is a duplicate id (active + concluded copies), which
    // `dif validate` flags and a `rm` fixes; a half-concluded active file
    // would be silently wrong.

    // Step A: write the concluded copy. If this fails, nothing has changed.
    std::fs::write(concluded_path, new_experiment).map_err(CmdError::Io)?;

    // Step B: surface update. If this fails, remove the concluded copy.
    if let Some(content) = new_surface {
        if let Err(e) = std::fs::write(surface_path, content) {
            let _ = std::fs::remove_file(concluded_path);
            return Err(CmdError::Io(e));
        }
    }

    // Step C: remove the original from active/. If this fails, revert both
    // prior steps.
    if let Err(e) = std::fs::remove_file(active_path) {
        let _ = std::fs::remove_file(concluded_path);
        let _ = std::fs::write(surface_path, original_surface);
        return Err(CmdError::Io(e));
    }

    Ok(())
}

// -- experiment file mutation -------------------------------------------------

fn build_experiment_content(
    parsed: &dif_core::ParsedExperiment,
    decision: &str,
    today: NaiveDate,
) -> String {
    let with_status = update_status(&parsed.source);
    let with_date = update_concluded_date(&with_status, today);
    update_decision_block(&with_date, parsed.body_offset, decision)
}

fn update_status(source: &str) -> String {
    // Replace only an exact `status: active` line. We intentionally avoid
    // matching `status: active # comment` or other variants — the canonical
    // template emits the simple form, and being conservative here means we
    // don't accidentally clobber something we didn't understand.
    let re = regex::Regex::new(r"(?m)^status: active\s*$").expect("static regex");
    re.replace(source, "status: concluded").to_string()
}

fn update_concluded_date(source: &str, today: NaiveDate) -> String {
    let today_str = today.format("%Y-%m-%d").to_string();
    // (a) existing `concluded: null` → fill in.
    let re_null = regex::Regex::new(r"(?m)^concluded:\s*null\s*$").expect("static regex");
    if re_null.is_match(source) {
        return re_null
            .replace(source, format!("concluded: {today_str}").as_str())
            .to_string();
    }
    // (b) already-dated `concluded:` → leave alone (idempotent re-conclude).
    let re_dated =
        regex::Regex::new(r"(?m)^concluded:\s*\d{4}-\d{2}-\d{2}\s*$").expect("static regex");
    if re_dated.is_match(source) {
        return source.to_string();
    }
    // (c) no `concluded:` line → insert before the closing `---` of the
    // frontmatter (the second `---` on its own line).
    insert_into_frontmatter(source, &format!("concluded: {today_str}"))
}

fn insert_into_frontmatter(source: &str, line: &str) -> String {
    // Walk lines after the opening `---\n`, find the next standalone `---`.
    let body = match source.strip_prefix("---\n") {
        Some(b) => b,
        None => return source.to_string(),
    };
    let prefix_len = source.len() - body.len();
    let mut pos = prefix_len;
    for raw_line in body.split_inclusive('\n') {
        let trimmed = raw_line.trim_end_matches('\n').trim_end_matches('\r');
        if trimmed == "---" {
            // Insert `<line>\n` right before this position.
            let mut out = source[..pos].to_string();
            out.push_str(line);
            out.push('\n');
            out.push_str(&source[pos..]);
            return out;
        }
        pos += raw_line.len();
    }
    source.to_string()
}

fn update_decision_block(source: &str, body_offset: usize, decision: &str) -> String {
    let body = parse::parse_body(source, body_offset);
    if let Some(section) = body.decision {
        // Find the end of the heading line so we replace only the section body.
        let bytes = source.as_bytes();
        let heading_end = bytes[section.start..section.end]
            .iter()
            .position(|&b| b == b'\n')
            .map(|i| section.start + i + 1)
            .unwrap_or(section.end);
        let mut out = source[..heading_end].to_string();
        out.push('\n');
        out.push_str(decision.trim());
        out.push('\n');
        // Re-attach anything after the section (next heading or EOF).
        let tail = &source[section.end..];
        if !tail.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(tail);
        out
    } else {
        // No Decision block. Append one to the body.
        let mut out = source.trim_end().to_string();
        out.push_str("\n\n## Decision\n\n");
        out.push_str(decision.trim());
        out.push('\n');
        out
    }
}

// -- surface mutation ---------------------------------------------------------

fn append_learning_to_surface(source: &str, learning_line: &str) -> String {
    let Some(start) = find_learnings_heading(source) else {
        // No `## Learnings` section — create one at the end.
        let mut out = source.trim_end().to_string();
        out.push_str("\n\n## Learnings\n\n");
        out.push_str(learning_line);
        out.push('\n');
        return out;
    };

    // Find the end of the section: next `## ` heading or EOF.
    let after_heading = source[start..]
        .find('\n')
        .map(|i| start + i + 1)
        .unwrap_or(source.len());
    let section_end = source[after_heading..]
        .find("\n## ")
        .map(|i| after_heading + i + 1)
        .unwrap_or(source.len());

    // Strip parenthetical placeholder hint lines (e.g. the `(One line per concluded test...)`
    // stub `dif init` writes). They're useful before the first real learning,
    // but become noise once we have one.
    let section_body = &source[after_heading..section_end];
    let cleaned: String = section_body
        .lines()
        .filter(|l| !is_placeholder_hint(l))
        .collect::<Vec<_>>()
        .join("\n");
    let cleaned_trimmed = cleaned.trim();

    // Rebuild: heading line + blank + new bullet + (rest of cleaned section, if any)
    // + remainder of the file.
    let mut out = source[..after_heading].to_string();
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push('\n');
    out.push_str(learning_line);
    out.push('\n');
    if !cleaned_trimmed.is_empty() {
        out.push_str(cleaned_trimmed);
        out.push('\n');
    }
    // Preserve original spacing into the next section: at least one blank line
    // before a following `## ` heading.
    if section_end < source.len() {
        if !out.ends_with('\n') {
            out.push('\n');
        }
        if !out.ends_with("\n\n") {
            out.push('\n');
        }
        out.push_str(&source[section_end..]);
    }
    out
}

/// A "placeholder hint" is the kind of parenthetical line `dif init` writes
/// into stub sections — e.g. `(One line per concluded test, appended automatically by `dif conclude`.)`.
/// They're guidance for empty sections; once a real bullet lands, the hint is noise.
fn is_placeholder_hint(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with('(') && trimmed.ends_with(')') && trimmed.len() > 2
}

fn find_learnings_heading(source: &str) -> Option<usize> {
    // Match `^## Learnings$` (with optional whitespace) on its own line.
    let re = regex::Regex::new(r"(?m)^## Learnings\s*$").expect("static regex");
    re.find(source).map(|m| m.start())
}

fn format_learning_line(date: NaiveDate, experiment_id: &str, decision: &str) -> String {
    let summary = first_line(decision);
    format!("- {} — {experiment_id}: {summary}", date.format("%Y-%m-%d"))
}

fn first_line(s: &str) -> String {
    s.trim()
        .lines()
        .next()
        .unwrap_or("(no summary)")
        .trim()
        .to_string()
}

// -- editor invocation --------------------------------------------------------

fn prompt_editor(experiment_id: &str) -> Result<String, CmdError> {
    let editor = std::env::var("EDITOR")
        .or_else(|_| std::env::var("VISUAL"))
        .unwrap_or_else(|_| "vi".to_string());
    // PID + monotonic nanos make the name unique so two concurrent
    // `dif conclude` runs (same experiment or same machine) can't share a
    // draft file.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!(
        "dif-conclude-{experiment_id}-{}-{nonce}.md",
        std::process::id()
    ));
    let template = format!(
        "# Decision for {experiment_id}\n\
         #\n\
         # Write the decision below. Lines starting with `#` are stripped.\n\
         # The first non-empty line becomes the surface log summary.\n\
         \n"
    );
    std::fs::write(&tmp, template)?;

    let status = std::process::Command::new(&editor)
        .arg(&tmp)
        .status()
        .map_err(|_| CmdError::Other("failed to spawn $EDITOR"))?;
    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(CmdError::Other("$EDITOR exited non-zero"));
    }

    let content = std::fs::read_to_string(&tmp)?;
    let _ = std::fs::remove_file(&tmp);

    let cleaned = content
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if cleaned.is_empty() {
        return Err(CmdError::Other("decision is empty — aborting"));
    }
    Ok(cleaned)
}

fn relative(path: &Path, root: &Path) -> PathBuf {
    path.strip_prefix(root)
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|_| path.to_path_buf())
}

// -- tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_EXP: &str = r#"---
id: checkout-cta-v2
status: active
owner: ada@acme.dev
surface: home
hypothesis: h
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
metrics:
  primary: m
created: 2026-01-01
---

## Brief

The brief.

## Decision

<!-- drafted by `dif conclude` -->
"#;

    const SAMPLE_SURFACE: &str = r#"# Surface: home

A surface.

## Known landmines

- watch out.

## Learnings

- 2026-04-11 — older-test: minor effect.
- 2026-03-02 — even-older: no effect.
"#;

    #[test]
    fn status_flipped_to_concluded() {
        let out = update_status(SAMPLE_EXP);
        assert!(out.contains("status: concluded"));
        assert!(!out.contains("status: active"));
    }

    #[test]
    fn concluded_date_inserted_before_closing_dashes() {
        let today = NaiveDate::from_ymd_opt(2026, 5, 21).unwrap();
        let out = update_concluded_date(SAMPLE_EXP, today);
        assert!(out.contains("concluded: 2026-05-21"));
        // Inserted before the closing ---, not after.
        let idx_concluded = out.find("concluded: 2026-05-21").unwrap();
        let idx_close = out.find("\n---\n\n## Brief").unwrap();
        assert!(idx_concluded < idx_close);
    }

    #[test]
    fn concluded_null_is_replaced() {
        let src = SAMPLE_EXP.replace(
            "created: 2026-01-01\n---",
            "created: 2026-01-01\nconcluded: null\n---",
        );
        let today = NaiveDate::from_ymd_opt(2026, 5, 21).unwrap();
        let out = update_concluded_date(&src, today);
        assert!(out.contains("concluded: 2026-05-21"));
        assert!(!out.contains("concluded: null"));
    }

    #[test]
    fn already_dated_concluded_is_left_alone() {
        let src = SAMPLE_EXP.replace(
            "created: 2026-01-01\n---",
            "created: 2026-01-01\nconcluded: 2025-12-31\n---",
        );
        let today = NaiveDate::from_ymd_opt(2026, 5, 21).unwrap();
        let out = update_concluded_date(&src, today);
        assert!(out.contains("concluded: 2025-12-31"));
        assert!(!out.contains("concluded: 2026-05-21"));
    }

    #[test]
    fn decision_block_body_replaced_heading_preserved() {
        let parsed = parse::parse_experiment_str(SAMPLE_EXP).expect("parse");
        let out = update_decision_block(
            &parsed.source,
            parsed.body_offset,
            "Shipped variant_a. +2.1% on returning visitors.",
        );
        assert!(out.contains("## Decision"));
        assert!(out.contains("Shipped variant_a."));
        assert!(!out.contains("drafted by `dif conclude`"));
        // Brief untouched.
        assert!(out.contains("The brief."));
    }

    #[test]
    fn decision_block_inserted_when_missing() {
        let src = SAMPLE_EXP.replace("## Decision\n\n<!-- drafted by `dif conclude` -->\n", "");
        let parsed = parse::parse_experiment_str(&src).expect("parse");
        let out = update_decision_block(&parsed.source, parsed.body_offset, "Shipped.");
        assert!(out.contains("## Decision"));
        assert!(out.contains("Shipped."));
    }

    #[test]
    fn learning_prepended_under_heading() {
        let learning = "- 2026-05-21 — checkout-cta-v2: shipped.";
        let out = append_learning_to_surface(SAMPLE_SURFACE, learning);
        // Newest first: our new line should appear before "2026-04-11".
        let new_idx = out.find("2026-05-21").expect("new learning");
        let old_idx = out.find("2026-04-11").expect("old learning");
        assert!(
            new_idx < old_idx,
            "new learning must appear above older ones"
        );
        // Older learnings still present.
        assert!(out.contains("2026-03-02 — even-older"));
    }

    #[test]
    fn learning_strips_placeholder_hint() {
        // `dif init` writes a parenthetical stub under `## Learnings`. The
        // first real conclude should replace it, not coexist with it.
        let src = "# Surface: home\n\n\
                   description.\n\n\
                   ## Known landmines\n\n\
                   (none yet.)\n\n\
                   ## Learnings\n\n\
                   (One line per concluded test, appended automatically by `dif conclude`.)\n";
        let out = append_learning_to_surface(src, "- 2026-05-21 — exp: shipped.");
        assert!(out.contains("- 2026-05-21 — exp: shipped."));
        assert!(
            !out.contains("(One line per concluded test"),
            "placeholder should be stripped:\n{out}"
        );
    }

    #[test]
    fn learning_creates_section_when_missing() {
        let src = "# Surface: x\n\nDescription.\n\n## Known landmines\n\n- one.\n";
        let learning = "- 2026-05-21 — exp: shipped.";
        let out = append_learning_to_surface(src, learning);
        assert!(out.contains("## Learnings"));
        assert!(out.contains("2026-05-21 — exp: shipped."));
    }

    #[test]
    fn learning_line_format() {
        let line = format_learning_line(
            NaiveDate::from_ymd_opt(2026, 5, 21).unwrap(),
            "checkout-cta-v2",
            "Shipped variant_a. +2.1% on returning visitors.\n\nMore detail here.",
        );
        // First line of decision becomes the summary; multi-line content trimmed.
        assert_eq!(
            line,
            "- 2026-05-21 — checkout-cta-v2: Shipped variant_a. +2.1% on returning visitors."
        );
    }

    #[test]
    fn full_experiment_content_round_trips_through_parser() {
        // After conclude, the new file must still parse as a valid Experiment
        // with status=concluded and concluded set.
        let parsed = parse::parse_experiment_str(SAMPLE_EXP).expect("parse");
        let today = NaiveDate::from_ymd_opt(2026, 5, 21).unwrap();
        let new_content = build_experiment_content(&parsed, "Shipped variant_a.", today);
        let reparsed = parse::parse_experiment_str(&new_content).expect("re-parse concluded file");
        assert_eq!(reparsed.spec.status, dif_core::Status::Concluded);
        assert_eq!(reparsed.spec.concluded, Some(today));
        // Body Decision block contains the new text.
        let body = parse::parse_body(&reparsed.source, reparsed.body_offset);
        let decision = body.decision.expect("decision section");
        assert!(decision.content.contains("Shipped variant_a."));
    }
}

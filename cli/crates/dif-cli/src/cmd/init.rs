//! `dif init` — scaffold the convention in the current directory.
//!
//! Idempotent under `--force`; refuses to clobber otherwise. The full layout
//! is the brief's "four directories, no database, no dashboard" tree:
//!
//! ```text
//! experiments/active/
//! experiments/concluded/
//! surfaces/<default-surface>.md
//! .dif/config.yaml
//! .dif/.gitignore
//! .dif/generated/         (gitignored)
//! ```

use super::CmdError;
use clap::Args as ClapArgs;
use console::style;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// `dif init` flags.
#[derive(ClapArgs, Debug)]
pub struct Args {
    /// Name of the default surface to create. Defaults to `home`.
    #[arg(long)]
    pub surface: Option<String>,

    /// Overwrite existing files. Off by default — refuses to clobber.
    #[arg(long)]
    pub force: bool,
}

/// Entrypoint. See PLAN.md step 3.
pub fn run(args: Args, json: bool) -> Result<ExitCode, CmdError> {
    let cwd = std::env::current_dir()?;
    let surface = args.surface.as_deref().unwrap_or("home").to_string();
    let project = cwd
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("project")
        .to_string();

    let dirs = [
        cwd.join("experiments").join("active"),
        cwd.join("experiments").join("concluded"),
        cwd.join("surfaces"),
        cwd.join(".dif").join("generated"),
    ];
    let files: Vec<(PathBuf, String)> = vec![
        (
            cwd.join(".dif").join("config.yaml"),
            default_config_yaml(&project, &surface),
        ),
        (
            cwd.join(".dif").join(".gitignore"),
            "generated/\n".to_string(),
        ),
        (
            cwd.join("surfaces").join(format!("{surface}.md")),
            default_surface_md(&surface),
        ),
    ];

    if !args.force {
        let collisions: Vec<&Path> = files
            .iter()
            .filter(|(p, _)| p.exists())
            .map(|(p, _)| p.as_path())
            .collect();
        if !collisions.is_empty() {
            report_collisions(&collisions, json);
            return Ok(ExitCode::from(2));
        }
    }

    for dir in &dirs {
        std::fs::create_dir_all(dir)?;
    }
    for (path, content) in &files {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, content)?;
    }

    report_success(&surface, json);
    Ok(ExitCode::from(0))
}

fn report_collisions(paths: &[&Path], json: bool) {
    if json {
        let payload = serde_json::json!({
            "ok": false,
            "error": "collision",
            "files": paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
        });
        println!("{}", serde_json::to_string_pretty(&payload).unwrap());
        return;
    }
    eprintln!(
        "{} refusing to clobber existing files:",
        style("✗").red().bold()
    );
    for path in paths {
        eprintln!("    {}", path.display());
    }
    eprintln!();
    eprintln!("re-run with {} to overwrite.", style("--force").bold());
}

fn report_success(surface: &str, json: bool) {
    if json {
        let payload = serde_json::json!({
            "ok": true,
            "created": [
                "experiments/active",
                "experiments/concluded",
                "surfaces",
                ".dif/generated",
                ".dif/config.yaml",
                ".dif/.gitignore",
                format!("surfaces/{surface}.md"),
            ],
        });
        println!("{}", serde_json::to_string_pretty(&payload).unwrap());
        return;
    }
    let check = style("✓").green().bold();
    println!("{check} created experiments/{{active,concluded}}");
    println!("{check} created surfaces/");
    println!("{check} wrote .dif/config.yaml");
    println!("{check} wrote .dif/.gitignore");
    println!("{check} wrote surfaces/{surface}.md");
}

/// Render the default `config.yaml` as a string with helpful inline comments.
///
/// We do not serialize from the `Config` struct because serde_yaml strips
/// comments, and the comments are the difference between a config file that
/// teaches a first-time user and one that confuses them.
fn default_config_yaml(project: &str, surface: &str) -> String {
    format!(
        "# dif.sh project config. Checked in. Edit by hand or re-run `dif init`.

project: {project}
default_surface: {surface}

# Audience attribute schema. The audience predicate language is closed over
# this set — anything not declared here is a validation error. Add what your
# event system already knows about.
audience_attributes: []

# How users are bucketed.
bucketing:
  id: user_id
  fallback: anon_cookie

# Where exposure events go. Supported sinks: webhook, segment, amplitude, mixpanel.
exposure:
  sink: webhook
  fire_at: render   # never at assignment.

build:
  out: .dif/generated
  fail_on: [conflict, orphan_ref, missing_owner]
"
    )
}

/// Render the stub surface markdown for a freshly-created surface.
fn default_surface_md(surface: &str) -> String {
    format!(
        "# Surface: {surface}

(Describe this surface in a sentence or two. Where is it in the app?
Who sees it? Anything an agent should know before drafting an
experiment for it?)

## Known landmines

(Vendor DOM you can't touch, regulated regions, race conditions —
anything that's bitten a previous test on this surface. One bullet per.)

## Learnings

(One line per concluded test, appended automatically by `dif conclude`.)
"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use dif_core::config::Config;
    use dif_core::parse::parse_surface_str;

    #[test]
    fn emitted_config_parses_as_config() {
        let yaml = default_config_yaml("acme-shop", "home");
        let config: Config = serde_yaml::from_str(&yaml).expect("config parses");
        assert_eq!(config.project, "acme-shop");
        assert_eq!(config.default_surface, "home");
        assert_eq!(config.bucketing.id, "user_id");
        assert_eq!(config.bucketing.fallback, "anon_cookie");
        assert_eq!(config.exposure.sink, "webhook");
        assert!(config.audience_attributes.is_empty());
    }

    #[test]
    fn emitted_surface_stub_parses_as_surface() {
        let md = default_surface_md("checkout");
        let surface = parse_surface_str(&md, "checkout").expect("surface parses");
        assert_eq!(surface.id, "checkout");
        // The stub has zero real learnings (the parenthetical hint is not a
        // bullet, so the parser ignores it).
        assert!(surface.learnings.is_empty());
    }
}

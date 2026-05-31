//! `dif scaffold-audiences` — pull in the starter audience resolvers for an
//! existing project.
//!
//! Idempotent. Creates `audiences/` if missing, writes the default `locale.ts`
//! and `device_type.ts` only when they do not already exist. Never touches
//! `.dif/config.yaml` (that file may contain user-authored content; we print
//! the YAML snippet the user should paste in instead). This is the safe path
//! `dif init` cannot take for an existing workspace.

use super::CmdError;
use super::init::{DEFAULT_DEVICE_TYPE_TS, DEFAULT_LOCALE_TS};
use clap::Args as ClapArgs;
use console::style;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// `dif scaffold-audiences` flags.
#[derive(ClapArgs, Debug)]
pub struct Args {
    /// Overwrite existing audience files. Off by default — silently skips
    /// files that already exist so a user's customizations survive.
    #[arg(long)]
    pub force: bool,
}

struct Outcome {
    path: PathBuf,
    wrote: bool,
}

/// Entrypoint.
pub fn run(args: Args, json: bool) -> Result<ExitCode, CmdError> {
    let cwd = std::env::current_dir()?;
    scaffold(&cwd, args.force, json)
}

/// Test-friendly inner that takes an explicit cwd so the run-side
/// `current_dir()` side effect can be sidestepped.
fn scaffold(cwd: &Path, force: bool, json: bool) -> Result<ExitCode, CmdError> {
    let audiences_dir = cwd.join("audiences");
    std::fs::create_dir_all(&audiences_dir)?;

    let defaults: Vec<(PathBuf, &str)> = vec![
        (audiences_dir.join("locale.ts"), DEFAULT_LOCALE_TS),
        (audiences_dir.join("device_type.ts"), DEFAULT_DEVICE_TYPE_TS),
    ];

    let mut outcomes = Vec::with_capacity(defaults.len());
    for (path, contents) in &defaults {
        let exists = path.exists();
        let wrote = !exists || force;
        if wrote {
            std::fs::write(path, contents)?;
        }
        outcomes.push(Outcome {
            path: path.clone(),
            wrote,
        });
    }

    report(cwd, &outcomes, json);
    Ok(ExitCode::from(0))
}

fn report(cwd: &Path, outcomes: &[Outcome], json: bool) {
    if json {
        let payload = serde_json::json!({
            "ok": true,
            "audiences": outcomes
                .iter()
                .map(|o| serde_json::json!({
                    "path": rel(cwd, &o.path).display().to_string(),
                    "wrote": o.wrote,
                }))
                .collect::<Vec<_>>(),
            "config_yaml_hint": CONFIG_HINT,
        });
        println!("{}", serde_json::to_string_pretty(&payload).unwrap());
        return;
    }
    let check = style("✓").green().bold();
    let dot = style("·").dim();
    for o in outcomes {
        let (mark, suffix) = if o.wrote {
            (check.to_string(), "wrote")
        } else {
            (dot.to_string(), "kept")
        };
        println!("{mark} {suffix} {}", rel(cwd, &o.path).display());
    }
    println!();
    println!(
        "{}",
        style("Next: add these to .dif/config.yaml under audience_attributes (skip any you already declared):").dim()
    );
    println!("{CONFIG_HINT}");
}

fn rel(base: &Path, path: &Path) -> PathBuf {
    path.strip_prefix(base)
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|_| path.to_path_buf())
}

const CONFIG_HINT: &str = "  - name: locale
    type: string
  - name: device_type
    type: enum
    values: [mobile, tablet, desktop]";

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn writes_defaults_when_missing() {
        let tmp = TempDir::new().unwrap();
        scaffold(tmp.path(), false, true).expect("scaffold");

        let locale = tmp.path().join("audiences/locale.ts");
        let device = tmp.path().join("audiences/device_type.ts");
        assert!(locale.exists());
        assert!(device.exists());
        assert!(fs::read_to_string(&locale)
            .unwrap()
            .contains("navigator.language"));
    }

    #[test]
    fn skips_existing_files_without_force() {
        let tmp = TempDir::new().unwrap();
        let audiences_dir = tmp.path().join("audiences");
        fs::create_dir_all(&audiences_dir).unwrap();
        let custom = "// user-authored\nexport default () => null;\n";
        fs::write(audiences_dir.join("locale.ts"), custom).unwrap();

        scaffold(tmp.path(), false, true).expect("scaffold");

        assert_eq!(
            fs::read_to_string(audiences_dir.join("locale.ts")).unwrap(),
            custom,
            "must preserve user-authored content"
        );
        assert!(audiences_dir.join("device_type.ts").exists());
    }

    #[test]
    fn overwrites_with_force() {
        let tmp = TempDir::new().unwrap();
        let audiences_dir = tmp.path().join("audiences");
        fs::create_dir_all(&audiences_dir).unwrap();
        fs::write(audiences_dir.join("locale.ts"), "old").unwrap();

        scaffold(tmp.path(), true, true).expect("scaffold");

        assert!(fs::read_to_string(audiences_dir.join("locale.ts"))
            .unwrap()
            .contains("navigator.language"));
    }
}

//! `dif build` — validate, then compile.
//!
//! Runs the validation pipeline first; any error aborts before codegen
//! touches the filesystem. On success, writes the typed TypeScript client
//! and the agent context.json. Output matches the `dif build` mockup in the
//! site's CLI section.

use super::CmdError;
use clap::Args as ClapArgs;
use console::style;
use dif_core::{codegen, context, paths, spec::Status, validate, Workspace};
use std::path::PathBuf;
use std::process::ExitCode;

/// `dif build` flags.
#[derive(ClapArgs, Debug)]
pub struct Args {
    /// Override the output directory. Default: workspace `config.build.out`.
    /// Relative paths are resolved against the workspace root.
    #[arg(long)]
    pub out: Option<PathBuf>,
}

/// Entrypoint. See PLAN.md step 7.
pub fn run(args: Args, json: bool) -> Result<ExitCode, CmdError> {
    let cwd = std::env::current_dir()?;
    let mut workspace = Workspace::load(&cwd)?;
    workspace.scan_call_sites()?;

    let report = validate::run(&workspace);
    if !report.is_clean() {
        report_validation_failure(&report, json);
        return Ok(ExitCode::from(1));
    }

    let out_dir = args
        .out
        .map(|p| {
            if p.is_absolute() {
                p
            } else {
                workspace.root.join(p)
            }
        })
        .unwrap_or_else(|| workspace.root.join(&workspace.config.build.out));

    codegen::emit_client(&workspace, &out_dir)?;
    codegen::emit_audiences(&workspace, &out_dir)?;
    codegen::emit_events(&workspace, &out_dir)?;
    context::emit(&workspace)?;

    let active_count = workspace
        .active
        .iter()
        .filter(|p| matches!(p.spec.status, Status::Active))
        .count();
    let client_path = out_dir.join("client.ts");
    let audiences_path = out_dir.join("audiences.ts");
    let events_path = out_dir.join("events.ts");
    let context_path = workspace.root.join(paths::CONTEXT_FILE);

    if json {
        let payload = serde_json::json!({
            "ok": true,
            "active": active_count,
            "client": client_path.display().to_string(),
            "audiences": audiences_path.display().to_string(),
            "events": events_path.display().to_string(),
            "context": context_path.display().to_string(),
            "warnings": report.warnings,
        });
        println!("{}", serde_json::to_string_pretty(&payload).unwrap());
    } else {
        let check = style("✓").green().bold();
        println!("{check} validated {active_count} active experiment(s)");
        println!(
            "{check} typed client → {}",
            relative_to_cwd(&client_path).display()
        );
        println!(
            "{check} audiences   → {}",
            relative_to_cwd(&audiences_path).display()
        );
        println!(
            "{check} events      → {}",
            relative_to_cwd(&events_path).display()
        );
        println!(
            "{check} context     → {}",
            relative_to_cwd(&context_path).display()
        );
        for warn in &report.warnings {
            let mark = style("⚠").yellow().bold();
            eprintln!(
                "{mark} {} {}: {}",
                style(&warn.code).dim(),
                warn.file,
                warn.message,
            );
            if let Some(help) = &warn.help {
                eprintln!("  {} {}", style("help:").bold(), help);
            }
        }
    }
    Ok(ExitCode::from(0))
}

fn report_validation_failure(report: &dif_core::Report, json: bool) {
    if json {
        let payload = serde_json::json!({
            "ok": false,
            "errors": report.errors,
            "warnings": report.warnings,
        });
        println!("{}", serde_json::to_string_pretty(&payload).unwrap());
        return;
    }
    for err in &report.errors {
        eprintln!(
            "{} {} {}:{}:{}: {}",
            style("error").red().bold(),
            style(&err.code).dim(),
            err.file,
            err.line,
            err.column,
            err.message,
        );
        if let Some(help) = &err.help {
            eprintln!("  {} {}", style("help:").bold(), help);
        }
    }
    eprintln!();
    eprintln!(
        "{} build refused: {} error(s)",
        style("✗").red().bold(),
        report.errors.len()
    );
    eprintln!("  fix the above and re-run, or run `dif validate` to recheck.");
}

fn relative_to_cwd(path: &std::path::Path) -> PathBuf {
    let cwd = match std::env::current_dir() {
        Ok(c) => c,
        Err(_) => return path.to_path_buf(),
    };
    path.strip_prefix(&cwd)
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|_| path.to_path_buf())
}

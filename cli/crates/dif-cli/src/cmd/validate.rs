//! `dif validate` — every check, collected, exit non-zero on any error.

use super::CmdError;
use clap::Args as ClapArgs;
use console::style;
use dif_core::{validate, Report, Workspace};
use std::process::ExitCode;

/// `dif validate` flags.
#[derive(ClapArgs, Debug)]
pub struct Args {
    /// Reserved for editor integrations that want fast schema-only feedback.
    /// Currently runs the full suite either way; the flag exists so we don't
    /// break callers when the fast path lands.
    #[arg(long)]
    pub schema_only: bool,
}

/// Entrypoint. See PLAN.md step 4.
pub fn run(_args: Args, json: bool) -> Result<ExitCode, CmdError> {
    let cwd = std::env::current_dir()?;
    let mut workspace = Workspace::load(&cwd)?;
    workspace.scan_call_sites()?;
    let report = validate::run(&workspace);

    if json {
        print_json(&report);
    } else {
        print_pretty(&report);
    }

    if report.is_clean() {
        Ok(ExitCode::from(0))
    } else {
        Ok(ExitCode::from(1))
    }
}

fn print_json(report: &Report) {
    let payload = serde_json::json!({
        "ok": report.is_clean(),
        "errors": report.errors,
        "warnings": report.warnings,
    });
    println!("{}", serde_json::to_string_pretty(&payload).unwrap());
}

fn print_pretty(report: &Report) {
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
    for warn in &report.warnings {
        eprintln!(
            "{} {} {}:{}:{}: {}",
            style("warning").yellow().bold(),
            style(&warn.code).dim(),
            warn.file,
            warn.line,
            warn.column,
            warn.message,
        );
        if let Some(help) = &warn.help {
            eprintln!("  {} {}", style("help:").bold(), help);
        }
    }

    if report.is_clean() && report.warnings.is_empty() {
        let check = style("✓").green().bold();
        println!("{check} all checks passed");
    } else if report.is_clean() {
        let warn = style("⚠").yellow().bold();
        eprintln!();
        eprintln!("{warn} {} warning(s)", report.warnings.len());
    } else {
        let mark = style("✗").red().bold();
        eprintln!();
        eprintln!(
            "{mark} {} error(s), {} warning(s)",
            report.errors.len(),
            report.warnings.len()
        );
    }
}

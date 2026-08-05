//! `dif` — the CLI entrypoint.
//!
//! A handful of verbs, no plugins, no config wizard. Every command dispatches
//! into `dif-core`; this file is only here to translate flags into function
//! calls and pretty-print the results.

use clap::{Parser, Subcommand};
use console::style;
use std::process::ExitCode;

mod cmd;

/// The dif.sh CLI — experiments live in the repo.
#[derive(Parser, Debug)]
#[command(name = "dif", version, about, long_about = None)]
struct Cli {
    /// Force machine-readable JSON output where supported.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Scaffold the dif.sh convention in the current directory.
    Init(cmd::init::Args),
    /// Connect the workspace to dif.sh Cloud with a publishable key.
    Connect(cmd::connect::Args),
    /// Draft a new experiment, informed by the surface's prior learnings.
    New(cmd::new::Args),
    /// Check the workspace: schema, owners, surface refs, exclusion graph.
    Validate(cmd::validate::Args),
    /// Compile active experiments into a typed TS client + context.json.
    Build(cmd::build::Args),
    /// Trace the assignment chain for a user and emit a preview URL.
    Qa(cmd::qa::Args),
    /// Move an experiment to concluded/, draft Decision, append to surface log.
    Conclude(cmd::conclude::Args),
    /// Idempotently scaffold the starter audience resolvers (locale, device_type).
    ScaffoldAudiences(cmd::scaffold_audiences::Args),
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let json = cli.json;
    let result = match cli.command {
        Command::Init(args) => cmd::init::run(args, json),
        Command::Connect(args) => cmd::connect::run(args, json),
        Command::New(args) => cmd::new::run(args, json),
        Command::Validate(args) => cmd::validate::run(args, json),
        Command::Build(args) => cmd::build::run(args, json),
        Command::Qa(args) => cmd::qa::run(args, json),
        Command::Conclude(args) => cmd::conclude::run(args, json),
        Command::ScaffoldAudiences(args) => cmd::scaffold_audiences::run(args, json),
    };

    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}");
            // Special-case "no workspace here" — the single most common way a
            // fresh clone hits an error — with a hint pointing at the fix,
            // matching the same hint `dif connect` gives (see connect.rs).
            let no_workspace = matches!(
                &e,
                cmd::CmdError::Workspace(dif_core::workspace::WorkspaceError::NotFound(_))
            );
            if no_workspace {
                eprintln!(
                    "  run {} to scaffold a workspace here",
                    style("dif init").bold()
                );
            }
            if json {
                let error_field = if no_workspace {
                    "no_workspace".to_string()
                } else {
                    e.to_string()
                };
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "ok": false,
                        "error": error_field,
                    }))
                    .unwrap()
                );
            }
            ExitCode::from(1)
        }
    }
}

//! `dif` — the CLI entrypoint.
//!
//! Six verbs, no plugins, no config wizard. Every command dispatches into
//! `dif-core`; this file is only here to translate flags into function
//! calls and pretty-print the results.

use clap::{Parser, Subcommand};
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
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Init(args) => cmd::init::run(args, cli.json),
        Command::New(args) => cmd::new::run(args, cli.json),
        Command::Validate(args) => cmd::validate::run(args, cli.json),
        Command::Build(args) => cmd::build::run(args, cli.json),
        Command::Qa(args) => cmd::qa::run(args, cli.json),
        Command::Conclude(args) => cmd::conclude::run(args, cli.json),
    };

    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(1)
        }
    }
}

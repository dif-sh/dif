//! `dif` — the CLI entrypoint.
//!
//! A handful of verbs, no plugins, no config wizard. Every command dispatches
//! into `dif-core`; this file is only here to translate flags into function
//! calls and pretty-print the results.

use clap::{Parser, Subcommand};
use console::style;
use std::process::ExitCode;

mod cloud;
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
    /// Connect the workspace to dif analytics.
    Connect(cmd::connect::Args),
    /// Sign in to dif analytics. Show or end the login.
    Auth(cmd::auth::Args),
    /// Set up and check dif site analytics.
    Site(cmd::site::Args),
    /// List the events dif analytics has seen.
    Events(cmd::events::Args),
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
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(e) => {
            let hint = update_hint(&e);
            let _ = e.print();
            if let Some(hint) = hint {
                eprintln!("\n{hint}");
            }
            return ExitCode::from(e.exit_code() as u8);
        }
    };
    let json = cli.json;
    let result = match cli.command {
        Command::Init(args) => cmd::init::run(args, json),
        Command::Connect(args) => cmd::connect::run(args, json),
        Command::Auth(args) => cmd::auth::run(args, json),
        Command::Site(args) => cmd::site::run(args, json),
        Command::Events(args) => cmd::events::run(args, json),
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

/// The docs can describe flags that an older CLI does not know.
fn update_hint(e: &clap::Error) -> Option<String> {
    use clap::error::ErrorKind::{InvalidSubcommand, UnknownArgument};
    matches!(e.kind(), UnknownArgument | InvalidSubcommand).then(|| {
        format!(
            "This is dif {}. If the docs show this option, update the CLI:\n  npm install -g @dif.sh/cli@latest",
            env!("CARGO_PKG_VERSION")
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_err(args: &[&str]) -> clap::Error {
        Cli::try_parse_from(args).unwrap_err()
    }

    #[test]
    fn unknown_flag_suggests_an_update() {
        let hint = update_hint(&parse_err(&["dif", "init", "--made-up"])).unwrap();
        assert!(hint.contains(env!("CARGO_PKG_VERSION")), "{hint}");
        assert!(hint.contains("npm install -g @dif.sh/cli@latest"), "{hint}");
    }

    #[test]
    fn unknown_verb_suggests_an_update() {
        assert!(update_hint(&parse_err(&["dif", "made-up"])).is_some());
    }

    #[test]
    fn other_usage_errors_get_no_update_hint() {
        assert!(update_hint(&parse_err(&["dif", "new"])).is_none());
    }
}

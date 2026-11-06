//! The interactive face of `dif init`: clack-style prompts on stderr
//! and a paced, check-marked summary. Used only on a real terminal;
//! `--json` and piped runs keep the plain output in [`super`].

use super::choices::{events_mode_for, Framework, Product};
use super::{validate_publishable_key, AgentSelection, Args, Summary, CURSOR_MDC_PATH};
use cliclack::{StringCursor, Theme, ThemeState};
use console::{style, Term};
use dif_core::config::EventsMode;
use std::io::{self, IsTerminal};
use std::path::Path;
use std::thread::sleep;
use std::time::{Duration, Instant};

/// Gap between summary lines. Short enough to never feel slow.
const LINE_PAUSE: Duration = Duration::from_millis(45);
/// The spinner stays up at least this long, so it reads as a step.
const MIN_SPIN: Duration = Duration::from_millis(450);

/// True when prompts and the paced summary can run.
pub(super) fn is_interactive(json: bool) -> bool {
    !json && io::stdin().is_terminal() && Term::stdout().is_term() && Term::stderr().is_term()
}

/// Print the intro, then ask what the flags left open.
/// Fills `args.key` and `args.framework`. `None` means the user cancelled.
pub(super) fn ask(cwd: &Path, args: &mut Args) -> io::Result<Option<EventsMode>> {
    cliclack::set_theme(DifTheme);
    cliclack::intro(format!(
        "{} {}",
        style(" dif.sh ").black().on_green().bold(),
        style(format!("v{}", env!("CARGO_PKG_VERSION"))).dim()
    ))?;
    match ask_inner(cwd, args) {
        Ok(mode) => Ok(Some(mode)),
        // cliclack already closes the rail with its own cancel line.
        Err(e) if e.kind() == io::ErrorKind::Interrupted => Ok(None),
        Err(e) => Err(e),
    }
}

fn ask_inner(cwd: &Path, args: &mut Args) -> io::Result<EventsMode> {
    let mut wants_analytics = false;
    let mode = match args.events {
        Some(flag) => flag.into(),
        None if args.key.is_some() => EventsMode::Cloud,
        None => {
            let products: Vec<Product> = cliclack::multiselect("Which products do you want?")
                .item(
                    Product::Analytics,
                    "Analytics",
                    "dif.sh Cloud: live lift, confidence and suggestions",
                )
                .item(
                    Product::EventTracking,
                    "Event tracking",
                    "send exposures and metrics to your own tool",
                )
                .initial_values(vec![Product::Analytics])
                .required(false)
                .interact()?;
            wants_analytics = products.contains(&Product::Analytics);
            if wants_analytics && products.contains(&Product::EventTracking) {
                cliclack::log::remark("Analytics sends your events to dif.sh Cloud.")?;
            }
            events_mode_for(&products)
        }
    };

    if wants_analytics && args.key.is_none() {
        let key: String = cliclack::input("Paste your publishable key")
            .placeholder("dif_pk_…  (Enter to skip)")
            .required(false)
            .validate(|s: &String| {
                if s.trim().is_empty() {
                    Ok(())
                } else {
                    validate_publishable_key(s).map(|_| ())
                }
            })
            .interact()?;
        if !key.trim().is_empty() {
            args.key = Some(key.trim().to_string());
        }
    }

    if args.framework.is_none() {
        let detected = super::detect_framework_in(cwd);
        let mut prompt = cliclack::select("Which framework does your app use?");
        for fw in Framework::ALL {
            let pkg = fw.packages().last().copied().unwrap_or_default();
            let hint = if fw == detected && detected != Framework::Sdk {
                format!("detected · {pkg}")
            } else {
                pkg.to_string()
            };
            prompt = prompt.item(fw, fw.label(), hint);
        }
        args.framework = Some(prompt.initial_value(detected).interact()?);
    }
    Ok(mode)
}

/// A spinner that covers the file writes.
pub(super) struct Progress {
    spinner: cliclack::ProgressBar,
    started: Instant,
}

impl Progress {
    pub(super) fn fail(&self) {
        self.spinner.error("Could not write the workspace");
    }
}

pub(super) fn start_writing() -> Progress {
    let spinner = cliclack::spinner();
    spinner.start("Scaffolding your dif workspace");
    Progress {
        spinner,
        started: Instant::now(),
    }
}

/// Show the result: what landed, then next steps.
pub(super) fn report_success(progress: Progress, s: &Summary, next: &[String]) -> io::Result<()> {
    if let Some(rest) = MIN_SPIN.checked_sub(progress.started.elapsed()) {
        sleep(rest);
    }
    if s.already_initialized {
        progress
            .spinner
            .stop("Your dif workspace is already up to date");
        row(
            "dif/",
            &format!(
                "files match dif v{}, nothing overwritten",
                env!("CARGO_PKG_VERSION")
            ),
        )?;
    } else {
        progress.spinner.stop("Created your dif workspace");
        for (path, hint) in project_rows(s) {
            row(&path, &hint)?;
        }
    }
    rail()?;

    let agents = agent_rows(s.sel, s.already_initialized);
    if !agents.is_empty() {
        step("Added guidance for coding agents")?;
        for (path, hint) in agents {
            row(path, hint)?;
        }
        rail()?;
    }

    let mut steps: Vec<String> = next
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let n = style(format!("{}.", i + 1)).dim();
            match line.split_once(" — ") {
                Some((cmd, why)) => format!("{n}  {cmd}\n    {}", style(why).dim()),
                None => format!("{n}  {line}"),
            }
        })
        .collect();
    if s.mode == EventsMode::Cloud && !s.has_key {
        steps.push(String::new());
        steps.push(format!(
            "{} {}",
            style("Turn on analytics:").dim(),
            "dif connect --key dif_pk_…"
        ));
    }
    cliclack::note("Next steps", steps.join("\n"))?;
    cliclack::outro(format!(
        "You're all set. Docs: {}",
        style("https://www.dif.sh/docs/").cyan().underlined()
    ))
}

/// Shown when existing files block the scaffold.
pub(super) fn report_collisions(progress: Progress, paths: &[String]) -> io::Result<()> {
    progress.spinner.error("Some files already exist");
    for p in paths {
        Term::stderr().write_line(&format!("{}  {} {p}", bar(), style("✗").red()))?;
    }
    rail()?;
    cliclack::outro_cancel(format!(
        "Nothing was written. Re-run with {} to overwrite, or {} to refresh agent files.",
        style("--force").bold(),
        style("dif init --agents-only").bold()
    ))
}

fn project_rows(s: &Summary) -> Vec<(String, String)> {
    let events = match (s.mode, s.has_key) {
        (EventsMode::Cloud, true) => "events → dif.sh Cloud, key set",
        (EventsMode::Cloud, false) => "events → dif.sh Cloud",
        (EventsMode::Custom, _) => "events → your handlers",
    };
    let mut rows = vec![
        ("dif/config.yaml".to_string(), events.to_string()),
        (
            format!("dif/surfaces/{}.md", s.surface),
            "default surface".to_string(),
        ),
        (
            "dif/audiences/".to_string(),
            "locale, device_type".to_string(),
        ),
        (
            "dif/experiments/".to_string(),
            "active, concluded".to_string(),
        ),
    ];
    if s.mode == EventsMode::Custom {
        rows.push(("dif/events/".to_string(), "exposure, track".to_string()));
    }
    rows.push(("dif/generated/".to_string(), "gitignored".to_string()));
    rows
}

fn agent_rows(sel: AgentSelection, already_initialized: bool) -> Vec<(&'static str, &'static str)> {
    let mut rows = Vec::new();
    if sel.claude {
        rows.push(("CLAUDE.md", "dif block merged"));
        if !already_initialized {
            rows.push((".claude/skills/", "4 dif skills"));
        }
    }
    if sel.general {
        rows.push(("AGENTS.md", "dif block merged"));
    }
    if sel.cursor && !already_initialized {
        rows.push((CURSOR_MDC_PATH, "Cursor rule"));
    }
    if sel.copilot {
        rows.push((".github/copilot-instructions.md", "dif block merged"));
    }
    rows
}

fn bar() -> console::StyledObject<&'static str> {
    style("│").bright().black()
}

fn rail() -> io::Result<()> {
    Term::stderr().write_line(&bar().to_string())
}

fn step(title: &str) -> io::Result<()> {
    Term::stderr().write_line(&format!("{}  {title}", style("◇").green()))
}

/// One paced, check-marked result line.
fn row(path: &str, hint: &str) -> io::Result<()> {
    sleep(LINE_PAUSE);
    Term::stderr().write_line(&format!(
        "{}  {} {:<34}{}",
        bar(),
        style("✔").green().bold(),
        path,
        style(hint).dim()
    ))
}

/// The default clack theme, but a skipped input reads "skipped".
/// The default shows the placeholder, which looks like an answer.
struct DifTheme;

impl Theme for DifTheme {
    fn format_placeholder(&self, state: &ThemeState, cursor: &StringCursor) -> String {
        let text = match state {
            ThemeState::Submit => style("skipped").dim().to_string(),
            ThemeState::Cancel => String::new(),
            _ => self.cursor_with_style(cursor, &self.placeholder_style(state)),
        };
        format!("{}  {text}\n", self.bar_color(state).apply_to("│"))
    }
}

//! The interactive face of `dif init`: clack-style prompts on stderr
//! and a paced, check-marked summary. Used only on a real terminal;
//! `--json` and piped runs keep the plain output in [`super`].

use super::choices::{feature_flag_values, features_for, Feature, Framework};
use super::{
    validate_publishable_key, AgentSelection, Args, Summary, CLAUDE_FILE_PATHS, CURSOR_MDC_PATH,
};
use crate::cloud::{CloudEnv, Failure, DEFAULT_CLOUD_URL};
use crate::cmd::auth::{finish_login, open_browser, start_login};
use crate::cmd::connect::{link_project, Args as ConnectArgs, Link};
use cliclack::{StringCursor, Theme, ThemeState};
use console::{style, Style, Term};
use dif_core::config::{EventsMode, ProjectType};
use dif_core::paths;
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
    print_logo()?;
    cliclack::intro(format!(
        "{} {}",
        badge().apply_to(" welcome to dif.sh! "),
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
    if args.features.is_none() {
        let picked: Vec<Feature> = cliclack::multiselect("Which features would you like to use?")
            .item(
                Feature::Analytics,
                "Analytics",
                "exposure and metric events, live results",
            )
            .item(Feature::Flags, "Flags", "ship and gate features")
            .item(
                Feature::Experiments,
                "Experiments",
                "A/B tests with variants",
            )
            .initial_values(Feature::ALL.to_vec())
            .interact()?;
        args.features = Some(feature_flag_values(features_for(&picked)));
    }
    let wants_analytics = args
        .features
        .as_ref()
        .is_some_and(|f| f.iter().any(|v| v == Feature::Analytics.flag_value()));

    let mode = match args.events {
        Some(flag) => flag.into(),
        None if args.key.is_some() || !wants_analytics => EventsMode::Cloud,
        None => cliclack::select("Where should events go?")
            .item(
                EventsMode::Cloud,
                "dif.sh Cloud",
                "lift, confidence and suggestions",
            )
            .item(
                EventsMode::Custom,
                "Your own handlers",
                "Amplitude, Segment, your backend",
            )
            .initial_value(EventsMode::Cloud)
            .interact()?,
    };

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

    if args.project_type.is_none() {
        let picked: Vec<ProjectType> = cliclack::multiselect("What type of app are you building?")
            .item(
                ProjectType::Marketing,
                "Marketing",
                "landing pages, campaigns",
            )
            .item(ProjectType::Ecommerce, "Ecommerce", "store, checkout")
            .item(ProjectType::App, "Webapp", "product, dashboard")
            .required(false)
            .interact()?;
        let mut picked = picked;
        // Same order as the config, so Cloud and the file agree.
        picked.sort();
        args.project_type = Some(picked.iter().map(|t| t.as_str().to_string()).collect());
    }

    // A re-run that adds a key would clash with the old config.
    // `dif connect` adds a key to an existing workspace.
    let fresh = args.force || !cwd.join(paths::CONFIG_FILE).exists();
    if fresh && wants_analytics && mode == EventsMode::Cloud && args.key.is_none() {
        connect_cloud(cwd, args)?;
    }
    Ok(mode)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CloudStep {
    SignIn,
    Paste,
    Skip,
}

/// Get a publishable key: by login and project pick, or by paste.
/// A failed sign-in warns and goes on with no key.
fn connect_cloud(cwd: &Path, args: &mut Args) -> io::Result<()> {
    let env = CloudEnv::from_process();
    let email = env
        .session()
        .and_then(|s| s.user)
        .and_then(|u| u["email"].as_str().map(String::from));
    let (label, hint) = match &email {
        Some(e) => ("Use your dif.sh login", e.clone()),
        None => (
            "Sign in with your browser",
            "pick or create a project".to_string(),
        ),
    };
    let step = cliclack::select("Connect to dif.sh Cloud?")
        .item(CloudStep::SignIn, label, hint)
        .item(CloudStep::Paste, "Paste a publishable key", "dif_pk_…")
        .item(CloudStep::Skip, "Skip for now", "run dif connect later")
        .interact()?;
    match step {
        CloudStep::Skip => Ok(()),
        CloudStep::Paste => paste_key(args),
        CloudStep::SignIn => match sign_in_and_link(cwd, &env, args)? {
            Ok(link) => {
                let verb = if link.created { "Created" } else { "Linked" };
                cliclack::log::success(format!("{verb} {}/{}", link.org, link.slug))?;
                args.dashboard_url = Some(link.dashboard_url);
                if link.cloud_url != DEFAULT_CLOUD_URL {
                    args.cloud_url = Some(link.cloud_url);
                }
                args.key = Some(link.key);
                Ok(())
            }
            Err(f) if f.code == "needs_selection" => {
                cliclack::log::remark("No project picked. Run dif connect later.")
            }
            Err(f) => cliclack::log::warning(format!("{}. Run dif connect later.", f.message)),
        },
    }
}

fn paste_key(args: &mut Args) -> io::Result<()> {
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
    Ok(())
}

/// Sign in when needed, then pick a project.
/// A rejected token gets one fresh sign-in.
fn sign_in_and_link(cwd: &Path, env: &CloudEnv, args: &Args) -> io::Result<Result<Link, Failure>> {
    if env.session().is_none() {
        if let Err(f) = sign_in(env)? {
            return Ok(Err(f));
        }
    }
    match link(cwd, env, args) {
        Err(f) if f.code == "token_invalid" => {
            cliclack::log::warning("Your login has expired. Sign in again.")?;
            if let Err(f) = sign_in(env)? {
                return Ok(Err(f));
            }
            Ok(link(cwd, env, args))
        }
        other => Ok(other),
    }
}

fn sign_in(env: &CloudEnv) -> io::Result<Result<(), Failure>> {
    let pending = match start_login(env).map_err(io::Error::other)? {
        Ok(p) => p,
        Err(f) => return Ok(Err(f)),
    };
    cliclack::note(
        "Sign in to dif.sh Cloud",
        format!(
            "Open {}\nand confirm the code {}",
            style(&pending.verification_uri_complete)
                .cyan()
                .underlined(),
            style(&pending.user_code).bold()
        ),
    )?;
    open_browser(&pending.verification_uri_complete);
    let spinner = cliclack::spinner();
    spinner.start("Waiting for you to approve in the browser");
    match finish_login(env, &pending, Duration::from_secs(600)).map_err(io::Error::other)? {
        Ok(cred) => {
            let who = cred
                .user
                .as_ref()
                .and_then(|u| u["email"].as_str())
                .unwrap_or("your account");
            spinner.stop(format!("Signed in as {who}"));
            Ok(Ok(()))
        }
        Err(f) => {
            spinner.error(&f.message);
            Ok(Err(f))
        }
    }
}

fn link(cwd: &Path, env: &CloudEnv, init: &Args) -> Result<Link, Failure> {
    let folder = cwd
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "app".to_string());
    let args = ConnectArgs {
        key: None,
        url: None,
        org: None,
        project: None,
        create: false,
        name: None,
        project_type: init.project_type.clone().unwrap_or_default(),
    };
    link_project(cwd, &args, env, true, &folder)
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
            row(path, &hint)?;
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
    if s.features.analytics && s.mode == EventsMode::Cloud && !s.has_key {
        steps.push(String::new());
        steps.push(format!(
            "{} {}",
            style("Turn on analytics:").dim(),
            "dif connect --key dif_pk_…"
        ));
    }
    if let Some(url) = s.dashboard_url {
        // The dashboard stays empty until the app sends events.
        steps.push(String::new());
        steps.push(format!(
            "{} {}",
            style("Your dashboard:").dim(),
            style(url).cyan().underlined()
        ));
        steps.push(
            style("Results appear once events arrive.")
                .dim()
                .to_string(),
        );
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

fn agent_rows(sel: AgentSelection, already_initialized: bool) -> Vec<(&'static str, String)> {
    let mut rows = Vec::new();
    if sel.claude {
        rows.push(("CLAUDE.md", "dif block merged".into()));
        if !already_initialized {
            rows.push((".claude/skills/", skills_hint()));
        }
    }
    if sel.general {
        rows.push(("AGENTS.md", "dif block merged".into()));
    }
    if sel.cursor && !already_initialized {
        rows.push((CURSOR_MDC_PATH, "Cursor rule".into()));
    }
    if sel.copilot {
        rows.push((".github/copilot-instructions.md", "dif block merged".into()));
    }
    rows
}

fn skills_hint() -> String {
    let n = CLAUDE_FILE_PATHS
        .iter()
        .filter(|p| p.ends_with("/SKILL.md"))
        .count();
    format!("{n} dif skills")
}

fn bar() -> console::StyledObject<&'static str> {
    style("│").bright().black()
}

fn rail() -> io::Result<()> {
    Term::stderr().write_line(&bar().to_string())
}

fn step(title: &str) -> io::Result<()> {
    Term::stderr().write_line(&format!("{}  {title}", lime().apply_to("◇")))
}

/// One paced, check-marked result line.
fn row(path: &str, hint: &str) -> io::Result<()> {
    sleep(LINE_PAUSE);
    Term::stderr().write_line(&format!(
        "{}  {} {:<34}{}",
        bar(),
        lime().bold().apply_to("✔"),
        path,
        style(hint).dim()
    ))
}

/// The default clack theme, but a skipped input reads "skipped".
/// The default shows the placeholder, which looks like an answer.
struct DifTheme;

impl Theme for DifTheme {
    fn state_symbol_color(&self, state: &ThemeState) -> Style {
        match state {
            ThemeState::Submit => lime(),
            _ => self.bar_color(state),
        }
    }

    fn active_symbol(&self) -> String {
        lime().apply_to("◆").to_string()
    }

    fn submit_symbol(&self) -> String {
        lime().apply_to("◇").to_string()
    }

    fn format_placeholder(&self, state: &ThemeState, cursor: &StringCursor) -> String {
        let text = match state {
            ThemeState::Submit => style("skipped").dim().to_string(),
            ThemeState::Cancel => String::new(),
            _ => self.cursor_with_style(cursor, &self.placeholder_style(state)),
        };
        format!("{}  {text}\n", self.bar_color(state).apply_to("│"))
    }
}

/// The dif lockup. Each row ends with the lime slash.
const LOGO: [&str; 5] = [
    "       ▄▄▄▄▄ ▄███▄  ▄██████▀  ▟██▛",
    " ▄▄▄▄▄ █████ ▄███▄ ▄█████▄▄  ▟██▛",
    "█████▀▀█████ █████ ██████▀  ▟██▛",
    "█████▄▄█████  ████  ████   ▟██▛",
    " ▀████▀ ▀███  ████  ████  ▟██▛",
];
const SLASH: &str = "▟██▛";

/// Letters use the terminal colour, so they show on any background.
fn print_logo() -> io::Result<()> {
    let term = Term::stderr();
    term.write_line("")?;
    for line in LOGO {
        let letters = line.strip_suffix(SLASH).unwrap_or(line);
        term.write_line(&format!(
            "{}{}",
            style(letters).bold(),
            lime().bold().apply_to(SLASH)
        ))?;
    }
    term.write_line("")
}

/// Brand lime, #D8FF86. Colour 192 is the 256-colour match.
fn lime() -> Style {
    if console::true_colors_enabled_stderr() {
        Style::new().true_color(0xD8, 0xFF, 0x86)
    } else {
        Style::new().color256(192)
    }
}

/// Brand dark green #143E3A on lime, as in the logo.
/// Colour 23 is the 256-colour match for the dark green.
fn badge() -> Style {
    let base = if console::true_colors_enabled_stderr() {
        Style::new()
            .true_color(0x14, 0x3E, 0x3A)
            .on_true_color(0xD8, 0xFF, 0x86)
    } else {
        Style::new().color256(23).on_color256(192)
    };
    base.bold()
}

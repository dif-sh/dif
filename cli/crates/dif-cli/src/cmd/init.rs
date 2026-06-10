//! `dif init` — scaffold the convention in the current directory.
//!
//! Idempotent under `--force`; refuses to clobber otherwise. Everything dif
//! owns lives under a single `dif/` namespace at the project root:
//!
//! ```text
//! dif/
//!   config.yaml
//!   audiences/locale.ts
//!   audiences/device_type.ts
//!   surfaces/<default-surface>.md
//!   experiments/active/
//!   experiments/concluded/
//!   generated/           (gitignored)
//!   .gitignore
//! ```
//!
//! Agent-onboarding files (CLAUDE.md, AGENTS.md, .cursorrules, .claude/skills/)
//! stay at the repo root — those are editor/agent conventions, not dif content.

use super::CmdError;
use clap::Args as ClapArgs;
use console::style;
use dif_core::paths;
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

    /// Skip writing agent-onboarding files (CLAUDE.md, AGENTS.md, .cursorrules,
    /// and the `.claude/skills/dif-*` directories). On by default — dif's
    /// product thesis is "primary developer is now an AI agent", so the
    /// guidance ships unless you opt out.
    #[arg(long)]
    pub no_agent_files: bool,
}

/// Entrypoint. See PLAN.md step 3.
pub fn run(args: Args, json: bool) -> Result<ExitCode, CmdError> {
    let cwd = std::env::current_dir()?;
    run_in(&cwd, args, json)
}

/// Test-friendly inner that takes an explicit cwd so the `current_dir()` side
/// effect can be sidestepped. Mirrors the pattern in [`super::scaffold_audiences`].
fn run_in(cwd: &Path, args: Args, json: bool) -> Result<ExitCode, CmdError> {
    let surface = args.surface.as_deref().unwrap_or("home").to_string();
    let project = cwd
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("project")
        .to_string();

    let dirs = [
        cwd.join(paths::EXPERIMENTS_ACTIVE),
        cwd.join(paths::EXPERIMENTS_CONCLUDED),
        cwd.join(paths::SURFACES_DIR),
        cwd.join(paths::AUDIENCES_DIR),
        cwd.join(paths::GENERATED_DIR),
    ];
    // Plain dif-owned files: the structural scaffold plus the dif-namespaced
    // skill files. Written verbatim and guarded by the refuse-unless-`--force`
    // collision check.
    let mut plain_files: Vec<(PathBuf, String)> = vec![
        (
            cwd.join(paths::CONFIG_FILE),
            default_config_yaml(&project, &surface),
        ),
        (cwd.join(paths::GITIGNORE_FILE), "generated/\n".to_string()),
        (
            cwd.join(paths::SURFACES_DIR).join(format!("{surface}.md")),
            default_surface_md(&surface),
        ),
        (
            cwd.join(paths::AUDIENCES_DIR).join("locale.ts"),
            DEFAULT_LOCALE_TS.to_string(),
        ),
        (
            cwd.join(paths::AUDIENCES_DIR).join("device_type.ts"),
            DEFAULT_DEVICE_TYPE_TS.to_string(),
        ),
    ];
    if !args.no_agent_files {
        plain_files.extend(agent_skill_files(cwd));
    }

    // Shared agent files (CLAUDE.md, AGENTS.md, .cursorrules) are co-owned with
    // the user, so we never clobber them: dif's guidance lives inside a delimited
    // managed block that we append once and refresh in place. They never trip the
    // collision guard — appending a block can't destroy anything.
    let merge_files: Vec<ManagedFile> = if args.no_agent_files {
        Vec::new()
    } else {
        agent_merge_files(cwd)
    };

    if !args.force {
        let collisions: Vec<&Path> = plain_files
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
    for (path, content) in &plain_files {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, content)?;
    }
    // Managed-block merge — preserve any user content already in the file, even
    // under `--force`. Force re-scaffolds the structural files, but must never
    // destroy a hand-edited CLAUDE.md; it refreshes only dif's delimited block.
    for mf in &merge_files {
        if let Some(parent) = mf.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let existing = std::fs::read_to_string(&mf.path).unwrap_or_default();
        let merged = merge_managed_block(&existing, &mf.block, mf.start, mf.end);
        std::fs::write(&mf.path, merged)?;
    }

    report_success(&surface, json, !args.no_agent_files);
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

fn report_success(surface: &str, json: bool, include_agent_files: bool) {
    if json {
        let mut created: Vec<String> = vec![
            paths::EXPERIMENTS_ACTIVE.into(),
            paths::EXPERIMENTS_CONCLUDED.into(),
            paths::SURFACES_DIR.into(),
            paths::AUDIENCES_DIR.into(),
            paths::GENERATED_DIR.into(),
            paths::CONFIG_FILE.into(),
            paths::GITIGNORE_FILE.into(),
            format!("{}/{surface}.md", paths::SURFACES_DIR),
            format!("{}/locale.ts", paths::AUDIENCES_DIR),
            format!("{}/device_type.ts", paths::AUDIENCES_DIR),
        ];
        if include_agent_files {
            created.extend(AGENT_FILE_PATHS.iter().map(|s| (*s).to_string()));
        }
        let payload = serde_json::json!({
            "ok": true,
            "created": created,
        });
        println!("{}", serde_json::to_string_pretty(&payload).unwrap());
        return;
    }
    let check = style("✓").green().bold();
    println!("{check} created dif/experiments/{{active,concluded}}");
    println!("{check} created dif/surfaces/");
    println!("{check} created dif/audiences/");
    println!("{check} wrote dif/config.yaml");
    println!("{check} wrote dif/.gitignore");
    println!("{check} wrote dif/surfaces/{surface}.md");
    println!("{check} wrote dif/audiences/locale.ts");
    println!("{check} wrote dif/audiences/device_type.ts");
    if include_agent_files {
        println!("{check} merged dif guidance into CLAUDE.md, AGENTS.md, .cursorrules");
        println!(
            "{check} wrote .claude/skills/dif-{{author,conclude}}-experiment, dif-generate-surfaces/"
        );
    }
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
# this set — anything not declared here is a validation error. Each entry
# must have a matching resolver at `dif/audiences/<name>.ts`. Run
# `dif scaffold-audiences` to pull in starters.
audience_attributes:
  - name: locale
    type: string
  - name: device_type
    type: enum
    values: [mobile, tablet, desktop]

# How users are bucketed.
bucketing:
  id: user_id
  fallback: anon_cookie

# Where exposure events go. Supported sinks: webhook, segment, amplitude, mixpanel.
exposure:
  sink: webhook
  fire_at: render   # never at assignment.

build:
  out: dif/generated
  fail_on: [conflict, orphan_ref, missing_owner]
"
    )
}

/// Default audience resolver for the user's browser locale. Treated as
/// user-owned the moment it's scaffolded — `dif init --force` will overwrite,
/// but normal updates leave it alone.
pub(crate) const DEFAULT_LOCALE_TS: &str =
    "// dif/audiences/locale.ts — resolve the browser's UI locale (e.g. \"en-US\").
//
// Returns null on the server (no `navigator`); audience predicates referencing
// `locale` therefore fail closed during SSR, which is the correct behavior.
//
// Edit this file freely — once scaffolded, dif treats it as yours. Update the
// matching `audience_attributes` entry in dif/config.yaml if you change the
// return type.
export default function resolve(): string | null {
  if (typeof navigator === \"undefined\") return null;
  return navigator.language ?? null;
}
";

/// Default audience resolver for the user's device class. Breakpoints (640 /
/// 1024 px) match the most common CSS defaults; tune for your design system.
pub(crate) const DEFAULT_DEVICE_TYPE_TS: &str =
    "// dif/audiences/device_type.ts — bucket users by viewport class.
//
// Returns null on the server (no `window`). Tweak the breakpoints to match
// your design system; the return type union must stay in sync with
// `audience_attributes.values` in dif/config.yaml.
export default function resolve(): \"mobile\" | \"tablet\" | \"desktop\" | null {
  if (typeof window === \"undefined\") return null;
  if (window.matchMedia(\"(max-width: 640px)\").matches) return \"mobile\";
  if (window.matchMedia(\"(max-width: 1024px)\").matches) return \"tablet\";
  return \"desktop\";
}
";

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

// -- agent onboarding files --------------------------------------------------
//
// CLAUDE.md, AGENTS.md, .cursorrules at the project root plus two Claude Code
// skills under `.claude/skills/`. The content lives under `assets/` so it can
// be edited as ordinary markdown; `include_str!` bakes it into the binary at
// compile time so `dif init` writes the same bytes regardless of where it
// runs.
//
// `cursorrules.txt` in `assets/` is intentionally not a dotfile — `cargo
// package`'s defaults exclude some dotfiles, and we'd rather not depend on
// that detail. The leading dot is added at write time.

pub(crate) const CLAUDE_MD: &str = include_str!("../../assets/CLAUDE.md");
pub(crate) const AGENTS_MD: &str = include_str!("../../assets/AGENTS.md");
pub(crate) const CURSORRULES: &str = include_str!("../../assets/cursorrules.txt");
pub(crate) const SKILL_AUTHOR: &str =
    include_str!("../../assets/claude/skills/dif-author-experiment/SKILL.md");
pub(crate) const SKILL_AUTHOR_FRONTMATTER: &str =
    include_str!("../../assets/claude/skills/dif-author-experiment/references/frontmatter.md");
pub(crate) const SKILL_AUTHOR_ERRORS: &str = include_str!(
    "../../assets/claude/skills/dif-author-experiment/references/validation-errors.md"
);
pub(crate) const SKILL_AUTHOR_AUDIENCES: &str =
    include_str!("../../assets/claude/skills/dif-author-experiment/references/audiences.md");
pub(crate) const SKILL_CONCLUDE: &str =
    include_str!("../../assets/claude/skills/dif-conclude-experiment/SKILL.md");
pub(crate) const SKILL_GENERATE_SURFACES: &str =
    include_str!("../../assets/claude/skills/dif-generate-surfaces/SKILL.md");

/// Paths (relative to the workspace root) that `dif init` writes when
/// agent-onboarding is enabled. Used by `report_success` for the JSON
/// `created[]` array and by tests to assert the scaffolded set.
pub(crate) const AGENT_FILE_PATHS: &[&str] = &[
    "CLAUDE.md",
    "AGENTS.md",
    ".cursorrules",
    ".claude/skills/dif-author-experiment/SKILL.md",
    ".claude/skills/dif-author-experiment/references/frontmatter.md",
    ".claude/skills/dif-author-experiment/references/validation-errors.md",
    ".claude/skills/dif-author-experiment/references/audiences.md",
    ".claude/skills/dif-conclude-experiment/SKILL.md",
    ".claude/skills/dif-generate-surfaces/SKILL.md",
];

/// Markers that delimit dif's managed block inside a co-owned file. Everything
/// between them is dif's to rewrite on each `init`; everything outside is the
/// user's and is never touched.
const MD_BLOCK_START: &str = "<!-- dif:start -->";
const MD_BLOCK_END: &str = "<!-- dif:end -->";
const HASH_BLOCK_START: &str = "# dif:start";
const HASH_BLOCK_END: &str = "# dif:end";

/// A file whose dif content is written as a managed block and merged into
/// whatever the user already has, rather than overwriting the whole file.
struct ManagedFile {
    path: PathBuf,
    block: String,
    start: &'static str,
    end: &'static str,
}

/// Insert or refresh dif's managed block without disturbing the user's own
/// content. Three cases:
///   - file empty/absent → the block becomes the whole file.
///   - markers present    → replace just the delimited region (idempotent refresh).
///   - markers absent      → append the block, preserving everything above it.
fn merge_managed_block(existing: &str, block: &str, start: &str, end: &str) -> String {
    let region = format!("{start}\n{block}{end}\n");
    if existing.trim().is_empty() {
        return region;
    }
    if let Some(s) = existing.find(start) {
        if let Some(rel) = existing[s..].find(end) {
            let e = s + rel + end.len();
            let mut out = String::with_capacity(existing.len() + region.len());
            out.push_str(&existing[..s]);
            out.push_str(region.trim_end_matches('\n'));
            out.push_str(&existing[e..]);
            return out;
        }
    }
    // No managed block yet — append one, separated by a blank line.
    let mut out = existing.to_string();
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push('\n');
    out.push_str(&region);
    out
}

/// The co-owned agent files (CLAUDE.md, AGENTS.md, .cursorrules), each carrying
/// dif's guidance inside a managed block stamped with the crate version so a
/// user can detect drift between their scaffolded files and the binary.
fn agent_merge_files(cwd: &Path) -> Vec<ManagedFile> {
    let v = env!("CARGO_PKG_VERSION");
    let md_stamp =
        format!("<!-- generated by dif v{v}; safe to re-run `dif init` to refresh -->\n\n");
    let hash_stamp = format!("# generated by dif v{v}; safe to re-run `dif init` to refresh\n\n");
    vec![
        ManagedFile {
            path: cwd.join("CLAUDE.md"),
            block: format!("{md_stamp}{CLAUDE_MD}"),
            start: MD_BLOCK_START,
            end: MD_BLOCK_END,
        },
        ManagedFile {
            path: cwd.join("AGENTS.md"),
            block: format!("{md_stamp}{AGENTS_MD}"),
            start: MD_BLOCK_START,
            end: MD_BLOCK_END,
        },
        ManagedFile {
            path: cwd.join(".cursorrules"),
            block: format!("{hash_stamp}{CURSORRULES}"),
            start: HASH_BLOCK_START,
            end: HASH_BLOCK_END,
        },
    ]
}

/// The dif-namespaced Claude Code skill files. These live entirely under
/// `.claude/skills/dif-*/`, so they're written verbatim (and collision-guarded)
/// rather than merged.
fn agent_skill_files(cwd: &Path) -> Vec<(PathBuf, String)> {
    let author = cwd
        .join(".claude")
        .join("skills")
        .join("dif-author-experiment");
    let conclude = cwd
        .join(".claude")
        .join("skills")
        .join("dif-conclude-experiment");
    let generate = cwd
        .join(".claude")
        .join("skills")
        .join("dif-generate-surfaces");

    vec![
        (author.join("SKILL.md"), SKILL_AUTHOR.to_string()),
        (
            author.join("references").join("frontmatter.md"),
            SKILL_AUTHOR_FRONTMATTER.to_string(),
        ),
        (
            author.join("references").join("validation-errors.md"),
            SKILL_AUTHOR_ERRORS.to_string(),
        ),
        (
            author.join("references").join("audiences.md"),
            SKILL_AUTHOR_AUDIENCES.to_string(),
        ),
        (conclude.join("SKILL.md"), SKILL_CONCLUDE.to_string()),
        (
            generate.join("SKILL.md"),
            SKILL_GENERATE_SURFACES.to_string(),
        ),
    ]
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
        let names: Vec<&str> = config
            .audience_attributes
            .iter()
            .map(|a| a.name.as_str())
            .collect();
        assert_eq!(names, vec!["locale", "device_type"]);
    }

    #[test]
    fn scaffolded_audience_files_contain_resolver_default_export() {
        assert!(DEFAULT_LOCALE_TS.contains("export default function resolve"));
        assert!(DEFAULT_LOCALE_TS.contains("navigator.language"));
        assert!(DEFAULT_DEVICE_TYPE_TS.contains("export default function resolve"));
        assert!(DEFAULT_DEVICE_TYPE_TS.contains("matchMedia"));
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

    #[test]
    fn scaffolds_agent_files_by_default() {
        let tmp = tempfile::TempDir::new().unwrap();
        run_in(
            tmp.path(),
            Args {
                surface: None,
                force: false,
                no_agent_files: false,
            },
            true,
        )
        .expect("init");
        for rel in AGENT_FILE_PATHS {
            let p = tmp.path().join(rel);
            assert!(p.exists(), "missing scaffolded file: {rel}");
            let content = std::fs::read_to_string(&p).unwrap();
            assert!(!content.is_empty(), "empty scaffolded file: {rel}");
        }
        // Top-level files carry the version stamp so users can detect skew.
        let v = env!("CARGO_PKG_VERSION");
        let claude_md = std::fs::read_to_string(tmp.path().join("CLAUDE.md")).unwrap();
        assert!(
            claude_md.contains(&format!("generated by dif v{v}")),
            "CLAUDE.md missing version stamp"
        );
        let cursorrules = std::fs::read_to_string(tmp.path().join(".cursorrules")).unwrap();
        assert!(
            cursorrules.contains(&format!("generated by dif v{v}")),
            ".cursorrules missing version stamp"
        );
    }

    #[test]
    fn no_agent_files_flag_suppresses_them() {
        let tmp = tempfile::TempDir::new().unwrap();
        run_in(
            tmp.path(),
            Args {
                surface: None,
                force: false,
                no_agent_files: true,
            },
            true,
        )
        .expect("init");
        for rel in AGENT_FILE_PATHS {
            let p = tmp.path().join(rel);
            assert!(!p.exists(), "unexpected scaffolded file: {rel}");
        }
        // The non-agent scaffold still wrote.
        assert!(tmp.path().join("dif/config.yaml").exists());
        assert!(tmp.path().join("dif/surfaces/home.md").exists());
        assert!(tmp.path().join("dif/audiences/locale.ts").exists());
    }

    #[test]
    fn merge_preserves_existing_user_content() {
        let tmp = tempfile::TempDir::new().unwrap();
        let claude = tmp.path().join("CLAUDE.md");
        std::fs::write(
            &claude,
            "# My project\n\nHand-written notes the user pasted.\n",
        )
        .unwrap();

        // A bare pre-existing CLAUDE.md must NOT block init (the bug we're fixing).
        run_in(
            tmp.path(),
            Args {
                surface: None,
                force: false,
                no_agent_files: false,
            },
            true,
        )
        .expect("init should succeed despite a pre-existing CLAUDE.md");

        let merged = std::fs::read_to_string(&claude).unwrap();
        assert!(
            merged.contains("Hand-written notes the user pasted."),
            "user content was clobbered"
        );
        assert!(merged.contains(MD_BLOCK_START) && merged.contains(MD_BLOCK_END));
        assert!(merged.contains("generated by dif v"));
        // The structural scaffold still landed (no collision on a bare CLAUDE.md).
        assert!(tmp.path().join("dif/config.yaml").exists());
    }

    #[test]
    fn merge_is_idempotent() {
        let tmp = tempfile::TempDir::new().unwrap();
        let claude = tmp.path().join("CLAUDE.md");
        std::fs::write(&claude, "User notes.\n").unwrap();

        // --force on the re-run bypasses the structural collision so the merge path runs twice.
        let args = || Args {
            surface: None,
            force: true,
            no_agent_files: false,
        };
        run_in(tmp.path(), args(), true).expect("first");
        run_in(tmp.path(), args(), true).expect("second");

        let merged = std::fs::read_to_string(&claude).unwrap();
        assert_eq!(
            merged.matches(MD_BLOCK_START).count(),
            1,
            "managed block duplicated on re-run"
        );
        assert_eq!(merged.matches(MD_BLOCK_END).count(), 1);
        assert!(
            merged.contains("User notes."),
            "user content lost on refresh"
        );
    }

    #[test]
    fn force_refreshes_block_without_destroying_user_content() {
        let tmp = tempfile::TempDir::new().unwrap();
        let claude = tmp.path().join("CLAUDE.md");
        // A stale managed block sandwiched between user content on both sides.
        std::fs::write(
            &claude,
            format!(
                "Top notes.\n\n{MD_BLOCK_START}\nOLD DIF CONTENT\n{MD_BLOCK_END}\n\nBottom notes.\n"
            ),
        )
        .unwrap();

        run_in(
            tmp.path(),
            Args {
                surface: None,
                force: true,
                no_agent_files: false,
            },
            true,
        )
        .expect("init --force");

        let merged = std::fs::read_to_string(&claude).unwrap();
        assert!(
            merged.contains("Top notes."),
            "content above the block lost"
        );
        assert!(
            merged.contains("Bottom notes."),
            "content below the block lost"
        );
        assert!(
            !merged.contains("OLD DIF CONTENT"),
            "stale managed block was not refreshed"
        );
        assert!(merged.contains("generated by dif v"));
        assert_eq!(merged.matches(MD_BLOCK_START).count(), 1);
    }

    #[test]
    fn structural_collision_still_refuses_without_force() {
        let tmp = tempfile::TempDir::new().unwrap();
        // A pre-existing structural file must still cause a refusal.
        std::fs::create_dir_all(tmp.path().join("dif")).unwrap();
        std::fs::write(tmp.path().join("dif/config.yaml"), "project: x\n").unwrap();

        run_in(
            tmp.path(),
            Args {
                surface: None,
                force: false,
                no_agent_files: false,
            },
            true,
        )
        .expect("init returns Ok with a non-zero exit code");

        // It bailed before writing anything new.
        assert!(
            !tmp.path().join("dif/audiences/locale.ts").exists(),
            "init should have refused on the structural collision"
        );
        assert!(!tmp.path().join("CLAUDE.md").exists());
    }

    #[test]
    fn skill_md_files_have_required_frontmatter() {
        for (name, content) in [
            ("dif-author-experiment", SKILL_AUTHOR),
            ("dif-conclude-experiment", SKILL_CONCLUDE),
            ("dif-generate-surfaces", SKILL_GENERATE_SURFACES),
        ] {
            let frontmatter = extract_frontmatter(content)
                .unwrap_or_else(|| panic!("SKILL.md for {name} has no YAML frontmatter"));
            let parsed: serde_yaml::Value =
                serde_yaml::from_str(frontmatter).expect("frontmatter parses as YAML");
            let map = parsed.as_mapping().expect("frontmatter is a YAML mapping");
            assert_eq!(
                map.get(serde_yaml::Value::String("name".into()))
                    .and_then(|v| v.as_str()),
                Some(name),
                "{name} SKILL.md `name:` field must match directory name"
            );
            let desc = map
                .get(serde_yaml::Value::String("description".into()))
                .and_then(|v| v.as_str())
                .unwrap_or_else(|| panic!("{name} SKILL.md missing `description:` field"));
            // Trigger surface: the description is what Claude Code matches on
            // to decide whether to load the skill. Too-short descriptions
            // under-trigger.
            assert!(
                desc.len() > 80,
                "{name} description suspiciously short ({} chars); skills need an explicit trigger surface",
                desc.len()
            );
            assert!(
                desc.contains("dif"),
                "{name} description doesn't mention `dif`; trigger word missing"
            );
        }
    }

    #[test]
    fn extract_frontmatter_tolerates_crlf() {
        // Simulates what `include_str!` sees on Windows when `.gitattributes`
        // is missing and `core.autocrlf` rewrites checkouts to CRLF.
        let lf = "---\nname: x\ndescription: y\n---\n\n# body\n";
        let crlf = "---\r\nname: x\r\ndescription: y\r\n---\r\n\r\n# body\r\n";
        let mixed = "---\nname: x\r\ndescription: y\n---\r\n\n# body\n";

        let fm_lf = extract_frontmatter(lf).expect("LF");
        let fm_crlf = extract_frontmatter(crlf).expect("CRLF");
        let fm_mixed = extract_frontmatter(mixed).expect("mixed");

        for fm in [fm_lf, fm_crlf, fm_mixed] {
            assert!(
                fm.contains("name: x"),
                "frontmatter lost name field: {fm:?}"
            );
            assert!(fm.contains("description: y"));
            assert!(
                !fm.contains("# body"),
                "frontmatter leaked into body: {fm:?}"
            );
        }
    }

    /// Drift guard: every error code emitted by `dif-core::validate` must be
    /// documented in `references/validation-errors.md`. If you add a new code
    /// in validate.rs, also document it and append it to the list below. This
    /// test is the structural enforcement against doc rot.
    #[test]
    fn validation_errors_doc_lists_every_real_code() {
        let codes = [
            "E001", "E003", "E004", "E005", "E006", "E007", "E008", "W001", "W002",
        ];
        for code in codes {
            assert!(
                SKILL_AUTHOR_ERRORS.contains(code),
                "validation-errors.md is missing documentation for `{code}` — \
                 add a section for it, or remove `{code}` from `dif-core::validate` if obsolete."
            );
        }
    }

    /// Extract the YAML frontmatter slice from a SKILL.md source string.
    ///
    /// Tolerant of both `\n` and `\r\n` line endings: `.gitattributes` pins
    /// LF for in-tree assets, but defending here too keeps the test green if
    /// someone builds from a working tree that's been touched by a Windows
    /// editor or a stale `core.autocrlf=true` checkout.
    fn extract_frontmatter(source: &str) -> Option<&str> {
        let s = source.trim_start();
        let after_open = s
            .strip_prefix("---\n")
            .or_else(|| s.strip_prefix("---\r\n"))?;
        // Closing fence: any combination of LF / CRLF on either side.
        ["\n---\n", "\n---\r\n", "\r\n---\n", "\r\n---\r\n"]
            .iter()
            .filter_map(|marker| after_open.find(marker))
            .min()
            .map(|end| &after_open[..end])
    }
}

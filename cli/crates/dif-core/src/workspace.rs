//! Workspace discovery + loading.
//!
//! A "workspace" is a customer repo with a `dif/config.yaml` at its root and
//! the canonical layout under `dif/`: `dif/experiments/{active,concluded}/`,
//! `dif/surfaces/`, `dif/audiences/`. This module finds it, walks it, and
//! hands back the decoded set.
//!
//! Loading is tolerant: per-file parse errors are collected into
//! [`Workspace::parse_errors`] so [`crate::validate`] can surface them all at
//! once rather than failing at the first broken file. The only fatal errors
//! are "no workspace found" and "config.yaml unparseable" — without either,
//! every other check is meaningless.

use crate::{
    audience_files::{self, AudienceFile},
    config::Config,
    diag::Diagnostic,
    parse::{self, ParseError, ParsedExperiment, ParsedSurface},
    paths,
};
use regex::Regex;
use std::path::{Path, PathBuf};
use thiserror::Error;

/// Loaded workspace. The bag of inputs every other phase operates on.
#[derive(Debug)]
pub struct Workspace {
    /// Absolute path to the workspace root (the dir containing `dif/`).
    pub root: PathBuf,
    /// Decoded `dif/config.yaml`.
    pub config: Config,
    /// All active experiments.
    pub active: Vec<ParsedExperiment>,
    /// All concluded experiments. Kept around so `dif conclude` and the agent
    /// context export can reference them.
    pub concluded: Vec<ParsedExperiment>,
    /// All surfaces.
    pub surfaces: Vec<ParsedSurface>,
    /// Audience resolver files found under `dif/audiences/`. Treated as opaque
    /// TypeScript — Rust never opens them; the slug is enough to pair with
    /// `config.audience_attributes` and tree-shake the generated bag.
    pub audiences: Vec<AudienceFile>,
    /// Call sites: every `dif("<id>", ...)` reference found in source.
    /// Empty until [`Workspace::scan_call_sites`] runs.
    pub call_sites: Vec<CallSite>,
    /// Diagnostics from files that failed to parse. Collected, not raised, so
    /// `validate` can report them in one pass alongside other checks.
    pub parse_errors: Vec<Diagnostic>,
}

/// One discovered `dif("<id>", ...)` call site.
#[derive(Debug, Clone)]
pub struct CallSite {
    /// Source file containing the call.
    pub file: PathBuf,
    /// Line number (1-indexed) for diagnostics.
    pub line: usize,
    /// The experiment id passed to `dif()`.
    pub experiment_id: String,
}

/// Workspace loading errors. These are the only failures that abort `validate`
/// outright; everything else is collected as a `Diagnostic`.
#[derive(Debug, Error)]
pub enum WorkspaceError {
    /// No `dif/config.yaml` found in `start` or any ancestor.
    #[error("no dif.sh workspace found above {0}")]
    NotFound(PathBuf),
    /// `dif/config.yaml` was found but failed to parse.
    #[error("invalid dif/config.yaml: {0}")]
    Config(#[from] serde_yaml::Error),
    /// Anything else.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl Workspace {
    /// Walk up from `start` looking for `dif/config.yaml`, then load
    /// everything underneath. Does not scan call sites — call
    /// [`Workspace::scan_call_sites`] for that.
    pub fn load(start: &Path) -> Result<Self, WorkspaceError> {
        let root = find_workspace_root(start)
            .ok_or_else(|| WorkspaceError::NotFound(start.to_path_buf()))?;
        let config_path = root.join(paths::CONFIG_FILE);
        let config_source = std::fs::read_to_string(&config_path)?;
        let config: Config = serde_yaml::from_str(&config_source)?;

        let mut parse_errors = Vec::new();

        let active = load_experiments(
            &root.join(paths::EXPERIMENTS_ACTIVE),
            &mut parse_errors,
            &root,
        );
        let concluded = load_experiments(
            &root.join(paths::EXPERIMENTS_CONCLUDED),
            &mut parse_errors,
            &root,
        );
        let surfaces = load_surfaces(&root.join(paths::SURFACES_DIR), &mut parse_errors, &root);
        let audiences = audience_files::load_audience_files(&root.join(paths::AUDIENCES_DIR));

        Ok(Workspace {
            root,
            config,
            active,
            concluded,
            surfaces,
            audiences,
            call_sites: Vec::new(),
            parse_errors,
        })
    }

    /// Grep the workspace for `dif("<id>", ...)` patterns in source files.
    /// Populates [`Workspace::call_sites`]. Used by `validate` to detect
    /// orphan refs.
    ///
    /// Scans `.ts`, `.tsx`, `.js`, `.jsx` files anywhere under `root`, skipping
    /// well-known noise directories (`.git`, `node_modules`, `target`, `dist`,
    /// `build`) and dif's own namespace (`dif/`).
    pub fn scan_call_sites(&mut self) -> Result<(), WorkspaceError> {
        let root = self.root.clone();
        // Word-boundary so `notdif(...)` doesn't match. Permissive on id chars
        // — `validate` enforces the canonical kebab-case shape separately.
        let pattern =
            Regex::new(r#"\bdif\s*\(\s*"([a-zA-Z0-9][a-zA-Z0-9_-]*)""#).expect("static regex");

        let mut sites = Vec::new();
        let root_for_filter = root.clone();
        for entry in walkdir::WalkDir::new(&root)
            .into_iter()
            .filter_entry(move |e| {
                if e.path() == root_for_filter {
                    return true;
                }
                let name = e.file_name().to_str().unwrap_or("");
                !matches!(
                    name,
                    paths::DIF_DIR | ".git" | "node_modules" | "target" | "dist" | "build"
                )
            })
        {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let ext = entry
                .path()
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            if !matches!(ext, "ts" | "tsx" | "js" | "jsx") {
                continue;
            }
            let source = match std::fs::read_to_string(entry.path()) {
                Ok(s) => s,
                Err(_) => continue,
            };
            for caps in pattern.captures_iter(&source) {
                let m = caps.get(0).expect("match 0");
                let id = caps.get(1).expect("capture 1").as_str().to_string();
                let line = source[..m.start()].matches('\n').count() + 1;
                sites.push(CallSite {
                    file: entry.path().to_path_buf(),
                    line,
                    experiment_id: id,
                });
            }
        }
        // Deterministic order for tests + reproducible PR diffs.
        sites.sort_by(|a, b| (a.file.as_path(), a.line).cmp(&(b.file.as_path(), b.line)));
        self.call_sites = sites;
        Ok(())
    }
}

fn find_workspace_root(start: &Path) -> Option<PathBuf> {
    let mut cur = start.canonicalize().ok()?;
    loop {
        if cur.join(paths::CONFIG_FILE).is_file() {
            return Some(cur);
        }
        if !cur.pop() {
            return None;
        }
    }
}

fn list_md_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("md") && path.is_file() {
            out.push(path);
        }
    }
    out.sort();
    out
}

fn load_experiments(
    dir: &Path,
    errors: &mut Vec<Diagnostic>,
    root: &Path,
) -> Vec<ParsedExperiment> {
    let mut out = Vec::new();
    for path in list_md_files(dir) {
        match parse::parse_experiment(&path) {
            Ok(parsed) => out.push(parsed),
            Err(e) => errors.push(parse_error_diagnostic(&path, &e, root)),
        }
    }
    out
}

fn load_surfaces(dir: &Path, errors: &mut Vec<Diagnostic>, root: &Path) -> Vec<ParsedSurface> {
    let mut out = Vec::new();
    for path in list_md_files(dir) {
        match parse::parse_surface(&path) {
            Ok(parsed) => out.push(parsed),
            Err(e) => errors.push(parse_error_diagnostic(&path, &e, root)),
        }
    }
    out
}

fn parse_error_diagnostic(path: &Path, error: &ParseError, root: &Path) -> Diagnostic {
    let (line, column) = match error {
        ParseError::Yaml(yaml) => yaml
            .location()
            .map(|loc| (loc.line(), loc.column()))
            .unwrap_or((1, 1)),
        _ => (1, 1),
    };
    Diagnostic {
        code: "E001".to_string(),
        message: error.to_string(),
        file: relative_path(path, root),
        line,
        column,
        help: None,
    }
}

/// Best-effort relative path for diagnostic display. Falls back to the absolute
/// path if `path` isn't under `root`.
pub(crate) fn relative_path(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| path.display().to_string())
}

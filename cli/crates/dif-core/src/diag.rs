//! Diagnostics — `miette` integration so error output looks like `rustc`.
//!
//! Every check produces zero or more `Diagnostic` values, collected into a
//! `Report` that the CLI prints (or returns as JSON via `--json`).

use miette::Diagnostic as MietteDiagnostic;
use serde::Serialize;
use thiserror::Error;

/// A collected report from running all validation passes.
#[derive(Debug, Default, Serialize)]
pub struct Report {
    /// Hard errors. Any of these makes `validate` return non-zero.
    pub errors: Vec<Diagnostic>,
    /// Soft warnings. Cosmetic; do not fail the build by default.
    pub warnings: Vec<Diagnostic>,
}

impl Report {
    /// True if there are zero errors. Warnings do not count.
    pub fn is_clean(&self) -> bool {
        self.errors.is_empty()
    }
}

/// One diagnostic message. The Rust side knows about byte spans (passed to
/// `miette`); the JSON projection drops them in favor of line/column for
/// agent consumption.
#[derive(Debug, Clone, Serialize, Error, MietteDiagnostic)]
#[error("{message}")]
pub struct Diagnostic {
    /// Short machine-readable diagnostic code, e.g. `dif::E001`.
    pub code: String,
    /// One-line human message.
    pub message: String,
    /// File the diagnostic points at, relative to workspace root.
    pub file: String,
    /// 1-indexed line number.
    pub line: usize,
    /// 1-indexed column number.
    pub column: usize,
    /// Optional longer-form help — surfaces as miette's `help:` block.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
}

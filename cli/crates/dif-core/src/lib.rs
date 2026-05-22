//! `dif-core` — the engine behind the dif.sh CLI.
//!
//! Public surface is intentionally narrow: load a workspace, validate it,
//! build the generated TS client + context.json. Everything user-facing
//! about the CLI lives in `dif-cli`; everything correctness-critical lives
//! here.
//!
//! See [PLAN.md](../../../PLAN.md) for the full architectural rationale.

#![deny(rust_2018_idioms)]
#![warn(missing_docs)]

pub mod audience;
pub mod bucket;
pub mod codegen;
pub mod config;
pub mod context;
pub mod diag;
pub mod exclusion;
pub mod parse;
pub mod spec;
pub mod validate;
pub mod workspace;

pub use config::Config;
pub use diag::{Diagnostic, Report};
pub use parse::{ParsedExperiment, ParsedSurface};
pub use spec::{Audience, Experiment, Status, Surface, Variant};
pub use workspace::{CallSite, Workspace, WorkspaceError};

/// Crate version, baked into generated artifacts so customers can audit drift.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The marker string we prepend to bucket salts. Changing this is a breaking
/// change to bucketing across the entire ecosystem — do not change it.
pub const BUCKET_NAMESPACE: &str = "dif.sh/v1";

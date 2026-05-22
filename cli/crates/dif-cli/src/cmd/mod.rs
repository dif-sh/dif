//! CLI subcommands. Each module owns its `Args`, its `run` entrypoint, and
//! its pretty-printer. Everything correctness-critical lives in `dif-core`.

pub mod build;
pub mod conclude;
pub mod init;
pub mod new;
pub mod qa;
pub mod validate;

/// Shared error type for the CLI layer. We deliberately keep this small —
/// dif-core errors carry their own context via miette.
#[derive(Debug, thiserror::Error)]
pub enum CmdError {
    /// Anything bubbled up from dif-core's workspace loader.
    #[error(transparent)]
    Workspace(#[from] dif_core::workspace::WorkspaceError),
    /// Plain IO.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// Anything else, with a static message.
    #[error("{0}")]
    Other(&'static str),
}

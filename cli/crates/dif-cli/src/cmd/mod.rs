//! CLI subcommands. Each module owns its `Args`, its `run` entrypoint, and
//! its pretty-printer. Everything correctness-critical lives in `dif-core`.

pub mod build;
pub mod conclude;
pub mod connect;
pub mod init;
pub mod new;
pub mod qa;
pub mod scaffold_audiences;
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
    /// Anything else that needs an owned, formatted message (e.g. one that
    /// interpolates a path). `Other` can't hold these since it's `&'static str`.
    #[error("{0}")]
    OtherOwned(String),
}

/// Validate + normalise a pasted publishable key, shared by `dif connect` and
/// `dif init --key`.
///
/// Trims surrounding whitespace (copy/paste drags newlines) and refuses
/// anything that isn't a publishable `dif_pk_…` key. The most important guard:
/// the *secret* server key (`dif_live_…` / `dif_test_…`) must never land in the
/// committed `config.yaml`.
pub(crate) fn validate_publishable_key(raw: &str) -> Result<String, CmdError> {
    let key = raw.trim();
    if key.is_empty() {
        return Err(CmdError::Other("no key provided"));
    }
    if !key.starts_with("dif_pk_") {
        if key.starts_with("dif_") {
            return Err(CmdError::Other(
                "that looks like a secret server key — only a publishable key (dif_pk_…) belongs in dif/config.yaml",
            ));
        }
        return Err(CmdError::Other(
            "not a publishable key — expected the dif_pk_… key from your dif.sh Cloud project",
        ));
    }
    // Guard against truncated copy/pastes and placeholder text (`dif_pk_live_...`,
    // `dif_pk_live_…`, or a bare `dif_pk_`): the remainder must be the key body
    // itself, not an ellipsis standing in for it.
    let remainder = &key["dif_pk_".len()..];
    let complete = !remainder.is_empty()
        && remainder
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !complete {
        return Err(CmdError::Other(
            "that isn't a complete publishable key — paste the exact dif_pk_… value from your dif.sh Cloud project (no placeholders)",
        ));
    }
    Ok(key.to_string())
}

#[cfg(test)]
mod tests {
    use super::validate_publishable_key;

    #[test]
    fn accepts_and_trims_publishable_key() {
        assert_eq!(
            validate_publishable_key("  dif_pk_live_abc \n").unwrap(),
            "dif_pk_live_abc"
        );
    }

    #[test]
    fn rejects_empty() {
        assert!(validate_publishable_key("   ").is_err());
    }

    #[test]
    fn rejects_secret_key() {
        assert!(validate_publishable_key("dif_live_supersecret").is_err());
        assert!(validate_publishable_key("dif_test_supersecret").is_err());
    }

    #[test]
    fn rejects_garbage() {
        assert!(validate_publishable_key("not-a-key").is_err());
    }

    #[test]
    fn rejects_incomplete_key() {
        // ASCII-dots placeholder.
        assert!(validate_publishable_key("dif_pk_live_...").is_err());
        // Unicode ellipsis placeholder — a common copy/paste artifact from
        // docs/screenshots that renders `...` as a single `…` glyph.
        assert!(validate_publishable_key("dif_pk_live_…").is_err());
        // Prefix with nothing after it.
        assert!(validate_publishable_key("dif_pk_").is_err());
    }

    #[test]
    fn accepts_complete_key() {
        assert_eq!(
            validate_publishable_key("dif_pk_live_abc123").unwrap(),
            "dif_pk_live_abc123"
        );
    }
}

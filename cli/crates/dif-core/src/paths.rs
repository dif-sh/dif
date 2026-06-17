//! Canonical on-disk paths for a dif workspace.
//!
//! Every command, validator, and codegen step reads or writes one of these
//! paths. They live here so layout changes are a single-file diff instead of
//! a 20-file sweep. Treat the constants as the source of truth — never
//! hardcode `"dif/audiences"` etc. in callers.
//!
//! All paths are relative to the workspace root.

/// Top-level dif namespace directory. Everything dif owns lives under this.
pub const DIF_DIR: &str = "dif";

/// Project config file (`dif/config.yaml`).
pub const CONFIG_FILE: &str = "dif/config.yaml";

/// Scaffolded gitignore inside the dif namespace (`dif/.gitignore`). Ignores
/// the `generated/` subdir so codegen output isn't committed.
pub const GITIGNORE_FILE: &str = "dif/.gitignore";

/// Audience resolver directory (`dif/audiences`). Each declared
/// `audience_attributes` entry pairs with a `<name>.ts` file here.
pub const AUDIENCES_DIR: &str = "dif/audiences";

/// Custom event-handler directory (`dif/events`). In custom events mode it
/// holds `exposure.ts` + `track.ts`, each a default-export handler.
pub const EVENTS_DIR: &str = "dif/events";

/// Surface spec directory (`dif/surfaces`). One `<surface>.md` per surface.
pub const SURFACES_DIR: &str = "dif/surfaces";

/// Experiment specs root (`dif/experiments`). Contains `active/` and
/// `concluded/`.
pub const EXPERIMENTS_DIR: &str = "dif/experiments";

/// Active experiment specs (`dif/experiments/active`).
pub const EXPERIMENTS_ACTIVE: &str = "dif/experiments/active";

/// Concluded experiment specs (`dif/experiments/concluded`).
pub const EXPERIMENTS_CONCLUDED: &str = "dif/experiments/concluded";

/// Default `build.out` value (`dif/generated`). Holds the TypeScript client
/// and audience bag emitted by `dif build`.
pub const GENERATED_DIR: &str = "dif/generated";

/// Context manifest written by `dif build` (`dif/context.json`). Read by
/// tooling and AI agents for project introspection.
pub const CONTEXT_FILE: &str = "dif/context.json";

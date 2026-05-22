//! Serde types for the `.md` experiment frontmatter and surface files.
//!
//! These are the canonical Rust mirrors of the YAML spec documented in
//! [brief.md](../../../../brief.md#the-md-experiment-spec). They are the
//! source of truth for both parsing and codegen.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

/// One experiment, as declared by a single `.md` file under `experiments/`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Experiment {
    /// Kebab-case, unique within the workspace. Matches the filename stem.
    pub id: String,
    /// Lifecycle state. Drives which folder the file lives in.
    pub status: Status,
    /// Email of the human accountable for this experiment.
    pub owner: String,
    /// Surface this experiment runs on. Must resolve to `surfaces/<surface>.md`.
    pub surface: String,
    /// One-paragraph hypothesis. Free text.
    pub hypothesis: String,
    /// Audience predicate. `include` is implicit AND; `exclude` is implicit OR-negated.
    #[serde(default)]
    pub audience: Audience,
    /// At least two variants. Weights must sum to 100.
    pub variants: Vec<Variant>,
    /// Primary metric and guardrails.
    pub metrics: Metrics,
    /// Optional mutual-exclusion group key. Experiments sharing a group cannot
    /// run on the same user — enforced at compile time.
    #[serde(default)]
    pub exclusion_group: Option<String>,
    /// First-created date. Stable; used as exclusion priority tiebreaker.
    pub created: NaiveDate,
    /// Set by `dif conclude`. Null while active.
    #[serde(default)]
    pub concluded: Option<NaiveDate>,
}

/// Experiment lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// Authored but not yet promoted to active.
    Draft,
    /// Live. Counts against exclusion-group budget and is included in `context.json`.
    Active,
    /// Archived with a Decision block. Lives in `experiments/concluded/`.
    Concluded,
    /// Concluded long enough ago that we hide it from `context.json` by default.
    Archived,
}

/// Audience predicate. Both lists evaluate against the attributes declared in
/// `.dif/config.yaml`. Anything not declared is a validation error — we refuse
/// to invent a new targeting DSL.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Audience {
    /// All include predicates must match.
    #[serde(default)]
    pub include: Vec<AttrPredicate>,
    /// Any exclude predicate matching disqualifies the user.
    #[serde(default)]
    pub exclude: Vec<AttrPredicate>,
}

/// A single attribute predicate. Keyed by attribute name; the value is the
/// operand. v1 supports scalar equality and `in [list]` only — see PLAN open
/// question #1.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AttrPredicate(pub serde_yaml::Mapping);

/// One arm of an experiment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Variant {
    /// Stable id, unique within the experiment.
    pub id: String,
    /// 0–100. Sum across all variants must equal 100.
    pub weight: u16,
    /// Optional human-readable label. Surfaces in `dif qa` traces.
    #[serde(default)]
    pub summary: Option<String>,
}

/// Metric declarations. Names must resolve in the customer's analytics — we
/// don't validate them against any external source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Metrics {
    /// The metric the experiment is testing.
    pub primary: String,
    /// Anything we should keep an eye on but not optimize for.
    #[serde(default)]
    pub guardrails: Vec<String>,
}

/// A surface — a logical area of the product, with its own learning log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Surface {
    /// Surface id, matching the filename stem.
    pub id: String,
    /// Free-text description (the `# Surface: <name>` header + intro paragraph).
    pub description: String,
    /// Bullets under `## Known landmines`.
    #[serde(default)]
    pub landmines: Vec<String>,
    /// Bullets under `## Learnings`, newest first.
    #[serde(default)]
    pub learnings: Vec<Learning>,
}

/// One row in a surface's `## Learnings` log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Learning {
    /// Date the experiment concluded.
    pub date: NaiveDate,
    /// The experiment id this learning came from.
    pub experiment: String,
    /// One-line summary — what we learned, written by `dif conclude`.
    pub summary: String,
}

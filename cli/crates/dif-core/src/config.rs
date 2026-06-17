//! `dif/config.yaml` — the project-level configuration file.

use crate::paths;
use serde::{Deserialize, Serialize};

/// Top-level project config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Human-friendly project name. Cosmetic.
    pub project: String,
    /// Surface assumed when `dif new` is called without `--surface`.
    pub default_surface: String,
    /// Schema of attributes the audience predicate language is allowed to reference.
    #[serde(default)]
    pub audience_attributes: Vec<AudienceAttribute>,
    /// How users are bucketed.
    pub bucketing: BucketingConfig,
    /// How exposure + metric events are delivered. `None` resolves to cloud.
    #[serde(default)]
    pub events: Option<EventsConfig>,
    /// Legacy `exposure:` block. Retained only so `dif validate` can warn (W003)
    /// that it's been superseded by `events:`. Deserialized but otherwise ignored.
    #[serde(default, skip_serializing)]
    pub exposure: Option<serde_yaml::Value>,
    /// Compile-time settings.
    #[serde(default)]
    pub build: BuildConfig,
}

impl Config {
    /// The resolved events config. A workspace that predates the `events:` block
    /// (or omits it) defaults to cloud delivery.
    pub fn events(&self) -> EventsConfig {
        self.events.clone().unwrap_or_default()
    }
}

/// One declared audience attribute. The predicate language is closed over this set.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudienceAttribute {
    /// Attribute name as referenced in experiment YAML.
    pub name: String,
    /// Type. Drives serde validation at compile time.
    #[serde(rename = "type")]
    pub kind: AttrType,
    /// Allowed values for `enum` kinds.
    #[serde(default)]
    pub values: Vec<String>,
}

/// Supported attribute types. Deliberately small.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttrType {
    /// Boolean: true / false.
    Boolean,
    /// Free-form string.
    String,
    /// Enum: must be one of `values`.
    Enum,
    /// Numeric — integer or float. v1 supports equality only.
    Number,
}

/// Bucketing identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BucketingConfig {
    /// The primary user id field the SDK consults.
    pub id: String,
    /// Fallback when the primary is null. Typically `anon_cookie`.
    pub fallback: String,
}

/// How events (exposures + `dif.track()` metrics) are delivered.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventsConfig {
    /// `cloud` (built-in dif.sh Cloud delivery) or `custom` (the user exports
    /// handlers in `dif/events/{exposure,track}.ts`).
    #[serde(default)]
    pub mode: EventsMode,
    /// Cloud base URL. Set by `dif init` for cloud mode; ignored for custom.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl Default for EventsConfig {
    fn default() -> Self {
        Self {
            mode: EventsMode::Cloud,
            url: None,
        }
    }
}

/// The two ways events can be delivered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum EventsMode {
    /// Built-in delivery to dif.sh Cloud. The default.
    #[default]
    Cloud,
    /// The user's own handlers in `dif/events/{exposure,track}.ts`.
    Custom,
}

/// Build-time switches.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildConfig {
    /// Where the generated TS / context.json land.
    #[serde(default = "default_out")]
    pub out: String,
    /// Which validation classes hard-fail the build (as opposed to warn-only).
    #[serde(default = "default_fail_on")]
    pub fail_on: Vec<String>,
    /// If true, the generated files are committed to git. Default false.
    #[serde(default)]
    pub commit_generated: bool,
}

impl Default for BuildConfig {
    fn default() -> Self {
        Self {
            out: default_out(),
            fail_on: default_fail_on(),
            commit_generated: false,
        }
    }
}

fn default_out() -> String {
    paths::GENERATED_DIR.to_string()
}

fn default_fail_on() -> Vec<String> {
    vec![
        "conflict".to_string(),
        "orphan_ref".to_string(),
        "missing_owner".to_string(),
    ]
}

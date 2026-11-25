//! What `dif init` asks for: features and the app framework.
//! Pure logic only; the prompts live in [`super::ui`].

use clap::ValueEnum;
use dif_core::config::Features;

/// Opt-in features offered by the interactive features prompt.
/// Each one is a key in the config `features` block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Feature {
    /// Exposure and metric events.
    Analytics,
    /// Feature flags.
    Flags,
    /// A/B experiments.
    Experiments,
}

impl Feature {
    pub const ALL: [Feature; 3] = [Feature::Analytics, Feature::Flags, Feature::Experiments];

    /// The `--features` value and config key.
    pub fn flag_value(self) -> &'static str {
        match self {
            Feature::Analytics => "analytics",
            Feature::Flags => "flags",
            Feature::Experiments => "experiments",
        }
    }
}

/// The app framework. Picks the adapter package in the install step.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum Framework {
    /// Plain JS / TS, or any framework without an adapter.
    Sdk,
    /// React and Next.js: `@dif.sh/react`.
    React,
    /// Svelte 5 and SvelteKit: `@dif.sh/svelte`.
    Svelte,
    /// OpenFeature server SDK: `@dif.sh/openfeature`.
    Openfeature,
    /// Vercel Flags SDK: `@dif.sh/flags-sdk`.
    FlagsSdk,
}

impl Framework {
    pub const ALL: [Framework; 5] = [
        Framework::Sdk,
        Framework::React,
        Framework::Svelte,
        Framework::Openfeature,
        Framework::FlagsSdk,
    ];

    /// Label shown in the framework prompt.
    pub fn label(self) -> &'static str {
        match self {
            Framework::Sdk => "JavaScript / TypeScript",
            Framework::React => "React / Next.js",
            Framework::Svelte => "Svelte / SvelteKit",
            Framework::Openfeature => "OpenFeature",
            Framework::FlagsSdk => "Vercel Flags SDK",
        }
    }

    /// The npm packages this framework needs.
    pub fn packages(self) -> &'static [&'static str] {
        match self {
            Framework::Sdk => &["@dif.sh/sdk"],
            Framework::React => &["@dif.sh/sdk", "@dif.sh/react"],
            Framework::Svelte => &["@dif.sh/sdk", "@dif.sh/svelte"],
            Framework::Openfeature => &["@dif.sh/sdk", "@dif.sh/openfeature"],
            Framework::FlagsSdk => &["@dif.sh/sdk", "@dif.sh/flags-sdk"],
        }
    }
}

/// Map the chosen features onto the config `features` block.
pub fn features_for(picked: &[Feature]) -> Features {
    Features {
        analytics: picked.contains(&Feature::Analytics),
        flags: picked.contains(&Feature::Flags),
        experiments: picked.contains(&Feature::Experiments),
    }
}

/// The `--features` values for `features`, in a fixed order.
pub fn feature_flag_values(features: Features) -> Vec<String> {
    let on = [features.analytics, features.flags, features.experiments];
    Feature::ALL
        .into_iter()
        .zip(on)
        .filter(|(_, enabled)| *enabled)
        .map(|(f, _)| f.flag_value().to_string())
        .collect()
}

/// The `project:` name for dif/config.yaml and new Cloud projects.
/// An existing config wins, so a re-run keeps its name.
pub fn project_name(
    config_yaml: Option<&str>,
    package_json: Option<&str>,
    folder: Option<&str>,
) -> String {
    let existing = config_yaml
        .and_then(|text| serde_yaml::from_str::<dif_core::config::Config>(text).ok())
        .map(|config| config.project);
    let from_package = package_json
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|pkg| pkg["name"].as_str().map(String::from))
        .map(|name| match name.rsplit_once('/') {
            Some((_, bare)) => bare.trim().to_string(),
            None => name.trim().to_string(),
        });
    [existing, from_package, folder.map(String::from)]
        .into_iter()
        .flatten()
        .find(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "project".to_string())
}

/// Guess the framework from the text of a `package.json`.
/// Falls back to the plain SDK when nothing matches or parsing fails.
pub fn detect_framework(package_json: &str) -> Framework {
    let Ok(pkg) = serde_json::from_str::<serde_json::Value>(package_json) else {
        return Framework::Sdk;
    };
    let has = |name: &str| {
        ["dependencies", "devDependencies"]
            .iter()
            .any(|field| pkg.get(field).and_then(|d| d.get(name)).is_some())
    };
    // Adapters for flag SDKs are more specific than UI frameworks.
    if has("@openfeature/server-sdk") {
        Framework::Openfeature
    } else if has("flags") || has("@vercel/flags") {
        Framework::FlagsSdk
    } else if has("svelte") || has("@sveltejs/kit") {
        Framework::Svelte
    } else if has("react") || has("next") {
        Framework::React
    } else {
        Framework::Sdk
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_feature_maps_to_its_config_key() {
        assert_eq!(features_for(&Feature::ALL), Features::default());
        let f = features_for(&[Feature::Flags, Feature::Experiments]);
        assert!(!f.analytics && f.flags && f.experiments);
        let f = features_for(&[Feature::Analytics]);
        assert!(f.analytics && !f.flags && !f.experiments);
    }

    #[test]
    fn feature_flag_values_list_the_enabled_features() {
        assert_eq!(
            feature_flag_values(Features::default()),
            ["analytics", "flags", "experiments"]
        );
        assert_eq!(
            feature_flag_values(features_for(&[Feature::Flags, Feature::Experiments])),
            ["flags", "experiments"]
        );
    }

    #[test]
    fn feature_flag_values_round_trip_through_features_for() {
        let picked = [Feature::Analytics, Feature::Experiments];
        let names = feature_flag_values(features_for(&picked));
        let back: Vec<Feature> = Feature::ALL
            .into_iter()
            .filter(|f| names.iter().any(|n| n == f.flag_value()))
            .collect();
        assert_eq!(back, picked);
    }

    #[test]
    fn project_name_prefers_the_package_json_name() {
        let pkg = r#"{"name": "acme-site"}"#;
        assert_eq!(project_name(None, Some(pkg), Some("project")), "acme-site");
    }

    #[test]
    fn project_name_drops_the_npm_scope() {
        let pkg = r#"{"name": "@acme/site"}"#;
        assert_eq!(project_name(None, Some(pkg), Some("x")), "site");
    }

    #[test]
    fn project_name_falls_back_to_the_folder() {
        assert_eq!(project_name(None, None, Some("shop")), "shop");
        assert_eq!(project_name(None, Some("not json"), Some("shop")), "shop");
        assert_eq!(
            project_name(None, Some(r#"{"private": true}"#), Some("shop")),
            "shop"
        );
        assert_eq!(
            project_name(None, Some(r#"{"name": "  "}"#), Some("shop")),
            "shop"
        );
        assert_eq!(
            project_name(None, Some(r#"{"name": "@acme/"}"#), Some("shop")),
            "shop"
        );
    }

    #[test]
    fn project_name_has_a_last_resort() {
        assert_eq!(project_name(None, None, None), "project");
    }

    #[test]
    fn existing_config_keeps_its_project_name() {
        let config = "project: old-folder\ndefault_surface: home\n";
        let pkg = r#"{"name": "acme-site"}"#;
        assert_eq!(
            project_name(Some(config), Some(pkg), Some("x")),
            "old-folder"
        );
    }

    #[test]
    fn broken_existing_config_is_ignored() {
        let pkg = r#"{"name": "acme-site"}"#;
        assert_eq!(
            project_name(Some(": : :"), Some(pkg), Some("x")),
            "acme-site"
        );
    }

    #[test]
    fn every_framework_installs_the_core_sdk_first() {
        for fw in Framework::ALL {
            assert_eq!(fw.packages()[0], "@dif.sh/sdk", "{fw:?}");
        }
        assert_eq!(Framework::Sdk.packages(), ["@dif.sh/sdk"]);
        assert_eq!(
            Framework::Svelte.packages(),
            ["@dif.sh/sdk", "@dif.sh/svelte"]
        );
        assert_eq!(
            Framework::FlagsSdk.packages(),
            ["@dif.sh/sdk", "@dif.sh/flags-sdk"]
        );
    }

    #[test]
    fn detects_framework_from_dependencies() {
        let pkg = |deps: &str| format!(r#"{{"dependencies": {{{deps}}}}}"#);
        assert_eq!(
            detect_framework(&pkg(r#""@sveltejs/kit": "2""#)),
            Framework::Svelte
        );
        assert_eq!(
            detect_framework(&pkg(r#""svelte": "5""#)),
            Framework::Svelte
        );
        assert_eq!(
            detect_framework(&pkg(r#""next": "15", "react": "19""#)),
            Framework::React
        );
        assert_eq!(
            detect_framework(&pkg(r#""@openfeature/server-sdk": "1""#)),
            Framework::Openfeature
        );
        assert_eq!(
            detect_framework(&pkg(r#""flags": "4", "next": "15", "react": "19""#)),
            Framework::FlagsSdk
        );
    }

    #[test]
    fn detects_framework_from_dev_dependencies() {
        let pkg = r#"{"devDependencies": {"@sveltejs/kit": "2"}}"#;
        assert_eq!(detect_framework(pkg), Framework::Svelte);
    }

    #[test]
    fn unknown_or_broken_package_json_falls_back_to_sdk() {
        assert_eq!(
            detect_framework(r#"{"dependencies": {"vue": "3"}}"#),
            Framework::Sdk
        );
        assert_eq!(detect_framework("not json"), Framework::Sdk);
        assert_eq!(detect_framework(""), Framework::Sdk);
    }

    #[test]
    fn name_mentions_outside_dependencies_do_not_count() {
        let pkg = r#"{"name": "react-svelte-demo", "dependencies": {}}"#;
        assert_eq!(detect_framework(pkg), Framework::Sdk);
    }
}

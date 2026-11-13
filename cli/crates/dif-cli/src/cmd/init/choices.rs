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

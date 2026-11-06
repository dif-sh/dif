//! What `dif init` asks for: products and the app framework.
//! Pure logic only; the prompts live in [`super::ui`].

use clap::ValueEnum;
use dif_core::config::EventsMode;

/// Opt-in products offered by the interactive product prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Product {
    /// dif.sh Cloud: Pulse, Suggestions, History.
    Analytics,
    /// Exposure and metric events sent to the user's own tool.
    EventTracking,
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

/// Map the chosen products onto an events mode.
///
/// Analytics needs events in dif.sh Cloud, so it wins over custom
/// handlers. No products keeps cloud with no key: nothing is sent.
pub fn events_mode_for(products: &[Product]) -> EventsMode {
    if !products.contains(&Product::Analytics) && products.contains(&Product::EventTracking) {
        EventsMode::Custom
    } else {
        EventsMode::Cloud
    }
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
    fn analytics_selects_cloud_events() {
        assert_eq!(events_mode_for(&[Product::Analytics]), EventsMode::Cloud);
        assert_eq!(
            events_mode_for(&[Product::Analytics, Product::EventTracking]),
            EventsMode::Cloud
        );
    }

    #[test]
    fn event_tracking_alone_selects_custom_handlers() {
        assert_eq!(
            events_mode_for(&[Product::EventTracking]),
            EventsMode::Custom
        );
    }

    #[test]
    fn no_products_keeps_keyless_cloud_default() {
        assert_eq!(events_mode_for(&[]), EventsMode::Cloud);
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

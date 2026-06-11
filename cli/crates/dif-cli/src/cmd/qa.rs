//! `dif qa` — trace a user's assignment chain, emit a forced preview URL.
//!
//! Reads the workspace and calls [`dif_core::exclusion::resolve`] — the same
//! algorithm the runtime SDK uses. Output matches the design's CLI mockup:
//!
//! ```text
//! trace u_8131:
//!   • checkout-cta-v2 → variant_a (forced)
//!   • pricing-headline → value (bucket 71)
//! preview: http://localhost:3000?_dif=…
//! ```
//!
//! Always exits 0 — qa is a debugging tool, not a validator.

use super::CmdError;
use clap::Args as ClapArgs;
use console::style;
use dif_core::{
    audience::Attributes,
    exclusion::{self, Outcome, ResolutionInputs},
    Workspace,
};
use std::collections::HashMap;
use std::process::ExitCode;

/// `dif qa` flags.
#[derive(ClapArgs, Debug)]
pub struct Args {
    /// User id to trace. If omitted, a time-seeded synthetic id is generated
    /// so the same invocation gives a different bucket each run — useful for
    /// eyeballing typical bucket spread.
    #[arg(long)]
    pub user: Option<String>,

    /// Force a specific variant: `--force <experiment>=<variant>`. Repeatable.
    /// Forces bypass audience and exclusion.
    #[arg(long, value_name = "EXP=VARIANT")]
    pub force: Vec<String>,

    /// Set an audience attribute: `--attr <key>=<value>`. Repeatable.
    /// The value is parsed as YAML, so `true` / `42` / `US` all work.
    #[arg(long, value_name = "KEY=VALUE")]
    pub attr: Vec<String>,

    /// Base URL for the preview link. Default: `http://localhost:3000`.
    #[arg(long)]
    pub preview_url: Option<String>,
}

/// Entrypoint. See PLAN.md step 9.
pub fn run(args: Args, json: bool) -> Result<ExitCode, CmdError> {
    let cwd = std::env::current_dir()?;
    let workspace = Workspace::load(&cwd)?;

    let user_id = args.user.unwrap_or_else(random_user_id);
    let forces = parse_forces(&args.force)?;
    let attributes = parse_attrs(&args.attr)?;
    let preview_base = args
        .preview_url
        .unwrap_or_else(|| "http://localhost:3000".to_string());

    let resolution = exclusion::resolve(
        &workspace,
        ResolutionInputs {
            user_id: &user_id,
            attributes: &attributes,
            forces: &forces,
        },
    );

    let preview_url = if forces.is_empty() {
        None
    } else {
        Some(make_preview_url(&preview_base, &forces))
    };

    if json {
        print_json(&user_id, &resolution, preview_url.as_deref());
    } else {
        print_trace(&user_id, &resolution, preview_url.as_deref());
    }

    Ok(ExitCode::from(0))
}

// -- arg parsing --------------------------------------------------------------

fn parse_forces(args: &[String]) -> Result<HashMap<String, String>, CmdError> {
    let mut out = HashMap::new();
    for arg in args {
        let (k, v) = arg
            .split_once('=')
            .ok_or(CmdError::Other("--force expects <experiment>=<variant>"))?;
        out.insert(k.to_string(), v.to_string());
    }
    Ok(out)
}

fn parse_attrs(args: &[String]) -> Result<Attributes, CmdError> {
    let mut out = Attributes::new();
    for arg in args {
        let (k, v) = arg
            .split_once('=')
            .ok_or(CmdError::Other("--attr expects <key>=<value>"))?;
        let value: serde_yaml::Value = serde_yaml::from_str(v)
            .map_err(|_| CmdError::Other("--attr value is not valid YAML"))?;
        out.insert(k.to_string(), value);
    }
    Ok(out)
}

// -- preview URL --------------------------------------------------------------

/// Build a deterministic preview URL by sorting forces alphabetically and
/// percent-encoding the result. Stable output → stable diffs in screenshots
/// and test snapshots.
fn make_preview_url(base: &str, forces: &HashMap<String, String>) -> String {
    let mut pairs: Vec<(&String, &String)> = forces.iter().collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    let payload = pairs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(",");
    let encoded = percent_encode(&payload);
    let sep = if base.contains('?') { '&' } else { '?' };
    format!("{base}{sep}_dif={encoded}")
}

/// Minimal percent-encoding for query-string values. Reserves the unreserved
/// set per RFC 3986; everything else is `%XX` hex-encoded (UTF-8 bytes).
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

fn random_user_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("u_{nanos:x}")
}

// -- output -------------------------------------------------------------------

fn print_trace(user_id: &str, resolution: &exclusion::Resolution, preview_url: Option<&str>) {
    println!("trace {}:", style(user_id).bold());
    if resolution.rows.is_empty() {
        println!("  {}", style("(no active experiments)").dim());
    }
    for row in &resolution.rows {
        match &row.outcome {
            Outcome::Assigned { variant, bucket } => {
                println!(
                    "  • {} → {} {}",
                    row.experiment_id,
                    style(variant).bold(),
                    style(format!("(bucket {bucket})")).dim(),
                );
            }
            Outcome::Forced { variant } => {
                println!(
                    "  • {} → {} {}",
                    row.experiment_id,
                    style(variant).bold(),
                    style("(forced)").dim(),
                );
            }
            Outcome::AudienceMiss => {
                println!(
                    "  • {} {} {}",
                    row.experiment_id,
                    style("↛").dim(),
                    style("audience miss").dim(),
                );
            }
            Outcome::ExclusionLoser { winner } => {
                println!(
                    "  • {} {} {}",
                    row.experiment_id,
                    style("↛").dim(),
                    style(format!("exclusion loser (winner: {winner})")).dim(),
                );
            }
        }
    }
    if let Some(url) = preview_url {
        println!("{}: {}", style("preview").dim(), url);
        println!(
            "          {}",
            style("open in the app to force these variants — fires no exposure; ?_dif=off clears")
                .dim(),
        );
    }
}

fn print_json(user_id: &str, resolution: &exclusion::Resolution, preview_url: Option<&str>) {
    let assignments: Vec<serde_json::Value> = resolution
        .rows
        .iter()
        .map(|row| match &row.outcome {
            Outcome::Assigned { variant, bucket } => serde_json::json!({
                "experiment": row.experiment_id,
                "surface": row.surface,
                "outcome": "assigned",
                "variant": variant,
                "bucket": bucket,
            }),
            Outcome::Forced { variant } => serde_json::json!({
                "experiment": row.experiment_id,
                "surface": row.surface,
                "outcome": "forced",
                "variant": variant,
            }),
            Outcome::AudienceMiss => serde_json::json!({
                "experiment": row.experiment_id,
                "surface": row.surface,
                "outcome": "audience_miss",
            }),
            Outcome::ExclusionLoser { winner } => serde_json::json!({
                "experiment": row.experiment_id,
                "surface": row.surface,
                "outcome": "exclusion_loser",
                "winner": winner,
            }),
        })
        .collect();
    let payload = serde_json::json!({
        "user_id": user_id,
        "assignments": assignments,
        "preview_url": preview_url,
    });
    println!("{}", serde_json::to_string_pretty(&payload).unwrap());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_force_args() {
        let args = vec!["a=variant_a".to_string(), "b=control".to_string()];
        let forces = parse_forces(&args).unwrap();
        assert_eq!(forces.get("a"), Some(&"variant_a".to_string()));
        assert_eq!(forces.get("b"), Some(&"control".to_string()));
    }

    #[test]
    fn rejects_force_without_equals() {
        assert!(parse_forces(&["bogus".to_string()]).is_err());
    }

    #[test]
    fn parses_attr_yaml_values() {
        let args = vec![
            "country=US".to_string(),
            "returning_visitor=true".to_string(),
            "age=42".to_string(),
        ];
        let attrs = parse_attrs(&args).unwrap();
        assert_eq!(attrs.get("country").and_then(|v| v.as_str()), Some("US"));
        assert_eq!(
            attrs.get("returning_visitor").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(attrs.get("age").and_then(|v| v.as_i64()), Some(42));
    }

    #[test]
    fn percent_encodes_specials() {
        assert_eq!(percent_encode("simple"), "simple");
        assert_eq!(percent_encode("a=b"), "a%3Db");
        assert_eq!(percent_encode("a,b"), "a%2Cb");
        assert_eq!(percent_encode("with space"), "with%20space");
    }

    #[test]
    fn preview_url_is_sorted_and_encoded() {
        let mut forces = HashMap::new();
        forces.insert("b-exp".to_string(), "v2".to_string());
        forces.insert("a-exp".to_string(), "v1".to_string());
        let url = make_preview_url("http://app.local", &forces);
        assert_eq!(url, "http://app.local?_dif=a-exp%3Dv1%2Cb-exp%3Dv2");
    }

    #[test]
    fn preview_url_appends_to_existing_query() {
        let mut forces = HashMap::new();
        forces.insert("e".to_string(), "v".to_string());
        let url = make_preview_url("http://app.local?x=1", &forces);
        assert!(url.contains("?x=1&_dif="));
    }
}

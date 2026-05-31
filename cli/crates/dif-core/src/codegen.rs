//! Codegen for `.dif/generated/client.ts`.
//!
//! Output is **deterministic**: same workspace input ⇒ byte-identical output.
//! No `prettier`, no `dprint` — we own the writer so the format is stable and
//! reviewable in PR diffs. The contract between Rust and TS is this one file
//! plus `.dif/context.json`; no FFI, no NAPI, no WASM at the runtime boundary.
//!
//! The file shape:
//! 1. Generated-by banner (with crate version — no timestamp, so PR diffs
//!    only churn on real changes).
//! 2. `import { __register } from "@dif.sh/sdk";`
//! 3. One `__register({...})` call per active experiment, sorted by id.
//!
//! Each `__register` call carries: id, surface, variants (as a `const` array
//! so V can be inferred as a string-literal union in the SDK), salt (hex),
//! weights, exclusion group, and an inlined audience predicate compiled from
//! the YAML.

use crate::{
    audience_files::AudienceFile,
    bucket,
    parse::ParsedExperiment,
    spec::{Audience, Experiment, Status, Variant},
    workspace::Workspace,
    VERSION,
};
use serde_yaml::Value;
use std::collections::HashSet;
use std::path::Path;

/// Emit the generated TypeScript client to `out_dir/client.ts`. Creates the
/// directory if it doesn't exist.
pub fn emit_client(workspace: &Workspace, out_dir: &Path) -> std::io::Result<()> {
    let source = render_client(workspace);
    std::fs::create_dir_all(out_dir)?;
    std::fs::write(out_dir.join("client.ts"), source)?;
    Ok(())
}

/// Emit the wired audience-attribute bag to `out_dir/audiences.ts`. Imports
/// only the audience files referenced by an active experiment's predicate
/// (compile-time tree-shake).
pub fn emit_audiences(workspace: &Workspace, out_dir: &Path) -> std::io::Result<()> {
    let source = render_audiences(workspace, out_dir);
    std::fs::create_dir_all(out_dir)?;
    std::fs::write(out_dir.join("audiences.ts"), source)?;
    Ok(())
}

/// Render the audiences module as a string. Pulled out so tests can snapshot
/// the output without touching the filesystem. `out_dir` is required so the
/// relative import paths back to `audiences/*.ts` can be computed.
pub fn render_audiences(workspace: &Workspace, out_dir: &Path) -> String {
    let referenced = referenced_attribute_names(workspace);
    let included: Vec<&AudienceFile> = {
        let mut v: Vec<&AudienceFile> = workspace
            .audiences
            .iter()
            .filter(|a| referenced.contains(a.slug.as_str()))
            .collect();
        v.sort_by(|a, b| a.slug.cmp(&b.slug));
        v
    };
    let prefix = relative_import_prefix(out_dir, &workspace.root);

    let mut out = String::new();
    out.push_str(&audiences_banner());
    out.push_str("\nimport type { AttributeBag } from \"@dif.sh/sdk\";\n");

    for file in &included {
        let var = camel_case(&file.slug);
        let path = format!("{prefix}audiences/{}", file.slug);
        out.push_str(&format!("import {var} from \"{}\";\n", js_escape(&path)));
    }

    out.push_str("\n");
    out.push_str("/**\n");
    out.push_str(" * Wired audience attribute bag. Each value is computed by the matching\n");
    out.push_str(" * `audiences/<slug>.ts` resolver. Anything in `overrides` wins on overlap\n");
    out.push_str(" * — supply app-context attributes (`plan`, `user_role`, …) here.\n");
    out.push_str(" */\n");
    out.push_str("export function attributes(overrides: AttributeBag = {}): AttributeBag {\n");
    out.push_str("  return {\n");
    for file in &included {
        let var = camel_case(&file.slug);
        out.push_str(&format!(
            "    \"{}\": {var}(),\n",
            js_escape(&file.slug)
        ));
    }
    out.push_str("    ...overrides,\n");
    out.push_str("  };\n");
    out.push_str("}\n");
    out
}

/// Walk active experiments and collect the set of audience attribute names
/// they reference. This is the tree-shake input for `emit_audiences`.
fn referenced_attribute_names(workspace: &Workspace) -> HashSet<String> {
    let mut out = HashSet::new();
    for parsed in workspace
        .active
        .iter()
        .filter(|p| matches!(p.spec.status, Status::Active))
    {
        for pred in parsed
            .spec
            .audience
            .include
            .iter()
            .chain(parsed.spec.audience.exclude.iter())
        {
            for (key, _) in pred.0.iter() {
                if let Some(name) = key.as_str() {
                    out.insert(name.to_string());
                }
            }
        }
    }
    out
}

/// Number of `../` segments needed to walk from `out_dir` back up to
/// `workspace_root`, so the generated `audiences.ts` can `import` siblings of
/// the root via a relative path. Assumes `out_dir` is under `workspace_root`
/// — anything else is a misconfiguration we surface in the generated import
/// path so the build breaks loudly instead of emitting silently-wrong code.
fn relative_import_prefix(out_dir: &Path, workspace_root: &Path) -> String {
    match out_dir.strip_prefix(workspace_root) {
        Ok(rel) => "../".repeat(rel.components().count()),
        Err(_) => "__OUT_DIR_OUTSIDE_WORKSPACE__/".to_string(),
    }
}

/// Render the full file contents as a string. Pulled out so tests can snapshot
/// the output without touching the filesystem.
pub fn render_client(workspace: &Workspace) -> String {
    let mut active: Vec<&ParsedExperiment> = workspace
        .active
        .iter()
        .filter(|p| matches!(p.spec.status, Status::Active))
        .collect();
    active.sort_by(|a, b| a.spec.id.cmp(&b.spec.id));

    let mut out = String::new();
    out.push_str(&banner());
    out.push_str("\nimport { __register } from \"@dif.sh/sdk\";\n\n");
    for parsed in &active {
        out.push_str(&render_experiment_export(&parsed.spec));
        out.push_str("\n\n");
    }
    out
}

/// Render one experiment as a `__register({...})` call. Pub for unit testing.
pub fn render_experiment_export(exp: &Experiment) -> String {
    let salt = hex_salt(&bucket::salt_for(&exp.id));
    let variants = render_variant_list(&exp.variants);
    let weights = render_weights(&exp.variants);
    let exclusion = render_optional_string(&exp.exclusion_group);
    let audience = render_audience(&exp.audience);

    let mut out = String::new();
    out.push_str("__register({\n");
    out.push_str(&format!("  id: \"{}\",\n", js_escape(&exp.id)));
    out.push_str(&format!("  surface: \"{}\",\n", js_escape(&exp.surface)));
    out.push_str(&format!("  variants: {variants} as const,\n"));
    out.push_str(&format!("  salt: \"{salt}\",\n"));
    out.push_str(&format!("  weights: {weights},\n"));
    out.push_str(&format!("  exclusionGroup: {exclusion},\n"));
    out.push_str(&format!("  audience: {audience},\n"));
    out.push_str("});");
    out
}

/// Convert a kebab-case experiment id into a camelCase TypeScript identifier.
/// Not currently used by the emitter (the runtime API is string-keyed) but
/// kept here for the future "typed named exports" feature mentioned in PLAN.
pub fn camel_case(kebab: &str) -> String {
    let mut out = String::with_capacity(kebab.len());
    let mut upper_next = false;
    for c in kebab.chars() {
        if c == '-' || c == '_' {
            upper_next = true;
        } else if upper_next {
            out.push(c.to_ascii_uppercase());
            upper_next = false;
        } else {
            out.push(c);
        }
    }
    out
}

// -- helpers ------------------------------------------------------------------

fn banner() -> String {
    format!(
        "// generated by dif v{VERSION} — DO NOT EDIT.\n\
         //\n\
         // Regenerated by `dif build` on every run. Edits will be overwritten.\n\
         // Import this module once at app boot to populate the runtime registry\n\
         // that `dif(\"id\", branches)` consults at the call site.\n"
    )
}

fn audiences_banner() -> String {
    format!(
        "// generated by dif v{VERSION} — DO NOT EDIT.\n\
         //\n\
         // Regenerated by `dif build` on every run. Edits will be overwritten.\n\
         // Imports only the `audiences/<slug>.ts` resolvers referenced by an\n\
         // active experiment. Pass `attributes` (optionally with overrides)\n\
         // to `dif.init()` so the SDK can evaluate audience predicates at\n\
         // every `dif()` call site.\n"
    )
}

fn render_variant_list(variants: &[Variant]) -> String {
    let items: Vec<String> = variants
        .iter()
        .map(|v| format!("\"{}\"", js_escape(&v.id)))
        .collect();
    format!("[{}]", items.join(", "))
}

fn render_weights(variants: &[Variant]) -> String {
    let items: Vec<String> = variants
        .iter()
        .map(|v| format!("\"{}\": {}", js_escape(&v.id), v.weight))
        .collect();
    format!("{{ {} }}", items.join(", "))
}

fn render_optional_string(opt: &Option<String>) -> String {
    match opt {
        Some(s) => format!("\"{}\"", js_escape(s)),
        None => "null".to_string(),
    }
}

/// Compile an audience to an arrow function. Empty audiences become
/// `() => true`; otherwise we emit one `if (...) return false;` per
/// constraint and `return true;` at the end.
fn render_audience(audience: &Audience) -> String {
    if audience.include.is_empty() && audience.exclude.is_empty() {
        return "() => true".to_string();
    }

    let mut body = String::new();
    body.push_str("(attrs) => {\n");
    for pred in &audience.include {
        for (key, value) in pred.0.iter() {
            let Some(name) = key.as_str() else { continue };
            match value {
                Value::Sequence(seq) => {
                    let items: Vec<String> = seq.iter().map(render_js_value).collect();
                    body.push_str(&format!(
                        "    if (![{}].includes(attrs[\"{}\"])) return false;\n",
                        items.join(", "),
                        js_escape(name)
                    ));
                }
                _ => {
                    body.push_str(&format!(
                        "    if (attrs[\"{}\"] !== {}) return false;\n",
                        js_escape(name),
                        render_js_value(value)
                    ));
                }
            }
        }
    }
    for pred in &audience.exclude {
        for (key, value) in pred.0.iter() {
            let Some(name) = key.as_str() else { continue };
            match value {
                Value::Sequence(seq) => {
                    let items: Vec<String> = seq.iter().map(render_js_value).collect();
                    body.push_str(&format!(
                        "    if ([{}].includes(attrs[\"{}\"])) return false;\n",
                        items.join(", "),
                        js_escape(name)
                    ));
                }
                _ => {
                    body.push_str(&format!(
                        "    if (attrs[\"{}\"] === {}) return false;\n",
                        js_escape(name),
                        render_js_value(value)
                    ));
                }
            }
        }
    }
    body.push_str("    return true;\n");
    body.push_str("  }");
    body
}

fn render_js_value(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => {
            if *b {
                "true".into()
            } else {
                "false".into()
            }
        }
        Value::Number(n) => n.to_string(),
        Value::String(s) => format!("\"{}\"", js_escape(s)),
        Value::Sequence(seq) => {
            let items: Vec<String> = seq.iter().map(render_js_value).collect();
            format!("[{}]", items.join(", "))
        }
        // Mappings and tagged values shouldn't appear in audience predicate
        // *values* (only as the predicates themselves). Emit `null` so the
        // generated file still type-checks; validate.rs catches the real
        // problem.
        Value::Mapping(_) | Value::Tagged(_) => "null".to_string(),
    }
}

fn js_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

fn hex_salt(salt: &[u8; 16]) -> String {
    let mut out = String::with_capacity(32);
    for b in salt {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::{BucketingConfig, BuildConfig, Config, ExposureConfig, FireAt},
        parse::{parse_experiment_str, ParsedExperiment},
    };
    use std::path::PathBuf;

    fn parse(yaml_body: &str) -> Experiment {
        let source = format!("---\n{yaml_body}\n---\n");
        parse_experiment_str(&source).expect("parse").spec
    }

    fn parse_active(yaml_body: &str, id: &str) -> ParsedExperiment {
        let source = format!("---\n{yaml_body}\n---\n");
        let mut p = parse_experiment_str(&source).expect("parse");
        p.path = PathBuf::from(format!("experiments/active/{id}.md"));
        p
    }

    fn empty_config() -> Config {
        Config {
            project: "test".into(),
            default_surface: "home".into(),
            audience_attributes: vec![],
            bucketing: BucketingConfig {
                id: "user_id".into(),
                fallback: "anon_cookie".into(),
            },
            exposure: ExposureConfig {
                sink: "webhook".into(),
                fire_at: FireAt::Render,
            },
            build: BuildConfig::default(),
        }
    }

    fn ws_with(
        active: Vec<ParsedExperiment>,
        audiences: Vec<AudienceFile>,
        root: PathBuf,
    ) -> Workspace {
        Workspace {
            root,
            config: empty_config(),
            active,
            concluded: vec![],
            surfaces: vec![],
            audiences,
            call_sites: vec![],
            parse_errors: vec![],
        }
    }

    const SIMPLE_EXP: &str = "id: checkout-cta-v2
status: active
owner: ada@acme.dev
surface: checkout
hypothesis: h
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
metrics:
  primary: m
exclusion_group: checkout-copy
created: 2026-01-01";

    #[test]
    fn camel_case_handles_kebab() {
        assert_eq!(camel_case("checkout-cta-v2"), "checkoutCtaV2");
        assert_eq!(camel_case("simple"), "simple");
        assert_eq!(camel_case("multi-dash-name"), "multiDashName");
        assert_eq!(camel_case("snake_case"), "snakeCase");
    }

    #[test]
    fn hex_salt_is_32_chars() {
        let exp = parse(SIMPLE_EXP);
        let salt = bucket::salt_for(&exp.id);
        let hex = hex_salt(&salt);
        assert_eq!(hex.len(), 32);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn empty_audience_is_constant_true() {
        let exp = parse(SIMPLE_EXP);
        let s = render_audience(&exp.audience);
        assert_eq!(s, "() => true");
    }

    #[test]
    fn include_scalar_renders_strict_equality() {
        let exp = parse(&format!(
            "{SIMPLE_EXP}\naudience:\n  include:\n    - country: US"
        ));
        let s = render_audience(&exp.audience);
        assert!(s.contains("attrs[\"country\"] !== \"US\""));
        assert!(s.contains("return true;"));
    }

    #[test]
    fn include_sequence_renders_includes_check() {
        let exp = parse(&format!(
            "{SIMPLE_EXP}\naudience:\n  include:\n    - country: [US, CA]"
        ));
        let s = render_audience(&exp.audience);
        assert!(s.contains("[\"US\", \"CA\"].includes(attrs[\"country\"])"));
    }

    #[test]
    fn exclude_renders_disqualification() {
        let exp = parse(&format!(
            "{SIMPLE_EXP}\naudience:\n  exclude:\n    - plan: free"
        ));
        let s = render_audience(&exp.audience);
        assert!(s.contains("attrs[\"plan\"] === \"free\""));
    }

    #[test]
    fn register_call_contains_required_fields() {
        let exp = parse(SIMPLE_EXP);
        let s = render_experiment_export(&exp);
        assert!(s.starts_with("__register({"));
        assert!(s.contains("id: \"checkout-cta-v2\""));
        assert!(s.contains("surface: \"checkout\""));
        assert!(s.contains("variants: [\"control\", \"variant_a\"] as const"));
        assert!(s.contains("salt: \""));
        assert!(s.contains("weights: { \"control\": 50, \"variant_a\": 50 }"));
        assert!(s.contains("exclusionGroup: \"checkout-copy\""));
        assert!(s.contains("audience:"));
        assert!(s.ends_with("});"));
    }

    #[test]
    fn deterministic_output() {
        let exp = parse(SIMPLE_EXP);
        let a = render_experiment_export(&exp);
        let b = render_experiment_export(&exp);
        assert_eq!(a, b, "codegen must be deterministic");
    }

    #[test]
    fn js_escape_handles_specials() {
        assert_eq!(js_escape("plain"), "plain");
        assert_eq!(js_escape("with \"quote\""), "with \\\"quote\\\"");
        assert_eq!(js_escape("back\\slash"), "back\\\\slash");
        assert_eq!(js_escape("line\nbreak"), "line\\nbreak");
    }

    // -- audiences module -----------------------------------------------------

    #[test]
    fn audiences_tree_shake_skips_unreferenced() {
        // Experiment references device_type only. locale is on disk but
        // unreferenced — must NOT appear in the generated module.
        let exp = parse_active(
            "id: a
status: active
owner: ada@acme.dev
surface: checkout
hypothesis: h
audience:
  include:
    - device_type: mobile
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
metrics:
  primary: m
created: 2026-01-01",
            "a",
        );
        let root = PathBuf::from("/tmp/dif-test-ws");
        let audiences = vec![
            AudienceFile {
                slug: "device_type".into(),
                path: root.join("audiences/device_type.ts"),
            },
            AudienceFile {
                slug: "locale".into(),
                path: root.join("audiences/locale.ts"),
            },
        ];
        let ws = ws_with(vec![exp], audiences, root.clone());
        let out_dir = root.join(".dif").join("generated");
        let rendered = render_audiences(&ws, &out_dir);

        assert!(rendered.contains("import deviceType from \"../../audiences/device_type\""));
        assert!(!rendered.contains("locale"));
        assert!(rendered.contains("export function attributes(overrides: AttributeBag = {})"));
        assert!(rendered.contains("\"device_type\": deviceType(),"));
        assert!(rendered.contains("...overrides,"));
    }

    #[test]
    fn audiences_module_renders_with_no_references() {
        // No experiments → no referenced attributes → empty bag, still valid module.
        let root = PathBuf::from("/tmp/dif-test-ws");
        let ws = ws_with(vec![], vec![], root.clone());
        let out_dir = root.join(".dif").join("generated");
        let rendered = render_audiences(&ws, &out_dir);

        assert!(rendered.contains("export function attributes(overrides: AttributeBag = {})"));
        assert!(rendered.contains("...overrides,"));
        // No imports beyond the type import.
        let import_count = rendered.matches("import ").count();
        assert_eq!(import_count, 1, "expected only the type import");
    }

    #[test]
    fn audiences_handles_exclude_predicates() {
        let exp = parse_active(
            "id: a
status: active
owner: ada@acme.dev
surface: checkout
hypothesis: h
audience:
  exclude:
    - plan: free
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
metrics:
  primary: m
created: 2026-01-01",
            "a",
        );
        let root = PathBuf::from("/tmp/dif-test-ws");
        let audiences = vec![AudienceFile {
            slug: "plan".into(),
            path: root.join("audiences/plan.ts"),
        }];
        let ws = ws_with(vec![exp], audiences, root.clone());
        let out_dir = root.join(".dif").join("generated");
        let rendered = render_audiences(&ws, &out_dir);

        assert!(rendered.contains("import plan from \"../../audiences/plan\""));
        assert!(rendered.contains("\"plan\": plan(),"));
    }

    #[test]
    fn audiences_deterministic_output() {
        let exp = parse_active(
            "id: a
status: active
owner: ada@acme.dev
surface: checkout
hypothesis: h
audience:
  include:
    - device_type: mobile
    - locale: en-US
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
metrics:
  primary: m
created: 2026-01-01",
            "a",
        );
        let root = PathBuf::from("/tmp/dif-test-ws");
        let audiences = vec![
            AudienceFile {
                slug: "locale".into(),
                path: root.join("audiences/locale.ts"),
            },
            AudienceFile {
                slug: "device_type".into(),
                path: root.join("audiences/device_type.ts"),
            },
        ];
        let ws = ws_with(vec![exp], audiences, root.clone());
        let out_dir = root.join(".dif").join("generated");
        let a = render_audiences(&ws, &out_dir);
        let b = render_audiences(&ws, &out_dir);
        assert_eq!(a, b);
        // device_type comes before locale alphabetically.
        let device_pos = a.find("device_type").unwrap();
        let locale_pos = a.find("locale").unwrap();
        assert!(
            device_pos < locale_pos,
            "expected slug-sorted imports for stable PR diffs"
        );
    }

    #[test]
    fn relative_import_prefix_depth() {
        let root = PathBuf::from("/tmp/dif-ws");
        assert_eq!(
            relative_import_prefix(&root.join(".dif").join("generated"), &root),
            "../../"
        );
        assert_eq!(
            relative_import_prefix(&root.join("dist").join("dif").join("out"), &root),
            "../../../"
        );
        assert_eq!(relative_import_prefix(&root, &root), "");
    }
}

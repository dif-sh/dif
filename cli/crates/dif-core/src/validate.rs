//! Workspace validation — every check `dif validate` runs.
//!
//! Validators are intentionally cheap and collect-all (not fail-fast) so the
//! customer sees every problem in one run. The cost is bounded by workspace
//! size, which is bounded by what fits in a `grep`.
//!
//! Diagnostic codes:
//! - `E001` invalid frontmatter / YAML
//! - `E003` owner is not a valid email
//! - `E004` surface does not exist
//! - `E005` variant weights do not sum to 100
//! - `E006` audience attribute not declared in config
//! - `E007` exclusion conflict (same surface, no shared `exclusion_group`)
//! - `E008` declared audience attribute has no `dif/audiences/<name>.ts` file
//! - `W001` orphan ref (call site references no active experiment)
//! - `W002` orphan audience file (not declared in `audience_attributes`)
//! - `W003` legacy `exposure:` block (superseded by `events:`)

use crate::{
    diag::{Diagnostic, Report},
    exclusion,
    parse::ParsedExperiment,
    paths,
    workspace::{relative_path, Workspace},
};
use regex::Regex;
use std::collections::HashSet;

/// Run every validation pass against the workspace. Returns the full report;
/// the caller decides whether errors abort the build.
pub fn run(workspace: &Workspace) -> Report {
    let mut report = Report::default();
    schema(workspace, &mut report);
    owner(workspace, &mut report);
    surface_exists(workspace, &mut report);
    variant_weights(workspace, &mut report);
    audience_attrs_declared(workspace, &mut report);
    audience_files_paired(workspace, &mut report);
    exclusion_overlap(workspace, &mut report);
    orphan_refs(workspace, &mut report);
    legacy_exposure_block(workspace, &mut report);
    sort_report(&mut report);
    report
}

/// Frontmatter schema check — these were collected at load time. We just
/// fold them into the report.
pub fn schema(workspace: &Workspace, report: &mut Report) {
    for e in &workspace.parse_errors {
        report.errors.push(e.clone());
    }
}

/// `owner` must be a syntactically valid email.
pub fn owner(workspace: &Workspace, report: &mut Report) {
    // Permissive email check: one `@`, at least one `.` after it. Not RFC,
    // just enough to reject `unknown` / empty / obvious typos.
    let email = Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").expect("static regex");
    for parsed in workspace.active.iter().chain(workspace.concluded.iter()) {
        if !email.is_match(&parsed.spec.owner) {
            report.errors.push(simple_error(
                "E003",
                format!("`owner` is not a valid email: `{}`", parsed.spec.owner),
                parsed,
                workspace,
                Some("Use `name@example.com` format."),
            ));
        }
    }
}

/// `surface` on every experiment must resolve to a loaded surface.
pub fn surface_exists(workspace: &Workspace, report: &mut Report) {
    let surfaces: HashSet<&str> = workspace
        .surfaces
        .iter()
        .map(|s| s.surface.id.as_str())
        .collect();
    for parsed in workspace.active.iter().chain(workspace.concluded.iter()) {
        if !surfaces.contains(parsed.spec.surface.as_str()) {
            report.errors.push(simple_error(
                "E004",
                format!("surface `{}` does not exist", parsed.spec.surface),
                parsed,
                workspace,
                Some(&format!(
                    "Create `dif/surfaces/{}.md` or correct the `surface:` field.",
                    parsed.spec.surface
                )),
            ));
        }
    }
}

/// Variant weights must sum to 100. The runtime bucketing math depends on
/// this; we refuse to compile otherwise.
pub fn variant_weights(workspace: &Workspace, report: &mut Report) {
    for parsed in workspace.active.iter().chain(workspace.concluded.iter()) {
        let sum: u32 = parsed
            .spec
            .variants
            .iter()
            .map(|v| u32::from(v.weight))
            .sum();
        if sum != 100 {
            report.errors.push(simple_error(
                "E005",
                format!("variant weights sum to {sum}, expected 100"),
                parsed,
                workspace,
                Some("Distribute the variants so the weights total 100."),
            ));
        }
    }
}

/// Every audience attribute must be declared in `dif/config.yaml`. This is
/// the "no new DSL" rule made concrete.
pub fn audience_attrs_declared(workspace: &Workspace, report: &mut Report) {
    let declared: HashSet<&str> = workspace
        .config
        .audience_attributes
        .iter()
        .map(|a| a.name.as_str())
        .collect();
    for parsed in workspace.active.iter().chain(workspace.concluded.iter()) {
        let predicates = parsed
            .spec
            .audience
            .include
            .iter()
            .chain(parsed.spec.audience.exclude.iter());
        let mut reported_here: HashSet<String> = HashSet::new();
        for pred in predicates {
            for (key, _value) in pred.0.iter() {
                if let Some(name) = key.as_str() {
                    if !declared.contains(name) && reported_here.insert(name.to_string()) {
                        report.errors.push(simple_error(
                            "E006",
                            format!(
                                "audience attribute `{name}` is not declared in dif/config.yaml"
                            ),
                            parsed,
                            workspace,
                            Some(
                                "Add it to `audience_attributes` in your config, or remove this predicate.",
                            ),
                        ));
                    }
                }
            }
        }
    }
}

/// Pair every declared `audience_attributes` entry with an
/// `dif/audiences/<name>.ts` resolver file, and vice versa. Mismatches in either
/// direction surface here:
///
/// - `E008` (error): declared attribute, no file. The runtime would have no
///   way to compute the value, so this fails the build.
/// - `W002` (warning): file exists, not declared. Could be an in-progress
///   draft or a forgotten cleanup — surfaced but non-fatal.
pub fn audience_files_paired(workspace: &Workspace, report: &mut Report) {
    let declared: HashSet<&str> = workspace
        .config
        .audience_attributes
        .iter()
        .map(|a| a.name.as_str())
        .collect();
    let on_disk: HashSet<&str> = workspace
        .audiences
        .iter()
        .map(|a| a.slug.as_str())
        .collect();

    for attr in &workspace.config.audience_attributes {
        if !on_disk.contains(attr.name.as_str()) {
            report.errors.push(Diagnostic {
                code: "E008".to_string(),
                message: format!(
                    "audience attribute `{}` has no implementation at `dif/audiences/{}.ts`",
                    attr.name, attr.name
                ),
                file: paths::CONFIG_FILE.to_string(),
                line: 1,
                column: 1,
                help: Some(format!(
                    "Create `dif/audiences/{}.ts` exporting a default resolver, or remove the entry from `audience_attributes`. Run `dif scaffold-audiences` to pull in the starter set.",
                    attr.name
                )),
            });
        }
    }

    for file in &workspace.audiences {
        if !declared.contains(file.slug.as_str()) {
            report.warnings.push(Diagnostic {
                code: "W002".to_string(),
                message: format!(
                    "audience file `dif/audiences/{}.ts` has no matching entry in `audience_attributes`",
                    file.slug
                ),
                file: relative_path(&file.path, &workspace.root),
                line: 1,
                column: 1,
                help: Some(format!(
                    "Add `{{ name: {}, type: ... }}` to `audience_attributes` in `dif/config.yaml`, or delete the file if unused.",
                    file.slug
                )),
            });
        }
    }
}

/// Two active experiments targeting the same surface must either declare a
/// shared `exclusion_group` (runtime resolves with priority) OR have
/// provably-disjoint audiences (`audience::audiences_disjoint`). Otherwise
/// the runtime has no basis for picking one when a user matches both, and we
/// want that decision explicit in the file, not implicit in load order.
///
/// Delegates the actual graph walk to [`crate::exclusion::detect_conflicts`].
pub fn exclusion_overlap(workspace: &Workspace, report: &mut Report) {
    let conflicts = exclusion::detect_conflicts(workspace);
    for conflict in conflicts {
        // Point the diagnostic at the lexically-first experiment's file.
        let anchor = workspace
            .active
            .iter()
            .find(|p| p.spec.id == conflict.a)
            .expect("conflict references unknown experiment");
        report.errors.push(simple_error(
            "E007",
            format!(
                "experiments `{}` and `{}` both target surface `{}` without a shared exclusion_group, and their audiences are not provably disjoint",
                conflict.a, conflict.b, conflict.surface
            ),
            anchor,
            workspace,
            Some("Add the same `exclusion_group:` value to both, narrow one of the audiences so they're provably disjoint, or change one of their `surface:` fields."),
        ));
    }
}

/// Every `dif("<id>", ...)` call site must map to an active experiment.
/// Orphans are warnings, not errors — they're catch-able with cleanup.
pub fn orphan_refs(workspace: &Workspace, report: &mut Report) {
    let active_ids: HashSet<&str> = workspace
        .active
        .iter()
        .map(|p| p.spec.id.as_str())
        .collect();
    for call_site in &workspace.call_sites {
        if !active_ids.contains(call_site.experiment_id.as_str()) {
            report.warnings.push(Diagnostic {
                code: "W001".to_string(),
                message: format!(
                    "orphan ref: `{}` is not an active experiment",
                    call_site.experiment_id
                ),
                file: relative_path(&call_site.file, &workspace.root),
                line: call_site.line,
                column: 1,
                help: Some("Either create the experiment or remove the dif() call.".to_string()),
            });
        }
    }
}

/// A legacy `exposure:` block in `dif/config.yaml` is no longer read — event
/// delivery is configured by `events:` now. The old key is ignored (and the
/// workspace defaults to cloud), but we surface a warning so the customer knows
/// to migrate rather than wondering why their sink setting does nothing.
pub fn legacy_exposure_block(workspace: &Workspace, report: &mut Report) {
    if workspace.config.exposure.is_some() {
        report.warnings.push(Diagnostic {
            code: "W003".to_string(),
            message: "legacy `exposure:` block is ignored; event delivery is configured by `events:` now".to_string(),
            file: paths::CONFIG_FILE.to_string(),
            line: 1,
            column: 1,
            help: Some(
                "Replace the `exposure:` block with `events:` (`mode: cloud` or `mode: custom`). See https://dif.sh/docs/events/. Defaulting to cloud for now.".to_string(),
            ),
        });
    }
}

fn simple_error(
    code: &str,
    message: String,
    parsed: &ParsedExperiment,
    workspace: &Workspace,
    help: Option<&str>,
) -> Diagnostic {
    Diagnostic {
        code: code.to_string(),
        message,
        file: relative_path(&parsed.path, &workspace.root),
        // PLAN step 4 lands without per-field source spans. Pointed at line 1
        // for now; future work threads YAML key positions through the parser.
        line: 1,
        column: 1,
        help: help.map(String::from),
    }
}

fn sort_report(report: &mut Report) {
    let sort_key = |d: &Diagnostic| {
        (
            d.file.clone(),
            d.line,
            d.column,
            d.code.clone(),
            d.message.clone(),
        )
    };
    report.errors.sort_by_key(sort_key);
    report.warnings.sort_by_key(sort_key);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::{BucketingConfig, BuildConfig, Config},
        parse::{parse_experiment_str, ParsedSurface},
        spec::Surface,
    };
    use std::path::PathBuf;

    fn empty_config() -> Config {
        Config {
            project: "test".into(),
            default_surface: "home".into(),
            audience_attributes: vec![],
            bucketing: BucketingConfig {
                id: "user_id".into(),
                fallback: "anon_cookie".into(),
            },
            events: None,
            exposure: None,
            build: BuildConfig::default(),
        }
    }

    fn make_surface(id: &str) -> ParsedSurface {
        ParsedSurface {
            surface: Surface {
                id: id.to_string(),
                description: String::new(),
                landmines: vec![],
                learnings: vec![],
            },
            source: String::new(),
            path: PathBuf::from(format!("dif/surfaces/{id}.md")),
        }
    }

    fn parse(yaml_body: &str, id: &str) -> ParsedExperiment {
        let source = format!("---\n{yaml_body}\n---\n");
        let mut p = parse_experiment_str(&source).expect("test fixture parses");
        p.path = PathBuf::from(format!("dif/experiments/active/{id}.md"));
        p
    }

    fn make_workspace(
        exps: Vec<ParsedExperiment>,
        surfaces: Vec<ParsedSurface>,
        config: Config,
    ) -> Workspace {
        Workspace {
            root: PathBuf::from("/tmp/test"),
            config,
            active: exps,
            concluded: vec![],
            surfaces,
            audiences: vec![],
            call_sites: vec![],
            parse_errors: vec![],
        }
    }

    const VALID_FRONTMATTER: &str = "id: x
status: active
owner: ada@acme.dev
surface: home
hypothesis: h
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
metrics:
  primary: m
created: 2026-01-01";

    #[test]
    fn clean_workspace_passes() {
        let ws = make_workspace(
            vec![parse(VALID_FRONTMATTER, "x")],
            vec![make_surface("home")],
            empty_config(),
        );
        let report = run(&ws);
        assert!(report.is_clean(), "expected clean: {:?}", report.errors);
        assert!(report.warnings.is_empty());
    }

    #[test]
    fn detects_missing_surface() {
        let ws = make_workspace(
            vec![parse(VALID_FRONTMATTER, "x")],
            vec![], // no surfaces
            empty_config(),
        );
        let report = run(&ws);
        assert!(report.errors.iter().any(|d| d.code == "E004"));
    }

    #[test]
    fn detects_bad_owner() {
        let yaml = "id: x
status: active
owner: not-an-email
surface: home
hypothesis: h
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
metrics:
  primary: m
created: 2026-01-01";
        let ws = make_workspace(
            vec![parse(yaml, "x")],
            vec![make_surface("home")],
            empty_config(),
        );
        let report = run(&ws);
        assert!(report.errors.iter().any(|d| d.code == "E003"));
    }

    #[test]
    fn detects_bad_weights() {
        let yaml = "id: x
status: active
owner: ada@acme.dev
surface: home
hypothesis: h
variants:
  - id: control
    weight: 30
  - id: variant_a
    weight: 50
metrics:
  primary: m
created: 2026-01-01";
        let ws = make_workspace(
            vec![parse(yaml, "x")],
            vec![make_surface("home")],
            empty_config(),
        );
        let report = run(&ws);
        let e = report
            .errors
            .iter()
            .find(|d| d.code == "E005")
            .expect("E005");
        assert!(e.message.contains("80"));
    }

    #[test]
    fn detects_undeclared_attribute() {
        let yaml = "id: x
status: active
owner: ada@acme.dev
surface: home
hypothesis: h
audience:
  include:
    - country: US
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
metrics:
  primary: m
created: 2026-01-01";
        let ws = make_workspace(
            vec![parse(yaml, "x")],
            vec![make_surface("home")],
            empty_config(),
        );
        let report = run(&ws);
        let e = report
            .errors
            .iter()
            .find(|d| d.code == "E006")
            .expect("E006");
        assert!(e.message.contains("country"));
    }

    #[test]
    fn detects_same_surface_conflict() {
        let a = "id: a
status: active
owner: ada@acme.dev
surface: home
hypothesis: h
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
metrics:
  primary: m
created: 2026-01-01";
        let b = "id: b
status: active
owner: ada@acme.dev
surface: home
hypothesis: h
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
metrics:
  primary: m
created: 2026-01-02";
        let ws = make_workspace(
            vec![parse(a, "a"), parse(b, "b")],
            vec![make_surface("home")],
            empty_config(),
        );
        let report = run(&ws);
        assert!(report.errors.iter().any(|d| d.code == "E007"));
    }

    #[test]
    fn disjoint_audiences_avoid_conflict() {
        // Two same-surface experiments with provably-disjoint `country`
        // includes. E007 should not fire after step 6.
        let a = "id: a
status: active
owner: ada@acme.dev
surface: home
hypothesis: h
audience:
  include:
    - country: US
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
metrics:
  primary: m
created: 2026-01-01";
        let b = "id: b
status: active
owner: ada@acme.dev
surface: home
hypothesis: h
audience:
  include:
    - country: UK
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
metrics:
  primary: m
created: 2026-01-02";
        // Declare `country` so the audience_attrs check stays clean.
        let mut config = empty_config();
        config
            .audience_attributes
            .push(crate::config::AudienceAttribute {
                name: "country".into(),
                kind: crate::config::AttrType::String,
                values: vec![],
            });
        let mut ws = make_workspace(
            vec![parse(a, "a"), parse(b, "b")],
            vec![make_surface("home")],
            config,
        );
        // Pair the declared `country` attribute with an implementation file
        // so E008 doesn't fire and muddy the E007 assertion below.
        ws.audiences.push(crate::AudienceFile {
            slug: "country".into(),
            path: PathBuf::from("/tmp/test/dif/audiences/country.ts"),
        });
        let report = run(&ws);
        assert!(
            !report.errors.iter().any(|d| d.code == "E007"),
            "expected no E007 for disjoint US vs UK audiences: {:?}",
            report.errors
        );
    }

    #[test]
    fn shared_exclusion_group_avoids_conflict() {
        let a = "id: a
status: active
owner: ada@acme.dev
surface: home
hypothesis: h
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
metrics:
  primary: m
exclusion_group: home-copy
created: 2026-01-01";
        let b = "id: b
status: active
owner: ada@acme.dev
surface: home
hypothesis: h
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
metrics:
  primary: m
exclusion_group: home-copy
created: 2026-01-02";
        let ws = make_workspace(
            vec![parse(a, "a"), parse(b, "b")],
            vec![make_surface("home")],
            empty_config(),
        );
        let report = run(&ws);
        assert!(
            !report.errors.iter().any(|d| d.code == "E007"),
            "expected no E007 with shared exclusion_group: {:?}",
            report.errors
        );
    }

    #[test]
    fn declared_attr_without_audience_file_emits_e008() {
        let mut config = empty_config();
        config
            .audience_attributes
            .push(crate::config::AudienceAttribute {
                name: "device_type".into(),
                kind: crate::config::AttrType::String,
                values: vec![],
            });
        let ws = make_workspace(
            vec![parse(VALID_FRONTMATTER, "x")],
            vec![make_surface("home")],
            config,
        );
        let report = run(&ws);
        let e = report
            .errors
            .iter()
            .find(|d| d.code == "E008")
            .expect("E008");
        assert!(e.message.contains("device_type"));
        assert_eq!(e.file, "dif/config.yaml");
    }

    #[test]
    fn orphan_audience_file_emits_w002() {
        let mut ws = make_workspace(
            vec![parse(VALID_FRONTMATTER, "x")],
            vec![make_surface("home")],
            empty_config(),
        );
        ws.audiences.push(crate::AudienceFile {
            slug: "unused".into(),
            path: PathBuf::from("/tmp/test/dif/audiences/unused.ts"),
        });
        let report = run(&ws);
        let w = report
            .warnings
            .iter()
            .find(|d| d.code == "W002")
            .expect("W002");
        assert!(w.message.contains("unused"));
        // No E008 — the declared set is empty, nothing to miss.
        assert!(!report.errors.iter().any(|d| d.code == "E008"));
    }

    #[test]
    fn paired_attr_and_file_clean() {
        let mut config = empty_config();
        config
            .audience_attributes
            .push(crate::config::AudienceAttribute {
                name: "device_type".into(),
                kind: crate::config::AttrType::Enum,
                values: vec!["mobile".into(), "tablet".into(), "desktop".into()],
            });
        let mut ws = make_workspace(
            vec![parse(VALID_FRONTMATTER, "x")],
            vec![make_surface("home")],
            config,
        );
        ws.audiences.push(crate::AudienceFile {
            slug: "device_type".into(),
            path: PathBuf::from("/tmp/test/dif/audiences/device_type.ts"),
        });
        let report = run(&ws);
        assert!(!report.errors.iter().any(|d| d.code == "E008"));
        assert!(!report.warnings.iter().any(|d| d.code == "W002"));
    }

    #[test]
    fn legacy_exposure_block_warns() {
        let mut config = empty_config();
        config.exposure = Some(serde_yaml::Value::Null);
        let ws = make_workspace(
            vec![parse(VALID_FRONTMATTER, "x")],
            vec![make_surface("home")],
            config,
        );
        let report = run(&ws);
        let w = report
            .warnings
            .iter()
            .find(|d| d.code == "W003")
            .expect("W003");
        assert!(w.message.contains("exposure"));
        assert!(w.help.as_deref().unwrap_or("").contains("events"));
    }

    #[test]
    fn no_legacy_exposure_no_warning() {
        let ws = make_workspace(
            vec![parse(VALID_FRONTMATTER, "x")],
            vec![make_surface("home")],
            empty_config(),
        );
        let report = run(&ws);
        assert!(!report.warnings.iter().any(|d| d.code == "W003"));
    }
}

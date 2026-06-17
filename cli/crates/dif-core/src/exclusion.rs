//! Exclusion-group graph, resolver, and compile-time conflict detection.
//!
//! Three responsibilities:
//!
//! 1. [`ExclusionGraph::build`] — group active experiments by
//!    `exclusion_group` and sort each group by `(created asc, id asc)`.
//!    That ordering is the runtime priority: when two experiments in a
//!    group both match a user, the earlier-declared one wins.
//!
//! 2. [`resolve`] — given a user (id + attribute bag, optional forces),
//!    compute the full per-experiment assignment chain. This is what
//!    `dif qa` (PLAN step 9) replays.
//!
//! 3. [`detect_conflicts`] — compile-time check used by `validate`. Two
//!    active experiments on the same surface are a conflict unless they
//!    share an `exclusion_group` (runtime resolves) or their audiences are
//!    provably disjoint via [`crate::audience::audiences_disjoint`].

use crate::{
    audience::{self, Attributes},
    bucket,
    parse::ParsedExperiment,
    spec::Status,
    workspace::Workspace,
};
use std::collections::BTreeMap;

// -- graph --------------------------------------------------------------------

/// The exclusion graph in compile-time form: groups + ordered membership.
#[derive(Debug, Default)]
pub struct ExclusionGraph {
    /// One entry per declared `exclusion_group`. Members are in runtime
    /// priority order — earliest-created wins, ties broken by id.
    pub groups: Vec<ExclusionGroup>,
}

/// One mutual-exclusion group.
#[derive(Debug)]
pub struct ExclusionGroup {
    /// Group key as declared in the experiments' frontmatter.
    pub key: String,
    /// Member experiment ids, in priority order.
    pub members: Vec<String>,
}

impl ExclusionGraph {
    /// Build the graph from a workspace's active experiments. Ungrouped
    /// experiments (those with `exclusion_group: null`) do not appear here —
    /// they have no peers and need no resolution.
    pub fn build(active: &[ParsedExperiment]) -> Self {
        let mut buckets: BTreeMap<String, Vec<&ParsedExperiment>> = BTreeMap::new();
        for p in active
            .iter()
            .filter(|p| matches!(p.spec.status, Status::Active))
        {
            let Some(group) = &p.spec.exclusion_group else {
                continue;
            };
            buckets.entry(group.clone()).or_default().push(p);
        }
        let groups = buckets
            .into_iter()
            .map(|(key, mut exps)| {
                exps.sort_by(|a, b| {
                    (a.spec.created, a.spec.id.as_str()).cmp(&(b.spec.created, b.spec.id.as_str()))
                });
                ExclusionGroup {
                    key,
                    members: exps.into_iter().map(|p| p.spec.id.clone()).collect(),
                }
            })
            .collect();
        ExclusionGraph { groups }
    }
}

// -- conflict detection -------------------------------------------------------

/// One compile-time conflict between two active experiments.
#[derive(Debug, Clone)]
pub struct Conflict {
    /// Surface they share.
    pub surface: String,
    /// Lexically first experiment id.
    pub a: String,
    /// Lexically second experiment id.
    pub b: String,
}

/// Find every pair of active experiments that target the same surface
/// without an explicit `exclusion_group` declaration AND aren't provably
/// disjoint by audience analysis.
///
/// Same surface = same call site = the runtime would have to pick one. The
/// declaration must be explicit (`exclusion_group`) or the disjointness must
/// be machine-provable (`audience::audiences_disjoint`). Anything else is a
/// build failure — the survey's #1 correctness gap closed at compile time.
pub fn detect_conflicts(workspace: &Workspace) -> Vec<Conflict> {
    let mut by_surface: BTreeMap<&str, Vec<&ParsedExperiment>> = BTreeMap::new();
    for p in &workspace.active {
        if matches!(p.spec.status, Status::Active) {
            by_surface
                .entry(p.spec.surface.as_str())
                .or_default()
                .push(p);
        }
    }

    let mut conflicts = Vec::new();
    for (surface, exps) in &by_surface {
        if exps.len() < 2 {
            continue;
        }
        for i in 0..exps.len() {
            for j in (i + 1)..exps.len() {
                let a = exps[i];
                let b = exps[j];

                // Shared exclusion_group → declared intent, runtime resolves.
                let shared_group = matches!(
                    (&a.spec.exclusion_group, &b.spec.exclusion_group),
                    (Some(x), Some(y)) if x == y
                );
                if shared_group {
                    continue;
                }

                // Provably-disjoint audiences → can't collide on the same user.
                if audience::audiences_disjoint(&a.spec.audience, &b.spec.audience) {
                    continue;
                }

                let (lo, hi) = if a.spec.id < b.spec.id {
                    (a, b)
                } else {
                    (b, a)
                };
                conflicts.push(Conflict {
                    surface: surface.to_string(),
                    a: lo.spec.id.clone(),
                    b: hi.spec.id.clone(),
                });
            }
        }
    }
    conflicts
}

// -- resolver -----------------------------------------------------------------

/// Inputs to [`resolve`]. All fields are borrows, so the struct is `Copy`
/// — passing it by value is cheap and avoids lifetime gymnastics at call sites.
#[derive(Debug, Clone, Copy)]
pub struct ResolutionInputs<'a> {
    /// User id used for bucketing.
    pub user_id: &'a str,
    /// Attribute bag the audience evaluator consults.
    pub attributes: &'a Attributes,
    /// `experiment_id` → forced variant id. Forces bypass audience and
    /// exclusion entirely; intended for `dif qa --force`.
    pub forces: &'a std::collections::HashMap<String, String>,
}

/// Output of [`resolve`] — the full per-experiment trace.
#[derive(Debug, Clone)]
pub struct Resolution {
    /// One row per active experiment, sorted by experiment id for stable
    /// output.
    pub rows: Vec<ResolutionRow>,
}

/// One experiment's resolution outcome.
#[derive(Debug, Clone)]
pub struct ResolutionRow {
    /// Experiment id.
    pub experiment_id: String,
    /// Surface this experiment runs on.
    pub surface: String,
    /// What happened.
    pub outcome: Outcome,
}

/// What happened to a single experiment during resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Picked normally via deterministic bucketing.
    Assigned {
        /// Variant id chosen.
        variant: String,
        /// Bucket 0..9999 the user fell into.
        bucket: u16,
    },
    /// Picked because `--force` set it. Audience and exclusion are bypassed.
    Forced {
        /// Variant id chosen by the force.
        variant: String,
    },
    /// User didn't match the audience predicate.
    AudienceMiss,
    /// User matched, but a higher-priority experiment in the same
    /// `exclusion_group` already won.
    ExclusionLoser {
        /// Experiment id that took the slot.
        winner: String,
    },
}

/// Resolve one user against the workspace. The algorithm:
///
/// 1. Group active experiments by `exclusion_group`. Ungrouped experiments
///    each form a solo group.
/// 2. Within each group, sort by `(created asc, id asc)` — the same priority
///    used by [`ExclusionGraph::build`].
/// 3. For each group, pick a winner:
///    - The first experiment with a force wins (and bypasses audience),
///    - Else the first experiment whose audience matches wins.
/// 4. Emit one row per experiment. Winner gets `Assigned` or `Forced`;
///    losers get `ExclusionLoser` (if they would have matched) or
///    `AudienceMiss` (if they wouldn't).
pub fn resolve(workspace: &Workspace, inputs: ResolutionInputs<'_>) -> Resolution {
    // Group active experiments. Ungrouped → unique solo key prefixed with
    // `\0` so it can't collide with a user-declared group string.
    let mut groups: BTreeMap<String, Vec<&ParsedExperiment>> = BTreeMap::new();
    for p in &workspace.active {
        if !matches!(p.spec.status, Status::Active) {
            continue;
        }
        let key = match &p.spec.exclusion_group {
            Some(g) => g.clone(),
            None => format!("\0solo::{}", p.spec.id),
        };
        groups.entry(key).or_default().push(p);
    }

    for exps in groups.values_mut() {
        exps.sort_by(|a, b| {
            (a.spec.created, a.spec.id.as_str()).cmp(&(b.spec.created, b.spec.id.as_str()))
        });
    }

    let mut rows = Vec::new();
    for exps in groups.values() {
        let winner_idx = pick_winner(exps, inputs);
        for (i, exp) in exps.iter().enumerate() {
            let outcome = if Some(i) == winner_idx {
                if let Some(variant) = inputs.forces.get(&exp.spec.id) {
                    Outcome::Forced {
                        variant: variant.clone(),
                    }
                } else {
                    let salt = bucket::salt_for(&exp.spec.id);
                    let b = bucket::bucket(&salt, inputs.user_id);
                    let variant = bucket::select_variant(&exp.spec.variants, b)
                        .unwrap_or("")
                        .to_string();
                    Outcome::Assigned { variant, bucket: b }
                }
            } else {
                // Not the winner. Two ways to lose: audience didn't match, or
                // a peer won the group first.
                let would_match = audience::matches(&exp.spec.audience, inputs.attributes)
                    || inputs.forces.contains_key(&exp.spec.id);
                match (would_match, winner_idx) {
                    (true, Some(idx)) => Outcome::ExclusionLoser {
                        winner: exps[idx].spec.id.clone(),
                    },
                    _ => Outcome::AudienceMiss,
                }
            };
            rows.push(ResolutionRow {
                experiment_id: exp.spec.id.clone(),
                surface: exp.spec.surface.clone(),
                outcome,
            });
        }
    }

    rows.sort_by(|a, b| a.experiment_id.cmp(&b.experiment_id));
    Resolution { rows }
}

/// Pick the winning index within a priority-ordered group. Forces beat
/// audience matches; ties within forces or matches go to lower priority
/// index (i.e., earlier-declared).
fn pick_winner(exps: &[&ParsedExperiment], inputs: ResolutionInputs<'_>) -> Option<usize> {
    for (i, exp) in exps.iter().enumerate() {
        if inputs.forces.contains_key(&exp.spec.id) {
            return Some(i);
        }
    }
    for (i, exp) in exps.iter().enumerate() {
        if audience::matches(&exp.spec.audience, inputs.attributes) {
            return Some(i);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::{BucketingConfig, BuildConfig, Config},
        parse::{parse_experiment_str, ParsedSurface},
        spec::Surface,
    };
    use std::collections::HashMap;
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

    fn make_workspace(exps: Vec<ParsedExperiment>, surfaces: Vec<ParsedSurface>) -> Workspace {
        Workspace {
            root: PathBuf::from("/tmp/test"),
            config: empty_config(),
            active: exps,
            concluded: vec![],
            surfaces,
            audiences: vec![],
            call_sites: vec![],
            parse_errors: vec![],
        }
    }

    const SIMPLE_EXP: &str = "id: x
status: active
owner: ada@acme.dev
surface: home
hypothesis: h
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
    summary: a
metrics:
  primary: m
created: 2026-01-01";

    fn replace(yaml: &str, from: &str, to: &str) -> String {
        yaml.replace(from, to)
    }

    // -- graph build ----------------------------------------------------------

    #[test]
    fn graph_groups_and_sorts_by_priority() {
        let a = parse(
            &replace(SIMPLE_EXP, "id: x\n", "id: a\nexclusion_group: g\n"),
            "a",
        );
        let b = parse(
            &replace(
                &replace(SIMPLE_EXP, "id: x\n", "id: b\nexclusion_group: g\n"),
                "created: 2026-01-01",
                "created: 2025-12-15",
            ),
            "b",
        );
        let graph = ExclusionGraph::build(&[a, b]);
        assert_eq!(graph.groups.len(), 1);
        // `b` is earlier-created → wins priority.
        assert_eq!(graph.groups[0].members, vec!["b", "a"]);
    }

    #[test]
    fn graph_skips_ungrouped() {
        let a = parse(&replace(SIMPLE_EXP, "id: x", "id: a"), "a");
        let graph = ExclusionGraph::build(&[a]);
        assert!(graph.groups.is_empty());
    }

    // -- conflict detection ---------------------------------------------------

    #[test]
    fn detect_conflicts_flags_same_surface_no_group() {
        let a = parse(&replace(SIMPLE_EXP, "id: x", "id: a"), "a");
        let b = parse(&replace(SIMPLE_EXP, "id: x", "id: b"), "b");
        let ws = make_workspace(vec![a, b], vec![make_surface("home")]);
        let conflicts = detect_conflicts(&ws);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].surface, "home");
    }

    #[test]
    fn detect_conflicts_allows_shared_group() {
        let a = parse(
            &replace(SIMPLE_EXP, "id: x\n", "id: a\nexclusion_group: g\n"),
            "a",
        );
        let b = parse(
            &replace(SIMPLE_EXP, "id: x\n", "id: b\nexclusion_group: g\n"),
            "b",
        );
        let ws = make_workspace(vec![a, b], vec![make_surface("home")]);
        assert!(detect_conflicts(&ws).is_empty());
    }

    #[test]
    fn detect_conflicts_allows_disjoint_audiences() {
        let a = parse(
            &replace(
                SIMPLE_EXP,
                "id: x\n",
                "id: a\naudience:\n  include:\n    - country: US\n",
            ),
            "a",
        );
        let b = parse(
            &replace(
                SIMPLE_EXP,
                "id: x\n",
                "id: b\naudience:\n  include:\n    - country: UK\n",
            ),
            "b",
        );
        let ws = make_workspace(vec![a, b], vec![make_surface("home")]);
        assert!(
            detect_conflicts(&ws).is_empty(),
            "expected no conflict for country=US vs country=UK"
        );
    }

    // -- resolver -------------------------------------------------------------

    #[test]
    fn resolve_assigns_variant_via_bucketing() {
        let a = parse(&replace(SIMPLE_EXP, "id: x", "id: a"), "a");
        let ws = make_workspace(vec![a], vec![make_surface("home")]);
        let attrs = Attributes::new();
        let forces = HashMap::new();
        let res = resolve(
            &ws,
            ResolutionInputs {
                user_id: "u_1",
                attributes: &attrs,
                forces: &forces,
            },
        );
        assert_eq!(res.rows.len(), 1);
        match &res.rows[0].outcome {
            Outcome::Assigned { variant, bucket } => {
                assert!(matches!(variant.as_str(), "control" | "variant_a"));
                assert!(*bucket < 10_000);
            }
            other => panic!("expected Assigned, got {other:?}"),
        }
    }

    #[test]
    fn resolve_honors_force() {
        let a = parse(&replace(SIMPLE_EXP, "id: x", "id: a"), "a");
        let ws = make_workspace(vec![a], vec![make_surface("home")]);
        let attrs = Attributes::new();
        let mut forces = HashMap::new();
        forces.insert("a".into(), "variant_a".into());
        let res = resolve(
            &ws,
            ResolutionInputs {
                user_id: "u_1",
                attributes: &attrs,
                forces: &forces,
            },
        );
        assert_eq!(
            res.rows[0].outcome,
            Outcome::Forced {
                variant: "variant_a".into()
            }
        );
    }

    #[test]
    fn resolve_audience_miss_skips() {
        let a = parse(
            &replace(
                SIMPLE_EXP,
                "id: x\n",
                "id: a\naudience:\n  include:\n    - country: US\n",
            ),
            "a",
        );
        let ws = make_workspace(vec![a], vec![make_surface("home")]);
        let attrs = Attributes::new(); // no country
        let forces = HashMap::new();
        let res = resolve(
            &ws,
            ResolutionInputs {
                user_id: "u_1",
                attributes: &attrs,
                forces: &forces,
            },
        );
        assert_eq!(res.rows[0].outcome, Outcome::AudienceMiss);
    }

    #[test]
    fn resolve_exclusion_loser_yields_to_higher_priority() {
        let a = parse(
            &replace(
                &replace(SIMPLE_EXP, "id: x\n", "id: a\nexclusion_group: g\n"),
                "created: 2026-01-01",
                "created: 2026-01-01",
            ),
            "a",
        );
        let b = parse(
            &replace(
                &replace(SIMPLE_EXP, "id: x\n", "id: b\nexclusion_group: g\n"),
                "created: 2026-01-01",
                "created: 2025-12-15",
            ),
            "b",
        );
        let ws = make_workspace(vec![a, b], vec![make_surface("home")]);
        let attrs = Attributes::new();
        let forces = HashMap::new();
        let res = resolve(
            &ws,
            ResolutionInputs {
                user_id: "u_1",
                attributes: &attrs,
                forces: &forces,
            },
        );
        // Rows sorted by id — `a` then `b`.
        // `b` is earlier-created → wins → Assigned.
        // `a` is later → ExclusionLoser with winner=b.
        let row_a = res.rows.iter().find(|r| r.experiment_id == "a").unwrap();
        let row_b = res.rows.iter().find(|r| r.experiment_id == "b").unwrap();
        assert_eq!(
            row_a.outcome,
            Outcome::ExclusionLoser { winner: "b".into() }
        );
        assert!(matches!(row_b.outcome, Outcome::Assigned { .. }));
    }
}

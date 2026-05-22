//! Audience predicate evaluation and disjointness analysis.
//!
//! Audiences are declared in experiment frontmatter as two lists of
//! attribute-predicate maps:
//!
//! ```yaml
//! audience:
//!   include:
//!     - returning_visitor: true
//!     - country: [US, CA]
//!   exclude:
//!     - plan: free
//! ```
//!
//! Semantics: a user matches iff **all** `include` predicates match **and**
//! **no** `exclude` predicate matches. A predicate matches when every
//! `attr: value` entry in it matches the user's bag — scalars compare for
//! equality; sequences compare for membership.
//!
//! Two responsibilities live here:
//! 1. [`matches`] — runtime evaluator. Used by the resolver (step 6) and
//!    `dif qa` (step 9).
//! 2. [`audiences_disjoint`] — compile-time disjointness check. Used by
//!    [`crate::exclusion::detect_conflicts`] so provably-disjoint pairs on
//!    the same surface don't have to declare a shared `exclusion_group`.

use crate::spec::{AttrPredicate, Audience};
use serde_yaml::Value;
use std::collections::{HashMap, HashSet};

/// Attribute bag the runtime consults to evaluate audience predicates.
pub type Attributes = HashMap<String, Value>;

/// Evaluate an audience predicate against a user's attribute bag. Empty
/// audiences (no includes, no excludes) match everyone.
pub fn matches(audience: &Audience, attrs: &Attributes) -> bool {
    let included = audience.include.iter().all(|p| predicate_matches(p, attrs));
    let excluded_by_any = audience.exclude.iter().any(|p| predicate_matches(p, attrs));
    included && !excluded_by_any
}

/// True if at least one entry in `pred` matches the user. Multi-entry
/// predicates are AND'd internally (canonical YAML for "country=US AND
/// plan=pro" is one predicate with two keys).
fn predicate_matches(pred: &AttrPredicate, attrs: &Attributes) -> bool {
    for (key, expected) in pred.0.iter() {
        let Some(name) = key.as_str() else {
            return false;
        };
        let Some(actual) = attrs.get(name) else {
            return false;
        };
        if !value_satisfies(actual, expected) {
            return false;
        }
    }
    true
}

/// Does the user's `actual` value satisfy the predicate's `expected`?
/// Sequences mean set membership; everything else means equality.
fn value_satisfies(actual: &Value, expected: &Value) -> bool {
    match expected {
        Value::Sequence(seq) => seq.iter().any(|item| item == actual),
        _ => actual == expected,
    }
}

/// Conservative provable disjointness — true iff there's at least one
/// attribute on which `a` and `b` both impose `include` constraints with
/// empty intersection. False does **not** mean "overlapping"; it means
/// "couldn't prove disjoint." Callers should fall back to requiring an
/// explicit `exclusion_group` when this returns false.
///
/// v1 only inspects `include` predicates. Exclude-based disjointness
/// (e.g. A includes `country=US`, B excludes `country=US`) is a fine
/// future addition but the kebab-case `country: US` vs `country: UK`
/// pattern is what 90% of real conflicts look like.
pub fn audiences_disjoint(a: &Audience, b: &Audience) -> bool {
    let a_attrs = include_constraints(a);
    let b_attrs = include_constraints(b);
    for (attr, a_values) in &a_attrs {
        let Some(b_values) = b_attrs.get(attr) else {
            continue;
        };
        if sets_disjoint(a_values, b_values) {
            return true;
        }
    }
    false
}

/// For each attribute, collect the union of all `include` constraint values.
/// A bare scalar contributes a singleton set; a sequence contributes its
/// elements. Unknown predicate shapes contribute nothing.
fn include_constraints(audience: &Audience) -> HashMap<String, Vec<Value>> {
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    for pred in &audience.include {
        for (key, value) in pred.0.iter() {
            let Some(name) = key.as_str() else { continue };
            let values = match value {
                Value::Sequence(seq) => seq.clone(),
                v => vec![v.clone()],
            };
            out.entry(name.to_string()).or_default().extend(values);
        }
    }
    out
}

fn sets_disjoint(a: &[Value], b: &[Value]) -> bool {
    // O(n*m) is fine — predicate sets are tiny in practice.
    let a_set: HashSet<&Value> = a.iter().collect();
    !b.iter().any(|v| a_set.contains(v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::Audience;

    fn audience_from_yaml(yaml: &str) -> Audience {
        serde_yaml::from_str(yaml).expect("parse audience")
    }

    fn attrs(pairs: &[(&str, &str)]) -> Attributes {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), Value::String(v.to_string())))
            .collect()
    }

    #[test]
    fn empty_audience_matches_anyone() {
        let a = audience_from_yaml("{}");
        assert!(matches(&a, &Attributes::new()));
        assert!(matches(&a, &attrs(&[("country", "US")])));
    }

    #[test]
    fn include_scalar_must_match() {
        let a = audience_from_yaml("include:\n  - country: US");
        assert!(matches(&a, &attrs(&[("country", "US")])));
        assert!(!matches(&a, &attrs(&[("country", "UK")])));
        assert!(!matches(&a, &attrs(&[]))); // attr missing
    }

    #[test]
    fn include_sequence_means_membership() {
        let a = audience_from_yaml("include:\n  - country: [US, CA]");
        assert!(matches(&a, &attrs(&[("country", "US")])));
        assert!(matches(&a, &attrs(&[("country", "CA")])));
        assert!(!matches(&a, &attrs(&[("country", "UK")])));
    }

    #[test]
    fn exclude_disqualifies() {
        let a = audience_from_yaml("exclude:\n  - country: US");
        assert!(!matches(&a, &attrs(&[("country", "US")])));
        assert!(matches(&a, &attrs(&[("country", "UK")])));
        assert!(matches(&a, &attrs(&[]))); // exclude only fires on presence
    }

    #[test]
    fn include_and_exclude_compose() {
        let a = audience_from_yaml("include:\n  - country: [US, CA]\nexclude:\n  - plan: free");
        let mut user = attrs(&[("country", "US"), ("plan", "pro")]);
        assert!(matches(&a, &user));
        user.insert("plan".into(), Value::String("free".into()));
        assert!(!matches(&a, &user));
        user.insert("country".into(), Value::String("UK".into()));
        assert!(!matches(&a, &user)); // failing include short-circuits
    }

    #[test]
    fn disjoint_via_scalar_inequality() {
        let a = audience_from_yaml("include:\n  - country: US");
        let b = audience_from_yaml("include:\n  - country: UK");
        assert!(audiences_disjoint(&a, &b));
        assert!(audiences_disjoint(&b, &a));
    }

    #[test]
    fn disjoint_via_sequence_intersection() {
        let a = audience_from_yaml("include:\n  - country: [US, CA]");
        let b = audience_from_yaml("include:\n  - country: [UK, DE]");
        assert!(audiences_disjoint(&a, &b));
    }

    #[test]
    fn not_disjoint_when_sequences_overlap() {
        let a = audience_from_yaml("include:\n  - country: [US, CA]");
        let b = audience_from_yaml("include:\n  - country: [CA, MX]");
        assert!(!audiences_disjoint(&a, &b));
    }

    #[test]
    fn not_disjoint_when_only_one_constrains_attr() {
        let a = audience_from_yaml("include:\n  - country: US");
        let b = audience_from_yaml("include:\n  - plan: pro");
        // Neither constrains the attribute the other does — provability fails.
        assert!(!audiences_disjoint(&a, &b));
    }

    #[test]
    fn not_disjoint_when_empty() {
        let a = audience_from_yaml("{}");
        let b = audience_from_yaml("include:\n  - country: US");
        assert!(!audiences_disjoint(&a, &b));
    }
}

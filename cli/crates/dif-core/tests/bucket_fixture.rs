//! Cross-language bucketing anchor.
//!
//! The TS SDK (`@dif.sh/sdk`) reimplements the same algorithm and must
//! produce byte-identical buckets for every entry in
//! `tests/fixtures/bucket_tests.json`. CI runs both languages against the
//! same file on every PR.
//!
//! ## Workflow
//!
//! - **First run** (no fixture yet): the test generates the file from the
//!   current Rust implementation and passes. Commit the generated file.
//! - **Subsequent runs**: the test reads the fixture and asserts the Rust
//!   side still produces the same buckets. Any drift fails loudly.
//! - **Algorithm change**: re-run with `DIF_REGEN_FIXTURE=1`. The file is
//!   regenerated. Review the diff in PR; if it's intentional, ship it (and
//!   bump the TS side's `version` check).

use dif_core::bucket::{bucket, salt_for};
use dif_core::BUCKET_NAMESPACE;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, PartialEq, Eq, Debug)]
struct Case {
    experiment_id: String,
    user_id: String,
    bucket: u16,
}

#[derive(Serialize, Deserialize)]
struct Fixture {
    /// Fixture schema version. Bump when input pairs or output shape change.
    version: u32,
    /// Bucket namespace — must match `dif_core::BUCKET_NAMESPACE`. The TS
    /// side verifies this before trusting the file.
    namespace: String,
    /// Computed cases.
    cases: Vec<Case>,
}

const FIXTURE_VERSION: u32 = 1;

fn fixture_path() -> PathBuf {
    PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/bucket_tests.json"
    ))
}

/// Inputs to compute the fixture from. Deliberately diverse: ASCII ids,
/// kebab-case, single-char, long, unicode, empty, all-digits, email-shaped.
/// These cover the realistic shape of `experiment_id` and `user_id` values
/// while exercising hashing on multi-byte UTF-8 sequences (the TS port must
/// encode as UTF-8 too).
fn input_pairs() -> Vec<(&'static str, &'static str)> {
    let experiments: &[&str] = &[
        "checkout-cta-v2",
        "pricing-headline",
        "a",
        "abcdefghij",
        "long-experiment-id-with-many-segments-1234567890",
        "exp-名前",
    ];
    let users: &[&str] = &[
        "u_1",
        "u_2",
        "u_8131",
        "ada@acme.dev",
        "long-user-id-1234567890abcdef",
        "",
        "user with spaces",
        "用户名",
        "0",
        "9999",
    ];
    let mut out = Vec::with_capacity(experiments.len() * users.len());
    for e in experiments {
        for u in users {
            out.push((*e, *u));
        }
    }
    out
}

fn compute_all() -> Vec<Case> {
    input_pairs()
        .into_iter()
        .map(|(exp, user)| {
            let salt = salt_for(exp);
            let b = bucket(&salt, user);
            Case {
                experiment_id: exp.to_string(),
                user_id: user.to_string(),
                bucket: b,
            }
        })
        .collect()
}

#[test]
fn rust_matches_fixture() {
    let computed = compute_all();
    let path = fixture_path();
    let regen = std::env::var("DIF_REGEN_FIXTURE").is_ok();

    if regen || !path.exists() {
        let fixture = Fixture {
            version: FIXTURE_VERSION,
            namespace: BUCKET_NAMESPACE.to_string(),
            cases: computed,
        };
        let json = serde_json::to_string_pretty(&fixture).expect("serialize fixture");
        fs::create_dir_all(path.parent().expect("fixture parent dir")).expect("mkdir");
        fs::write(&path, json).expect("write fixture");
        eprintln!(
            "{} bucket fixture generated: {}",
            if regen {
                "regenerated"
            } else {
                "first run —"
            },
            path.display()
        );
        return;
    }

    let source = fs::read_to_string(&path).expect("read fixture");
    let fixture: Fixture = serde_json::from_str(&source).expect("parse fixture");

    assert_eq!(
        fixture.version, FIXTURE_VERSION,
        "fixture version mismatch — re-run with DIF_REGEN_FIXTURE=1 if intentional"
    );
    assert_eq!(
        fixture.namespace, BUCKET_NAMESPACE,
        "namespace drift between code and fixture"
    );
    assert_eq!(
        fixture.cases.len(),
        computed.len(),
        "fixture has {} cases, code generates {}; re-run with DIF_REGEN_FIXTURE=1 if intentional",
        fixture.cases.len(),
        computed.len()
    );

    for (i, (expected, actual)) in fixture.cases.iter().zip(computed.iter()).enumerate() {
        assert_eq!(
            expected, actual,
            "bucket mismatch at case {i} — re-run with DIF_REGEN_FIXTURE=1 if intentional"
        );
    }
}

//! Deterministic bucketing — Rust side of the cross-language fixture.
//!
//! The TS SDK reimplements this exactly. Any drift breaks the contract; CI
//! runs both against `bucket_tests.json` on every PR.
//!
//! Algorithm:
//!   1. SHA-256 of (salt || user_id)
//!   2. Take the first 4 bytes as a big-endian u32
//!   3. Modulo 10_000 → bucket in [0, 10_000)
//!
//! Four bytes, not two: 2^16 % 10_000 = 5_536, so a u16 source would give
//! buckets 0..=5535 seven preimages and the rest six — a 53.4/46.6 split on a
//! nominal 50/50 experiment. With a u32 source the residual bias is ~1.7e-6.
//!
//! Variant selection walks variants in declared order, accumulating
//! `weight * 100`; the first variant whose cumulative crosses the bucket wins.

use sha2::{Digest, Sha256};

use crate::spec::Variant;
use crate::BUCKET_NAMESPACE;

/// Compute the deterministic bucket salt for an experiment id.
///
/// `salt = SHA256("dif.sh/v1" || experiment_id)[..16]`
pub fn salt_for(experiment_id: &str) -> [u8; 16] {
    let mut hasher = Sha256::new();
    hasher.update(BUCKET_NAMESPACE.as_bytes());
    hasher.update(experiment_id.as_bytes());
    let digest = hasher.finalize();
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&digest[..16]);
    salt
}

/// Compute the bucket (0..10_000) for a user under the given salt.
pub fn bucket(salt: &[u8; 16], user_id: &str) -> u16 {
    let mut hasher = Sha256::new();
    hasher.update(salt);
    hasher.update(user_id.as_bytes());
    let digest = hasher.finalize();
    let quad = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    (quad % 10_000) as u16
}

/// Pick the variant id corresponding to a bucket given the experiment's
/// declared variants. Returns `None` if weights do not sum to 100 (which
/// `validate` should have already caught).
pub fn select_variant(variants: &[Variant], bucket: u16) -> Option<&str> {
    let mut cumulative: u32 = 0;
    for v in variants {
        cumulative += u32::from(v.weight) * 100;
        if u32::from(bucket) < cumulative {
            return Some(v.id.as_str());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn salt_is_deterministic() {
        assert_eq!(salt_for("checkout-cta-v2"), salt_for("checkout-cta-v2"));
    }

    #[test]
    fn salt_differs_by_experiment() {
        assert_ne!(salt_for("a"), salt_for("b"));
    }

    #[test]
    fn bucket_in_range() {
        let salt = salt_for("checkout-cta-v2");
        for i in 0..100 {
            let b = bucket(&salt, &format!("u_{i}"));
            assert!(b < 10_000);
        }
    }

    /// Pins the modulo-bias fix: with a u16 source a 50/50 split allocated
    /// ~53.4/46.6. 100k synthetic users must land within ±1% of even.
    #[test]
    fn bucket_distribution_is_unbiased() {
        let salt = salt_for("distribution-check");
        let n = 100_000u32;
        let below_split = (0..n)
            .filter(|i| bucket(&salt, &format!("user_{i}")) < 5_000)
            .count();
        let share = below_split as f64 / n as f64;
        assert!(
            (share - 0.5).abs() < 0.01,
            "50/50 split allocated {share:.4} to the first half"
        );
    }
}

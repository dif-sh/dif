// TS port of `dif_core::bucket`. Must produce byte-identical buckets for
// every entry in `crates/dif-core/tests/fixtures/bucket_tests.json` — the
// fixture test in `bucket.test.ts` enforces that contract.
//
// Algorithm:
//   1. SHA-256 of (salt || user_id)         — salt is 16 raw bytes, user_id UTF-8
//   2. Take the first 2 bytes as a big-endian u16
//   3. Modulo 10_000 → bucket in [0, 10_000)
//
// Variant selection walks variants in declared order, accumulating
// `weight * 100`; first variant whose cumulative crosses the bucket wins.

import { sha256, bytesToHex, hexToBytes } from "./sha256.js";

/** Bucket namespace — must match `dif_core::BUCKET_NAMESPACE`. */
export const BUCKET_NAMESPACE = "dif.sh/v1";

/** UTF-8 encoder. Reused so we don't allocate one per call. */
const TE = new TextEncoder();

/**
 * Compute the deterministic 16-byte salt for an experiment id, returned as
 * a 32-character lowercase hex string. Mirrors `salt_for` in Rust.
 *
 * The runtime SDK does **not** call this — the generated `client.ts`
 * embeds the precomputed salt. This export exists for the fixture test
 * and for tooling that wants to verify the embed.
 */
export function saltFor(experimentId: string): string {
  const ns = TE.encode(BUCKET_NAMESPACE);
  const id = TE.encode(experimentId);
  const buf = new Uint8Array(ns.length + id.length);
  buf.set(ns);
  buf.set(id, ns.length);
  const digest = sha256(buf);
  return bytesToHex(digest.subarray(0, 16));
}

/**
 * Compute the bucket (0..9999) for a user under the given salt.
 *
 * @param saltHex 32-character lowercase hex. Embedded in the generated file.
 * @param userId  user id string; UTF-8 encoded before hashing.
 */
export function bucket(saltHex: string, userId: string): number {
  const salt = hexToBytes(saltHex);
  if (salt.length !== 16) {
    throw new Error(`expected 16-byte salt, got ${salt.length}`);
  }
  const user = TE.encode(userId);
  const buf = new Uint8Array(salt.length + user.length);
  buf.set(salt);
  buf.set(user, salt.length);
  const digest = sha256(buf);
  const pair = ((digest[0]! << 8) | digest[1]!) >>> 0;
  return pair % 10_000;
}

/**
 * Pick the variant corresponding to a bucket given the experiment's declared
 * variants and weights. Returns `null` if weights don't sum to 100 (which
 * `dif validate` should have caught at build time).
 */
export function selectVariant(
  variants: readonly string[],
  weights: Record<string, number>,
  bucketValue: number,
): string | null {
  let cumulative = 0;
  for (const variant of variants) {
    const w = weights[variant] ?? 0;
    cumulative += w * 100;
    if (bucketValue < cumulative) return variant;
  }
  return null;
}

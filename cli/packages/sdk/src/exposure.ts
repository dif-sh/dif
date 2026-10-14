// Exposure events fire at render time.
// Dedup is per page load, and in localStorage.

import { uuidv7 } from "./event-id.js";
import { bytesToHex, sha256 } from "./sha256.js";
import type { ExperimentSpec, ExposureEvent, Sink } from "./types.js";
import { SOURCE } from "./version.js";

/** Per-session dedupe set. Cleared on page nav (the module is per-page). */
const fired = new Set<string>();

const STORAGE_PREFIX = "dif:exp:v1:";
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_KEYS_SCANNED = 1000;

let pruned = false;

/** localStorage, or null when absent or blocked. */
function getStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

// The key holds a hash, not the user id.
// A collision causes one extra or skipped exposure.
function userHash(userId: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(userId)).subarray(0, 8));
}

/** Return the variant of a live entry, else null. */
function liveVariant(raw: string | null, now: number): string | null {
  if (raw === null) return null;
  try {
    const entry = JSON.parse(raw) as { variant?: unknown; until?: unknown } | null;
    if (entry === null || typeof entry !== "object") return null;
    const { variant, until } = entry;
    if (typeof variant !== "string" || typeof until !== "number") return null;
    // A clock error or an edit can put until too far ahead.
    if (!(until > now && until <= now + ENTRY_TTL_MS)) return null;
    return variant;
  } catch {
    return null;
  }
}

/** Remove entries that are expired, malformed or too far ahead. */
function pruneStale(store: Storage): void {
  try {
    const now = Date.now();
    const stale: string[] = [];
    const count = Math.min(store.length, MAX_KEYS_SCANNED);
    for (let i = 0; i < count; i++) {
      const key = store.key(i);
      if (key === null || !key.startsWith(STORAGE_PREFIX)) continue;
      if (liveVariant(store.getItem(key), now) === null) stale.push(key);
    }
    for (const key of stale) store.removeItem(key);
  } catch {
    // Stale entries stay until the next load.
  }
}

function alreadyRecorded(store: Storage, key: string, variant: string): boolean {
  try {
    return liveVariant(store.getItem(key), Date.now()) === variant;
  } catch {
    return false;
  }
}

function record(store: Storage, key: string, variant: string): void {
  try {
    store.setItem(key, JSON.stringify({ variant, until: Date.now() + ENTRY_TTL_MS }));
  } catch {
    // The per-load set still holds.
  }
}

/**
 * Fire one exposure event to the sinks.
 * A cloud 2xx saves an entry that stops later loads.
 */
export function fireExposure(
  spec: ExperimentSpec,
  variant: string,
  userId: string,
  bucket: number,
  sinks: Sink[],
): void {
  const dedupeKey = `${spec.id}::${userId}`;
  if (fired.has(dedupeKey)) return;
  fired.add(dedupeKey);

  const cloudSinks = sinks.filter((s) => s.kind === "cloud");
  const store = cloudSinks.length > 0 ? getStorage() : null;
  if (store && !pruned) {
    pruned = true;
    pruneStale(store);
  }
  const storeKey = `${STORAGE_PREFIX}${spec.id}:${userHash(userId)}`;
  if (store && alreadyRecorded(store, storeKey, variant)) return;

  const event: ExposureEvent = {
    event: "dif.exposure",
    event_id: uuidv7(),
    experiment: spec.id,
    variant,
    user_id: userId,
    surface: spec.surface,
    bucket,
    fired_at: Date.now(),
    source: SOURCE,
  };

  const deliveries: Promise<boolean>[] = [];
  for (const sink of sinks) {
    try {
      const result = sink.emit(event);
      if (store && sink.kind === "cloud" && result) deliveries.push(result);
    } catch {
      // Sinks must never throw. If one does, swallow — bad analytics must
      // not crash a render.
    }
  }

  if (store && deliveries.length > 0) {
    void Promise.all(deliveries.map((d) => d.catch(() => false))).then((ok) => {
      if (ok.every(Boolean)) record(store, storeKey, variant);
    });
  }
}

/** Test-only: act like a new page load. Saved entries stay. */
export function __resetExposures(): void {
  fired.clear();
  pruned = false;
}

// Exposure event firing — render-time, deduped per (experiment, user).
//
// A per-load set always applies.
// A localStorage entry also stops the next page load.

import { uuidv7 } from "./event-id.js";
import type { ExperimentSpec, ExposureEvent, Sink } from "./types.js";
import { SOURCE } from "./version.js";

/** Per-session dedupe set. Cleared on page nav (the module is per-page). */
const fired = new Set<string>();

const STORAGE_PREFIX = "dif:exp:v1:";
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** localStorage, or null when it is missing or throws (privacy modes). */
function getStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** True when a live entry already records this variant. */
function alreadyRecorded(store: Storage, key: string, variant: string): boolean {
  try {
    const raw = store.getItem(key);
    if (raw === null) return false;
    const entry = JSON.parse(raw) as { variant?: unknown; until?: unknown } | null;
    return (
      entry !== null &&
      typeof entry === "object" &&
      entry.variant === variant &&
      typeof entry.until === "number" &&
      entry.until > Date.now()
    );
  } catch {
    // Treat an unreadable entry as absent.
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
 * Fire one exposure event across every configured sink. Idempotent per
 * (experiment, user) for the lifetime of the module.
 *
 * With a cloud sink and localStorage it also stays quiet across page loads,
 * until the entry expires (30 days) or the variant changes. The entry is
 * saved only after the cloud answers 2xx, so a lost exposure fires again.
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
  const storeKey = `${STORAGE_PREFIX}${spec.id}:${userId}`;
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

/** Test-only: clear the per-session set. Saved entries stay, as on a reload. */
export function __resetExposures(): void {
  fired.clear();
}

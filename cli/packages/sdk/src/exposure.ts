// Exposure event firing — render-time, deduped per session per (experiment, user).

import type { ExperimentSpec, ExposureEvent, Sink } from "./types.js";

const SOURCE = "@dif.sh/sdk@0.3.2";

/** Per-session dedupe set. Cleared on page nav (the module is per-page). */
const fired = new Set<string>();

/**
 * Fire one exposure event across every configured sink. Idempotent per
 * (experiment, user) for the lifetime of the module.
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

  const event: ExposureEvent = {
    event: "dif.exposure",
    experiment: spec.id,
    variant,
    user_id: userId,
    surface: spec.surface,
    bucket,
    fired_at: Date.now(),
    source: SOURCE,
  };

  for (const sink of sinks) {
    try {
      sink.emit(event);
    } catch {
      // Sinks must never throw. If one does, swallow — bad analytics must
      // not crash a render.
    }
  }
}

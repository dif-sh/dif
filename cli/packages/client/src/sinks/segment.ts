// Segment sink — `analytics.track("dif.exposure", { ... })`.

import type { ExposureEvent, Sink } from "../types.js";

/** Minimal Segment surface we depend on. */
interface SegmentLike {
  track(event: string, properties: Record<string, unknown>): void;
}

/**
 * Forward events to a Segment-shaped client (e.g. `window.analytics`).
 */
export function segmentSink(analytics: SegmentLike): Sink {
  return {
    kind: "segment",
    emit(event: ExposureEvent) {
      analytics.track(event.event, { ...event });
    },
  };
}

// Mixpanel sink.

import type { ExposureEvent, Sink } from "../types.js";

/** Minimal Mixpanel surface. */
interface MixpanelLike {
  track(event: string, properties?: Record<string, unknown>): void;
}

/**
 * Forward events to a Mixpanel-shaped client.
 */
export function mixpanelSink(mixpanel: MixpanelLike): Sink {
  return {
    kind: "mixpanel",
    emit(event: ExposureEvent) {
      mixpanel.track(event.event, { ...event });
    },
  };
}

// Amplitude sink.

import type { ExposureEvent, Sink } from "../types.js";

/** Minimal Amplitude surface. */
interface AmplitudeLike {
  track(event: string, properties?: Record<string, unknown>): void;
}

/**
 * Forward events to an Amplitude-shaped client.
 */
export function amplitudeSink(amplitude: AmplitudeLike): Sink {
  return {
    kind: "amplitude",
    emit(event: ExposureEvent) {
      amplitude.track(event.event, { ...event });
    },
  };
}

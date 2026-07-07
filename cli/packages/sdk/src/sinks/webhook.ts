// POSTs the raw event JSON to a URL. The lowest-common-denominator sink.

import type { ExposureEvent, Sink } from "../types.js";

/**
 * POST every event as JSON to `url`. Fire-and-forget; uses `navigator.sendBeacon`
 * when available so the request survives page nav.
 */
export function webhookSink(url: string): Sink {
  return {
    kind: "webhook",
    emit(event: ExposureEvent) {
      const body = JSON.stringify(event);
      try {
        if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
          navigator.sendBeacon(url, body);
          return;
        }
        // Swallow the rejection: an offline user or a CORS failure must not
        // surface as an unhandled rejection (sinks never throw).
        void fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => {});
      } catch {
        // fetch/sendBeacon unavailable or threw synchronously — drop the event.
      }
    },
  };
}

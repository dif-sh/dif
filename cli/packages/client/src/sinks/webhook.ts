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
      if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
        navigator.sendBeacon(url, body);
        return;
      }
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      });
    },
  };
}

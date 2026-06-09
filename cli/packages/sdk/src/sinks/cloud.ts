// Sends exposure events to dif.sh Cloud's /v1/exposure endpoint. Auto-attached
// by `setState` when a publishableKey is configured and the caller didn't pass
// a `sink`. Re-exported so customers who want to combine it with other sinks
// can configure it explicitly:
//
//   dif.init({
//     publishableKey: "dif_pk_…",
//     sink: [cloudSink({ apiUrl, publishableKey }), webhookSink("…")],
//   });
//
// Like `dif.track`, we use `fetch` (not `sendBeacon`) because we need to set
// `Authorization: Bearer <publishableKey>` on every request. `keepalive: true`
// keeps the request alive across page nav.

import type { ExposureEvent, Sink } from "../types.js";

export interface CloudSinkConfig {
  /** Cloud base URL (e.g. https://cloud.dif.sh). Trailing slashes are stripped. */
  apiUrl: string;
  /** Publishable key (dif_pk_…). Sent as the `Authorization: Bearer` header. */
  publishableKey: string;
}

export function cloudSink(cfg: CloudSinkConfig): Sink {
  const url = `${cfg.apiUrl.replace(/\/+$/, "")}/v1/exposure`;
  const auth = `Bearer ${cfg.publishableKey}`;
  return {
    kind: "cloud",
    emit(event: ExposureEvent) {
      const body = JSON.stringify(event);
      try {
        void fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: auth,
          },
          body,
          keepalive: true,
        }).catch(() => {
          // Swallow — analytics must never throw at the call site.
        });
      } catch {
        // Synchronous throws (fetch undefined, etc.) are also swallowed.
      }
    },
  };
}

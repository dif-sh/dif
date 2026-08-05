// dif.sh Cloud delivery. `cloudSink` posts exposures to `/v1/exposure`;
// `cloudTrack` posts `dif.track()` metrics to `/v1/track`. Both are wired by
// `setState` when events mode is cloud (the default). This is the built-in
// alternative to custom mode, where the user writes their own handlers.
//
// We use `fetch` (not `sendBeacon`) because we need to set
// `Authorization: Bearer <publishableKey>` on every request. `keepalive: true`
// keeps the request alive across page nav.

import type { ExposureEvent, MetricEvent, Sink } from "../types.js";

// Shared across cloudSink + cloudTrack — a bad publishableKey (401) or a dead
// endpoint (5xx) affects every event the same way, so one warning for the
// whole module is enough; repeating it per-call would spam the console.
let non2xxWarned = false;

/** Test-only. */
export function __resetCloudWarnings(): void {
  non2xxWarned = false;
}

function warnOnNon2xx(res: Response): void {
  if (res.ok || non2xxWarned) return;
  non2xxWarned = true;
  if (typeof console !== "undefined") {
    console.warn(
      `[dif] cloud rejected an event (HTTP ${res.status}) — check the publishableKey in ` +
        "dif/config.yaml. Further failures will be silent.",
    );
  }
}

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
        })
          .then(warnOnNon2xx)
          .catch(() => {
            // Swallow — analytics must never throw at the call site.
          });
      } catch {
        // Synchronous throws (fetch undefined, etc.) are also swallowed.
      }
    },
  };
}

export interface CloudTrackConfig {
  /** Cloud base URL (e.g. https://cloud.dif.sh). Trailing slashes are stripped. */
  apiUrl: string;
  /** Publishable key (dif_pk_…), or null. Without one, track events are dropped. */
  publishableKey: string | null;
}

/**
 * Build the cloud track handler: posts one `MetricEvent` to `<apiUrl>/v1/track`.
 * Without a publishableKey it logs to console.debug and drops — analytics must
 * never block, and the cloud requires authenticated writes.
 */
export function cloudTrack(cfg: CloudTrackConfig): (event: MetricEvent) => void {
  const url = `${cfg.apiUrl.replace(/\/+$/, "")}/v1/track`;
  const { publishableKey } = cfg;
  return (event: MetricEvent) => {
    if (!publishableKey) {
      if (typeof console !== "undefined") {
        console.debug("[dif] track (no publishableKey, dropped)", event.metric, event);
      }
      return;
    }
    const body = JSON.stringify(event);
    try {
      void fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${publishableKey}`,
        },
        body,
        keepalive: true,
      })
        .then(warnOnNon2xx)
        .catch(() => {
          // Swallow — analytics must never throw at the call site.
        });
    } catch {
      // Synchronous throws (fetch undefined, etc.) are also swallowed.
    }
  };
}

// dif.sh Cloud delivery. `cloudSink` posts exposures to `/v1/exposure`;
// `cloudTrack` posts `dif.track()` metrics to `/v1/track`. Both are wired by
// `setState` when events mode is cloud (the default). This is the built-in
// alternative to custom mode, where the user writes their own handlers.
//
// Each endpoint has one queue. See queue.ts.
//
// We use `fetch` (not `sendBeacon`) because we need to set
// `Authorization: Bearer <publishableKey>` on every request. `keepalive: true`
// keeps the request alive across page nav.

import { EventQueue, canObservePageHide } from "../queue.js";
import type { ExposureEvent, MetricEvent, Sink } from "../types.js";
import { validateExposure, validateTrack } from "../validate.js";

const BATCH_SIZE = 20;
const BATCH_INTERVAL_MS = 2000;

// Shared across cloudSink + cloudTrack — a bad publishableKey (401) or a dead
// endpoint (5xx) affects every event the same way, so one warning for the
// whole module is enough; repeating it per-call would spam the console.
let non2xxWarned = false;

/** Test-only. */
export function __resetCloudWarnings(): void {
  non2xxWarned = false;
}

function warnOnGiveUp(status: number | null): void {
  if (status === null || non2xxWarned) return;
  non2xxWarned = true;
  if (typeof console !== "undefined") {
    console.warn(
      `[dif] cloud rejected an event (HTTP ${status}) — check the publishableKey in ` +
        "dif/config.yaml. Further failures will be silent.",
    );
  }
}

function createQueue(
  apiUrl: string,
  path: string,
  key: string,
  label: string,
  validate: (parsed: unknown) => string | null,
): EventQueue {
  const browser = canObservePageHide();
  return new EventQueue({
    url: `${apiUrl.replace(/\/+$/, "")}${path}`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    label,
    validate,
    maxEvents: browser ? BATCH_SIZE : 1,
    intervalMs: BATCH_INTERVAL_MS,
    keepalive: true,
    lifecycle: browser,
    onGiveUp: warnOnGiveUp,
  });
}

export interface CloudSinkConfig {
  /** Cloud base URL (e.g. https://cloud.dif.sh). Trailing slashes are stripped. */
  apiUrl: string;
  /** Publishable key (dif_pk_…). Sent as the `Authorization: Bearer` header. */
  publishableKey: string;
}

export function cloudSink(cfg: CloudSinkConfig): Sink {
  let queue: EventQueue | null = null;
  const get = () =>
    (queue ??= createQueue(cfg.apiUrl, "/v1/exposure", cfg.publishableKey, "exposure", validateExposure));
  return {
    kind: "cloud",
    emit(event: ExposureEvent) {
      return get().add(event);
    },
    flush: () => (queue ? queue.flush() : Promise.resolve()),
    close: () => (queue ? queue.close() : Promise.resolve()),
  };
}

export interface CloudTrackConfig {
  /** Cloud base URL (e.g. https://cloud.dif.sh). Trailing slashes are stripped. */
  apiUrl: string;
  /** Publishable key (dif_pk_…), or null. Without one, track events are dropped. */
  publishableKey: string | null;
}

/** The track handler, with the queue's flush and close. */
export type CloudTrack = ((event: MetricEvent) => void) & {
  flush(): Promise<void>;
  close(): Promise<void>;
};

/**
 * Build the cloud track handler: queues one `MetricEvent` for `<apiUrl>/v1/track`.
 * Without a publishableKey it logs to console.debug and drops — analytics must
 * never block, and the cloud requires authenticated writes.
 */
export function cloudTrack(cfg: CloudTrackConfig): CloudTrack {
  const { publishableKey } = cfg;
  let queue: EventQueue | null = null;
  const handler = ((event: MetricEvent) => {
    if (!publishableKey) {
      if (typeof console !== "undefined") {
        console.debug("[dif] track (no publishableKey, dropped)", event.metric, event);
      }
      return;
    }
    queue ??= createQueue(cfg.apiUrl, "/v1/track", publishableKey, "track", validateTrack);
    void queue.add(event);
  }) as CloudTrack;
  handler.flush = () => (queue ? queue.flush() : Promise.resolve());
  handler.close = () => (queue ? queue.close() : Promise.resolve());
  return handler;
}

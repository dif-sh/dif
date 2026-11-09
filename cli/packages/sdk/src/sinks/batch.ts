// The third queue: page, identify and anonymous track elements
// go to dif-db's `/v1/batch`.

import type { BatchElement } from "../elements.js";
import { EventQueue, canObservePageHide } from "../queue.js";
import { validateElement } from "../validate.js";

const BATCH_SIZE = 20;
const BATCH_INTERVAL_MS = 2000;

// A 403 says site analytics is off for this key or node.
// Later requests get the same answer, so stop sending.
const refused = new Set<string>();
let refusedWarned = false;
let failedWarned = false;

/** Test-only. */
export function __resetBatchState(): void {
  refused.clear();
  refusedWarned = false;
  failedWarned = false;
}

function onGiveUp(url: string, status: number | null): void {
  if (status === 403) refused.add(url);
  if (typeof console === "undefined") return;
  if (status === 403) {
    if (refusedWarned) return;
    refusedWarned = true;
    console.warn(
      "[dif] the collector refused events (HTTP 403): site analytics is not on for " +
        "this key. No more page views are sent from this page.",
    );
  } else if (status !== null && !failedWarned) {
    failedWarned = true;
    console.warn(`[dif] the collector refused events (HTTP ${status}). Further failures are silent.`);
  }
}

export interface BatchSenderConfig {
  /** dif-db's ingest base URL. Trailing slashes are stripped. */
  ingestUrl: string;
  /** Publishable key (dif_pk_…). Sent as `?key=`. */
  publishableKey: string;
}

/** Queues one element, with the queue's flush and close. */
export type BatchSender = ((element: BatchElement) => void) & {
  flush(): Promise<void>;
  close(): Promise<void>;
};

export function batchSender(cfg: BatchSenderConfig): BatchSender {
  const base = cfg.ingestUrl.replace(/\/+$/, "");
  // A key in the URL and a text body
  // make a CORS simple request: no preflight.
  const url = `${base}/v1/batch?key=${encodeURIComponent(cfg.publishableKey)}`;
  let queue: EventQueue | null = null;
  const create = () => {
    const browser = canObservePageHide();
    return new EventQueue({
      url,
      headers: { "content-type": "text/plain;charset=UTF-8" },
      label: "batch",
      validate: validateElement,
      maxEvents: browser ? BATCH_SIZE : 1,
      intervalMs: BATCH_INTERVAL_MS,
      keepalive: true,
      lifecycle: browser,
      onGiveUp: (status) => onGiveUp(url, status),
    });
  };
  const sender = ((element: BatchElement) => {
    if (refused.has(url)) return;
    queue ??= create();
    void queue.add(element);
  }) as BatchSender;
  sender.flush = () => (queue ? queue.flush() : Promise.resolve());
  sender.close = () => (queue ? queue.close() : Promise.resolve());
  return sender;
}

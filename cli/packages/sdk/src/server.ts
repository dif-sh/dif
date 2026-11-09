// Server entrypoint — `@dif.sh/sdk/server`.
//
//   import { DifServer } from "@dif.sh/sdk/server";
//   const dif = new DifServer({ apiKey: process.env.DIF_KEY });
//   await dif.track({ metric: "completed_checkout", userId: user.id });
//
// HTTP POST to /v1/track, and /v1/batch for `page`. One call is
// one awaited request, unless `batch` is on. The bearer is a
// secret token, never a publishable key.

import type { PageElement } from "./elements.js";
import { uuidv7 } from "./event-id.js";
import { warnIfEventLimit } from "./limit.js";
import { EventQueue } from "./queue.js";
import { storedProps, warnName, warnProps } from "./props.js";
import { cleanPageUrl, cleanReferrer } from "./url.js";
import { validateElement, validateTrack } from "./validate.js";
import { SOURCE } from "./version.js";

const DEFAULT_API_URL = "https://cloud.dif.sh";
const DEFAULT_INGEST_URL = "https://ingest.difdb.com";
const DEFAULT_SOURCE = SOURCE;

export interface DifServerConfig {
  /** Secret bearer token: dif_<env>_<prefix>_<secret>. */
  apiKey: string;
  /** Optional project slug stamp; not used by the cloud but useful in logs. */
  project?: string;
  /** Cloud base URL. Defaults to https://cloud.dif.sh. */
  apiUrl?: string;
  /** dif-db's ingest base URL, for `page`. Defaults to https://ingest.difdb.com. */
  ingestUrl?: string;
  /** Overrides the SDK's "source" stamp on emitted events. */
  source?: string;
  /** Opt in to queued sends with retries. Default off. */
  batch?: boolean | DifServerBatchOptions;
}

export interface DifServerBatchOptions {
  /** Events per send, 1 to 500. Defaults to 20. */
  size?: number;
  /** Ms to wait for more events. Defaults to 2000. */
  intervalMs?: number;
}

export interface TrackInput {
  metric: string;
  userId: string;
  value?: number;
  currency?: string;
  unit?: string;
  firedAt?: number;
  idempotencyKey?: string;
  props?: Record<string, unknown>;
}

export interface PageInput {
  /** The page's absolute http(s) URL. */
  url: string;
  /** Required: a secret-key row cannot take a visitor id. */
  userId: string;
  referrer?: string;
  firedAt?: number;
  props?: Record<string, unknown>;
}

export class DifServer {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly ingestUrl: string;
  private readonly source: string;
  private readonly queue: EventQueue | null;
  private pageQueue: EventQueue | null = null;
  private readonly batchOpts: DifServerBatchOptions | null;
  private closed = false;

  constructor(cfg: DifServerConfig) {
    if (!cfg.apiKey) throw new Error("DifServer: apiKey is required");
    this.apiKey = cfg.apiKey;
    this.apiUrl = (cfg.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.ingestUrl = (cfg.ingestUrl ?? DEFAULT_INGEST_URL).replace(/\/+$/, "");
    this.source = cfg.source ?? DEFAULT_SOURCE;
    this.batchOpts = cfg.batch ? (cfg.batch === true ? {} : cfg.batch) : null;
    this.queue = this.batchOpts ? this.makeQueue(this.batchOpts) : null;
  }

  private makeQueue(opts: DifServerBatchOptions): EventQueue {
    return this.newQueue(opts, `${this.apiUrl}/v1/track`, "track", validateTrack);
  }

  // A queue is made on the first page call, so a
  // server that never sends a page view holds none.
  private makePageQueue(opts: DifServerBatchOptions): EventQueue {
    return this.newQueue(opts, `${this.ingestUrl}/v1/batch`, "batch", validateElement);
  }

  private newQueue(
    opts: DifServerBatchOptions,
    url: string,
    label: string,
    validate: (parsed: unknown) => string | null,
  ): EventQueue {
    const wanted = opts.size !== undefined && Number.isFinite(opts.size) ? opts.size : 20;
    const size = Math.min(500, Math.max(1, Math.floor(wanted)));
    return new EventQueue({
      url,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      label,
      validate,
      maxEvents: size,
      intervalMs: opts.intervalMs !== undefined && opts.intervalMs >= 0 ? opts.intervalMs : 2000,
      keepalive: false,
      lifecycle: false,
      onGiveUp: (status, events) => {
        if (!warnIfEventLimit(status) && typeof console !== "undefined") {
          console.warn(`[dif] ${label} batch of ${events} events failed (${status ?? "no response"})`);
        }
      },
    });
  }

  /** Sends queued events. Resolves when all are settled. */
  async flush(): Promise<void> {
    await Promise.all([this.queue?.flush(), this.pageQueue?.flush()]);
  }

  /** Flushes, then sends each call at once. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([this.queue?.close(), this.pageQueue?.close()]);
  }

  /** Sends one page view to /v1/batch. It needs a user id. */
  async page(input: PageInput): Promise<void> {
    const url = cleanPageUrl(input.url);
    if (url === null || !input.userId) {
      if (typeof console !== "undefined") {
        console.warn(
          url === null
            ? "[dif] page needs an absolute http(s) url under 8192 bytes; page view dropped"
            : "[dif] page needs a userId; page view dropped",
        );
      }
      return;
    }
    const referrer = input.referrer ? cleanReferrer(input.referrer) : null;
    const props = input.props === undefined ? undefined : storedProps(input.props);
    const element: PageElement = {
      type: "page",
      event_id: uuidv7(),
      fired_at: input.firedAt ?? Date.now(),
      source: this.source,
      user_id: input.userId,
      url,
      ...(referrer !== null && { referrer }),
      ...(props && Object.keys(props).length > 0 && { props }),
    };
    if (this.batchOpts && !this.closed) {
      this.pageQueue ??= this.makePageQueue(this.batchOpts);
      void this.pageQueue.add(element);
      return;
    }
    try {
      const res = await fetch(`${this.ingestUrl}/v1/batch`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(element),
      });
      if (!res.ok && !warnIfEventLimit(res.status) && typeof console !== "undefined") {
        console.warn(`[dif] page ${url} → ${res.status}`);
      }
    } catch (err) {
      if (typeof console !== "undefined") {
        console.warn(`[dif] page ${url} failed`, err);
      }
    }
  }

  async track(input: TrackInput): Promise<void> {
    const url = `${this.apiUrl}/v1/track`;
    const payload = {
      event_id: uuidv7(),
      metric: input.metric,
      user_id: input.userId,
      value: input.value,
      currency: input.currency,
      unit: input.unit,
      fired_at: input.firedAt ?? Date.now(),
      idempotency_key: input.idempotencyKey,
      source: this.source,
      props: input.props,
    };
    if (this.queue && !this.closed) {
      void this.queue.add(payload);
      return;
    }
    warnName("track", input.metric);
    warnProps(input.props);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok && !warnIfEventLimit(res.status) && typeof console !== "undefined") {
        console.warn(`[dif] track ${input.metric} → ${res.status}`);
      }
    } catch (err) {
      if (typeof console !== "undefined") {
        console.warn(`[dif] track ${input.metric} failed`, err);
      }
    }
  }
}

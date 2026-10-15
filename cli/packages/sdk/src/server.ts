// Server entrypoint — `@dif.sh/sdk/server`.
//
//   import { DifServer } from "@dif.sh/sdk/server";
//   const dif = new DifServer({ apiKey: process.env.DIF_KEY });
//   await dif.track({ metric: "completed_checkout", userId: user.id });
//
// HTTP POST to /v1/track. One call is one awaited request,
// unless `batch` is on. The bearer is a secret token,
// never a publishable key.

import { uuidv7 } from "./event-id.js";
import { EventQueue } from "./queue.js";
import { validateTrack } from "./validate.js";
import { SOURCE } from "./version.js";

const DEFAULT_API_URL = "https://cloud.dif.sh";
const DEFAULT_SOURCE = SOURCE;

export interface DifServerConfig {
  /** Secret bearer token: dif_<env>_<prefix>_<secret>. */
  apiKey: string;
  /** Optional project slug stamp; not used by the cloud but useful in logs. */
  project?: string;
  /** Cloud base URL. Defaults to https://cloud.dif.sh. */
  apiUrl?: string;
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

export class DifServer {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly source: string;
  private readonly queue: EventQueue | null;
  private closed = false;

  constructor(cfg: DifServerConfig) {
    if (!cfg.apiKey) throw new Error("DifServer: apiKey is required");
    this.apiKey = cfg.apiKey;
    this.apiUrl = (cfg.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.source = cfg.source ?? DEFAULT_SOURCE;
    this.queue = cfg.batch ? this.makeQueue(cfg.batch === true ? {} : cfg.batch) : null;
  }

  private makeQueue(opts: DifServerBatchOptions): EventQueue {
    const wanted = opts.size !== undefined && Number.isFinite(opts.size) ? opts.size : 20;
    const size = Math.min(500, Math.max(1, Math.floor(wanted)));
    return new EventQueue({
      url: `${this.apiUrl}/v1/track`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      label: "track",
      validate: validateTrack,
      maxEvents: size,
      intervalMs: opts.intervalMs !== undefined && opts.intervalMs >= 0 ? opts.intervalMs : 2000,
      keepalive: false,
      lifecycle: false,
      onGiveUp: (status, events) => {
        if (typeof console !== "undefined") {
          console.warn(`[dif] track batch of ${events} events failed (${status ?? "no response"})`);
        }
      },
    });
  }

  /** Sends queued events. Resolves when all are settled. */
  async flush(): Promise<void> {
    await this.queue?.flush();
  }

  /** Flushes, then sends each call at once. */
  async close(): Promise<void> {
    this.closed = true;
    await this.queue?.close();
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
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok && typeof console !== "undefined") {
        console.warn(`[dif] track ${input.metric} → ${res.status}`);
      }
    } catch (err) {
      if (typeof console !== "undefined") {
        console.warn(`[dif] track ${input.metric} failed`, err);
      }
    }
  }
}

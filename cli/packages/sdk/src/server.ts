// Server entrypoint — `@dif.sh/sdk/server`.
//
//   import { DifServer } from "@dif.sh/sdk/server";
//   const dif = new DifServer({ apiKey: process.env.DIF_KEY });
//   await dif.track({ metric: "completed_checkout", userId: user.id });
//
// Fire-and-forget HTTP POST to /v1/track. No batching, no retries in v0 — one
// call per event. The bearer is a secret token (dif_<env>_…), never a
// publishable key.

const DEFAULT_API_URL = "https://api.dif.sh";
const DEFAULT_SOURCE = "@dif.sh/sdk@0.4.0";

export interface DifServerConfig {
  /** Secret bearer token: dif_<env>_<prefix>_<secret>. */
  apiKey: string;
  /** Optional project slug stamp; not used by the cloud but useful in logs. */
  project?: string;
  /** Cloud base URL. Defaults to https://api.dif.sh. */
  apiUrl?: string;
  /** Overrides the SDK's "source" stamp on emitted events. */
  source?: string;
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

  constructor(cfg: DifServerConfig) {
    if (!cfg.apiKey) throw new Error("DifServer: apiKey is required");
    this.apiKey = cfg.apiKey;
    this.apiUrl = (cfg.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.source = cfg.source ?? DEFAULT_SOURCE;
  }

  async track(input: TrackInput): Promise<void> {
    const url = `${this.apiUrl}/v1/track`;
    const payload = {
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

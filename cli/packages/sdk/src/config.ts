// Module-singleton runtime config for @dif.sh/sdk.
//
// `dif.init(cfg)` calls setState(cfg); `dif()` and `dif.track()` read it via
// getState(). One config per bundle; calling init again overwrites. This is
// intentional — there is only one "current user" per app instance.

import { cloudSink, cloudTrack } from "./sinks/cloud.js";
import type {
  AttributeBag,
  DifConfig,
  DifInitConfig,
  MetricEvent,
  Sink,
} from "./types.js";

export type { DifInitConfig };

export interface ResolvedState {
  project: string | null;
  publishableKey: string | null;
  apiUrl: string;
  userId: () => string | null;
  attributes: () => AttributeBag;
  sinks: Sink[];
  /** Where `dif.track()` metrics go — cloud POST or the user's custom handler. */
  trackHandler: (event: MetricEvent) => void;
  enabled: boolean;
  /** Active QA/preview forces (experiment id → variant). */
  overrides: Record<string, string>;
}

let state: ResolvedState | null = null;

// dif.sh Cloud's public ingest host. The SDK posts to `${apiUrl}/v1/*`, which
// the cloud rewrites to its `/api/v1/*` handlers. (api.dif.sh is not a real
// host — point at cloud.dif.sh, or your own deployment via `apiUrl`.)
const DEFAULT_API_URL = "https://cloud.dif.sh";

export function setState(cfg: DifInitConfig | DifConfig): void {
  const merged = cfg as DifInitConfig;
  const events = merged.events;
  // Publishable key precedence: an explicit top-level `publishableKey` wins,
  // then the one `dif build` baked into the generated cloud `events` object
  // (from `dif connect` / `dif init --key`). This is deliberately the INVERSE
  // of the `apiUrl` resolution below — an explicit key is an intentional
  // per-environment override and must beat the generated default, and this
  // keeps existing env-var wiring (`publishableKey: process.env.X`) working
  // unchanged. Custom mode carries no key, so it's provably untouched.
  const eventsKey = events?.mode === "cloud" ? events.publishableKey : undefined;
  const publishableKey = merged.publishableKey ?? eventsKey ?? null;

  // Two delivery modes. Custom routes exposures + tracks to the user's handlers
  // (generated from `dif/events/{exposure,track}.ts`). Cloud — the default when
  // no `events` config is present — posts to dif.sh Cloud, attaching the cloud
  // sink only when a publishable key is configured.
  let apiUrl: string;
  let sinks: Sink[];
  let trackHandler: (event: MetricEvent) => void;

  if (events?.mode === "custom") {
    apiUrl = stripTrailing(merged.apiUrl ?? DEFAULT_API_URL);
    sinks = [{ kind: "custom", emit: events.exposure }];
    trackHandler = events.track;
  } else {
    apiUrl = stripTrailing(events?.apiUrl ?? merged.apiUrl ?? DEFAULT_API_URL);
    sinks = publishableKey ? [cloudSink({ apiUrl, publishableKey })] : [];
    trackHandler = cloudTrack({ apiUrl, publishableKey });
  }

  state = {
    project: merged.project ?? null,
    publishableKey,
    apiUrl,
    userId: merged.userId ?? (() => null),
    attributes: merged.attributes ?? (() => ({})),
    sinks,
    trackHandler,
    enabled: merged.enabled !== false,
    overrides: merged.overrides ?? {},
  };
}

export function getState(): ResolvedState | null {
  return state;
}

/**
 * Replace the active QA/preview overrides (experiment id → forced variant).
 * Pass `{}` to clear. No-op before `dif.init` runs — adapters init first, then
 * reconcile overrides from the URL/cookie.
 */
export function setOverrides(overrides: Record<string, string>): void {
  if (state) state.overrides = overrides;
}

/** The active QA/preview overrides, or an empty map. */
export function getOverrides(): Record<string, string> {
  return state?.overrides ?? {};
}

/** Test-only. */
export function resetState(): void {
  state = null;
}

function stripTrailing(url: string): string {
  return url.replace(/\/+$/, "");
}

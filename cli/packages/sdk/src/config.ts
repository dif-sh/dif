// Module-singleton runtime config for @dif.sh/sdk.
//
// `dif.init(cfg)` calls setState(cfg); `dif()` and `dif.track()` read it via
// getState(). One config per bundle; calling init again overwrites. This is
// intentional — there is only one "current user" per app instance.

import { cloudSink, cloudTrack, type CloudTrack } from "./sinks/cloud.js";
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
  /** Sends the events the cloud queues hold. */
  flush: () => Promise<void>;
}

let state: ResolvedState | null = null;

/** Cloud delivery from the last init. */
interface CloudDelivery {
  apiUrl: string;
  publishableKey: string | null;
  sink: Sink | null;
  track: CloudTrack;
}

let cloud: CloudDelivery | null = null;

function closeCloud(): void {
  const old = cloud;
  cloud = null;
  void old?.sink?.close?.();
  void old?.track.close();
}

// One-shot warnings for cloud-mode misconfiguration — fire once per bundle
// load so a noisy app doesn't spam the console on every re-init/re-render.
let noKeyWarned = false;
let noUserIdWarned = false;

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
    closeCloud();
    sinks = [{ kind: "custom", emit: events.exposure }];
    trackHandler = events.track;
  } else {
    apiUrl = stripTrailing(events?.apiUrl ?? merged.apiUrl ?? DEFAULT_API_URL);
    // A repeat init keeps its queues, so batching holds.
    if (!cloud || cloud.apiUrl !== apiUrl || cloud.publishableKey !== publishableKey) {
      closeCloud();
      cloud = {
        apiUrl,
        publishableKey,
        sink: publishableKey ? cloudSink({ apiUrl, publishableKey }) : null,
        track: cloudTrack({ apiUrl, publishableKey }),
      };
    }
    sinks = cloud.sink ? [cloud.sink] : [];
    trackHandler = cloud.track;

    if (merged.enabled !== false) {
      if (!publishableKey && !noKeyWarned) {
        noKeyWarned = true;
        if (typeof console !== "undefined") {
          console.warn(
            "[dif] events mode is cloud but no publishableKey is set — exposures and " +
              "track() will be dropped. Run `dif connect --key <dif_pk_…>` then `dif build`, " +
              "or set events.mode: custom.",
          );
        }
      }
      if (merged.userId === undefined && !noUserIdWarned) {
        noUserIdWarned = true;
        if (typeof console !== "undefined") {
          console.warn(
            "[dif] init was called without a userId — every user gets the control variant " +
              "and no events are sent. Pass userId: () => currentUser?.id ?? null.",
          );
        }
      }
    }
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
    flush: flushCloud,
  };
}

function flushCloud(): Promise<void> {
  if (!cloud) return Promise.resolve();
  return Promise.all([cloud.sink?.flush?.(), cloud.track.flush()]).then(() => undefined);
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
  closeCloud();
  state = null;
  noKeyWarned = false;
  noUserIdWarned = false;
}

function stripTrailing(url: string): string {
  return url.replace(/\/+$/, "");
}

// Module-singleton runtime config for @dif.sh/sdk.
//
// `dif.init(cfg)` calls setState(cfg); `dif()` and `dif.track()` read it via
// getState(). One config per bundle; calling init again overwrites. This is
// intentional — there is only one "current user" per app instance.

import { cloudSink } from "./sinks/cloud.js";
import type { AttributeBag, DifConfig, DifInitConfig, Sink } from "./types.js";

export type { DifInitConfig };

export interface ResolvedState {
  project: string | null;
  publishableKey: string | null;
  apiUrl: string;
  userId: () => string | null;
  attributes: () => AttributeBag;
  sinks: Sink[];
  enabled: boolean;
}

let state: ResolvedState | null = null;

// dif.sh Cloud's public ingest host. The SDK posts to `${apiUrl}/v1/*`, which
// the cloud rewrites to its `/api/v1/*` handlers. (api.dif.sh is not a real
// host — point at cloud.dif.sh, or your own deployment via `apiUrl`.)
const DEFAULT_API_URL = "https://cloud.dif.sh";

export function setState(cfg: DifInitConfig | DifConfig): void {
  const merged = cfg as DifInitConfig;
  const sinkVal = merged.sink;
  const apiUrl = stripTrailing(merged.apiUrl ?? DEFAULT_API_URL);
  const publishableKey = merged.publishableKey ?? null;

  // Auto-attach the cloud sink when the caller didn't specify any sinks and a
  // publishable key is configured. Without this, exposures fired by `dif(...)`
  // call sites silently drop on the floor even though `dif.track` already
  // posts to the same cloud. Opt out by passing `sink: []`; replace by passing
  // `sink: yourSink` or `sink: [yourSink]`.
  let sinks: Sink[];
  if (sinkVal === undefined) {
    sinks = publishableKey ? [cloudSink({ apiUrl, publishableKey })] : [];
  } else {
    sinks = Array.isArray(sinkVal) ? sinkVal : [sinkVal];
  }

  state = {
    project: merged.project ?? null,
    publishableKey,
    apiUrl,
    userId: merged.userId ?? (() => null),
    attributes: merged.attributes ?? (() => ({})),
    sinks,
    enabled: merged.enabled !== false,
  };
}

export function getState(): ResolvedState | null {
  return state;
}

/** Test-only. */
export function resetState(): void {
  state = null;
}

function stripTrailing(url: string): string {
  return url.replace(/\/+$/, "");
}

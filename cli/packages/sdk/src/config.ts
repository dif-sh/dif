// Module-singleton runtime config for @dif.sh/sdk.
//
// `dif.init(cfg)` calls setState(cfg); `dif()` and `dif.track()` read it via
// getState(). One config per bundle; calling init again overwrites. This is
// intentional — there is only one "current user" per app instance.

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

const DEFAULT_API_URL = "https://api.dif.sh";

export function setState(cfg: DifInitConfig | DifConfig): void {
  const merged = cfg as DifInitConfig;
  const sinkVal = merged.sink;
  const sinks = sinkVal === undefined ? [] : Array.isArray(sinkVal) ? sinkVal : [sinkVal];
  state = {
    project: merged.project ?? null,
    publishableKey: merged.publishableKey ?? null,
    apiUrl: stripTrailing(merged.apiUrl ?? DEFAULT_API_URL),
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

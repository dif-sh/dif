// @dif.sh/sdk — browser entrypoint.
//
// `dif` is a callable object: it works as a function for experiment assignment
// AND carries methods for init / track. This lets the cloud-page snippets
// (`dif.init`, `dif.track`) coexist with existing call sites (`dif("id", branches)`).

import { difCall, __register, __resetRegistry } from "./core.js";
import { __resetExposures } from "./exposure.js";
import { setState, resetState, setOverrides, getOverrides, type DifInitConfig } from "./config.js";
import { track } from "./track.js";
import type { DifConfig, TrackProps } from "./types.js";

/** Public type of the `dif` export. Function call signature + method bag. */
export interface DifFn {
  <V extends string, R>(id: string, branches: Record<V, () => R>): () => R;
  /** Initialize the SDK. Call once at app boot. */
  init(config: DifInitConfig): void;
  /** Fire a metric event. */
  track(metric: string, opts?: TrackProps): void;
  /** Set the active QA/preview forces (experiment id → variant). `{}` clears. */
  setOverrides(overrides: Record<string, string>): void;
  /** The active QA/preview forces. */
  getOverrides(): Record<string, string>;
  /**
   * Legacy alias for {@link DifFn.init}. Accepts the older config shape.
   * @deprecated Use `dif.init(...)`.
   */
  configure(config: DifConfig | DifInitConfig): void;
}

function init(config: DifInitConfig): void {
  setState(config);
}

function configure(config: DifConfig | DifInitConfig): void {
  setState(config);
}

export const dif: DifFn = Object.assign(difCall, {
  init,
  track,
  setOverrides,
  getOverrides,
  configure,
});

// Legacy named export so customer code that imported `configure` directly
// still compiles after the rename. Same body as `dif.configure`.
export { configure };

// Internal hooks (used by the generated client.ts + tests).
export { __register };
export function __reset(): void {
  __resetRegistry();
  __resetExposures();
  resetState();
}

// SSR-safe assignment primitives — used by framework adapters (e.g. @dif.sh/svelte)
// to assign on the server without firing exposures or touching the init singleton.
export { assign, registered, getSpec, recordExposure } from "./core.js";
export type { AssignContext, Assignment } from "./core.js";
export { bucket, selectVariant, saltFor, BUCKET_NAMESPACE } from "./bucket.js";

// QA / preview overrides — `?_dif=` URL param + `_dif` cookie support.
export { setOverrides, getOverrides } from "./config.js";
export {
  parseOverrides,
  serializeOverrides,
  syncOverrides,
  clearOverrides,
  mountDifPreview,
} from "./overrides.js";
export type { SyncOverridesOptions, MountPreviewOptions } from "./overrides.js";

// Re-exports — types and the built-in cloud delivery.
export type {
  AttrValue,
  AttributeBag,
  AudienceFn,
  DifConfig,
  DifInitConfig,
  EventsConfig,
  ExperimentSpec,
  ExposureEvent,
  MetricEvent,
  Sink,
  TrackProps,
  UserIdFn,
} from "./types.js";
export { cloudSink, cloudTrack } from "./sinks/cloud.js";

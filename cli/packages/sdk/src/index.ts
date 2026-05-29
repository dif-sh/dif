// @dif.sh/sdk — browser entrypoint.
//
// `dif` is a callable object: it works as a function for experiment assignment
// AND carries methods for init / track. This lets the cloud-page snippets
// (`dif.init`, `dif.track`) coexist with existing call sites (`dif("id", branches)`).

import { difCall, __register, __resetRegistry } from "./core.js";
import { setState, resetState, type DifInitConfig } from "./config.js";
import { track } from "./track.js";
import type { DifConfig, TrackProps } from "./types.js";

/** Public type of the `dif` export. Function call signature + method bag. */
export interface DifFn {
  <V extends string, R>(id: string, branches: Record<V, () => R>): () => R;
  /** Initialize the SDK. Call once at app boot. */
  init(config: DifInitConfig): void;
  /** Fire a metric event. */
  track(metric: string, opts?: TrackProps): void;
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
  configure,
});

// Legacy named export so customer code that imported `configure` directly
// still compiles after the rename. Same body as `dif.configure`.
export { configure };

// Internal hooks (used by the generated client.ts + tests).
export { __register };
export function __reset(): void {
  __resetRegistry();
  resetState();
}

// Re-exports — types and sinks.
export type {
  AttrValue,
  AttributeBag,
  AudienceFn,
  DifConfig,
  DifInitConfig,
  ExperimentSpec,
  ExposureEvent,
  MetricEvent,
  Sink,
  TrackProps,
  UserIdFn,
} from "./types.js";
export { webhookSink } from "./sinks/webhook.js";
export { segmentSink } from "./sinks/segment.js";
export { amplitudeSink } from "./sinks/amplitude.js";
export { mixpanelSink } from "./sinks/mixpanel.js";

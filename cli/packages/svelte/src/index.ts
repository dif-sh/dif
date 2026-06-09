// @dif.sh/svelte — Svelte 5 adapter for @dif.sh/sdk.
//
//   • Server:    difLoad() in +layout.server.ts  (import from "@dif.sh/svelte/server")
//   • Client:    initDif() once in the root +layout.svelte, then
//                setContext(DIF_CONTEXT_KEY, data.dif)
//   • Component: experiment(id, branches) → a store of the assigned branch value
//
// The server helper lives at the "@dif.sh/svelte/server" subpath so importing it
// from +*.server.ts never pulls client code into the server bundle.

import { dif } from "@dif.sh/sdk";
import type { TrackProps } from "@dif.sh/sdk";

export { initDif } from "./init.js";
export type { InitDifOptions } from "./init.js";
export { experiment } from "./experiment.js";
export type { ExperimentValue } from "./experiment.js";
export { DIF_CONTEXT_KEY } from "./context.js";
export type { DifData, SerializedAssignment } from "./context.js";

/** Fire a metric event. Thin re-export of `dif.track`. */
export function track(metric: string, opts?: TrackProps): void {
  dif.track(metric, opts);
}

export type { DifInitConfig, TrackProps } from "@dif.sh/sdk";

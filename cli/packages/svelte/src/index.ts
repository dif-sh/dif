// @dif.sh/svelte — Svelte 5 adapter for @dif.sh/sdk.
//
//   • Server:    difLoad() in +layout.server.ts  (import from "@dif.sh/svelte/server"),
//                after importing dif/generated/client to register experiments
//   • Client:    in the root +layout.svelte, import dif/generated/client again
//                (the browser bundle has its own registry), then
//                setContext(DIF_CONTEXT_KEY, data.dif) and call
//                initDif({ data: data.dif, events }) once, with `events` from
//                dif/generated/events
//   • Component: experiment(id, branches) → a store of the assigned branch value
//
// `dif build` writes dif/generated/ at the project root, so from src/routes/
// the imports are "../../dif/generated/client" and "../../dif/generated/events".
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

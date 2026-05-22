// @dif.sh/client — public API.
//
// The generated TS file (.dif/generated/client.ts) imports `__register` from
// here and registers one spec per active experiment as a side effect. The
// customer's code calls `dif("id", branches)` at render sites; the SDK looks
// the spec up in the registry, evaluates audience/exclusion/bucketing, fires
// an exposure event, and returns the matching branch's value through a thunk.

import type { DifConfig, ExperimentSpec, Sink } from "./types.js";
import { bucket, selectVariant } from "./bucket.js";
import { fireExposure } from "./exposure.js";

let currentConfig: DifConfig | null = null;

/** Experiment specs the generated file has registered. */
const registry = new Map<string, ExperimentSpec>();

/**
 * Configure the SDK once, at app boot. Subsequent calls replace the previous
 * config — there is no merge behavior.
 */
export function configure(config: DifConfig): void {
  currentConfig = config;
}

/**
 * Register an experiment spec into the runtime registry. Called by the
 * generated `.dif/generated/client.ts` file; customer code should not call
 * this directly.
 *
 * The double-underscore prefix is a convention signaling "internal but
 * exported because tooling needs it." The name is stable — the codegen
 * emits this exact identifier.
 */
export function __register(spec: ExperimentSpec): void {
  registry.set(spec.id, spec);
}

/**
 * Customer API. Looks up the experiment spec, resolves the user's assignment,
 * fires an exposure event, and returns a thunk that yields the matching
 * branch's value.
 *
 * ```ts
 * const cta = dif("checkout-cta-v2", {
 *   control: () => "Buy now",
 *   variant_a: () => "Get it today",
 * });
 *
 * // at render time
 * <Button>{cta()}</Button>
 * ```
 *
 * Unknown experiment ids fall back to the first declared branch. `dif build`
 * catches these as orphan refs at compile time; the runtime fallback exists
 * so a missed cleanup doesn't crash production.
 */
export function dif<V extends string, R>(
  id: string,
  branches: Record<V, () => R>,
): () => R {
  return () => {
    const variant = resolve(id, branches);
    return branches[variant]();
  };
}

/**
 * Pick the variant for one call. The full resolution flow:
 *
 *   1. Unknown id → fall back to the first declared branch. (`dif validate`
 *      catches these as orphan refs at build time; this is the runtime safety
 *      net.)
 *   2. Disabled / no user / config missing → return the experiment's first
 *      declared variant (the control). Do **not** fire exposure — we never
 *      saw a real user.
 *   3. Audience predicate misses → control variant, no exposure.
 *   4. Otherwise: bucket (deterministic SHA-256), pick variant by cumulative
 *      weight, fire one exposure event, return the variant.
 */
function resolve<V extends string, R>(id: string, branches: Record<V, () => R>): V {
  const spec = registry.get(id);
  const variantKeys = Object.keys(branches) as V[];
  if (variantKeys.length === 0) {
    throw new Error(`dif("${id}"): branches map is empty`);
  }
  if (!spec) {
    return variantKeys[0] as V;
  }

  const cfg = currentConfig;
  if (!cfg || cfg.enabled === false) {
    return spec.variants[0] as V;
  }
  const userId = cfg.userId();
  if (userId === null) {
    return spec.variants[0] as V;
  }

  const attrs = cfg.attributes?.() ?? {};
  if (!spec.audience(attrs)) {
    return spec.variants[0] as V;
  }

  const b = bucket(spec.salt, userId);
  const picked = selectVariant(spec.variants, spec.weights, b) ?? spec.variants[0];
  fireExposure(spec, picked!, userId, b, sinks(cfg.sink));
  return picked as V;
}

/** Test-only: clear the registry. Not exported from the package index. */
export function __resetRegistry(): void {
  registry.clear();
  currentConfig = null;
}

/** Normalize the configured sink(s) into an array. */
function sinks(s: Sink | Sink[]): Sink[] {
  return Array.isArray(s) ? s : [s];
}

export type { DifConfig, ExperimentSpec, ExposureEvent, Sink } from "./types.js";
export { webhookSink } from "./sinks/webhook.js";
export { segmentSink } from "./sinks/segment.js";
export { amplitudeSink } from "./sinks/amplitude.js";
export { mixpanelSink } from "./sinks/mixpanel.js";

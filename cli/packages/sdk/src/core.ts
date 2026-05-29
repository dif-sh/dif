// Experiment-assignment core. Lifted from the old @dif.sh/sdk index.ts
// substantively unchanged — the only swap is reading config via getState()
// instead of a module-local `currentConfig` variable.

import type { ExperimentSpec } from "./types.js";
import { bucket, selectVariant } from "./bucket.js";
import { fireExposure } from "./exposure.js";
import { getState } from "./config.js";

/** Experiment specs the generated file has registered. */
const registry = new Map<string, ExperimentSpec>();

/**
 * Register an experiment spec into the runtime registry. Called by the
 * generated `.dif/generated/client.ts` file; customer code should not call
 * this directly. The name is stable — the codegen emits this exact identifier.
 */
export function __register(spec: ExperimentSpec): void {
  registry.set(spec.id, spec);
}

/** Test-only: clear the registry + state. Not exported from the package index. */
export function __resetRegistry(): void {
  registry.clear();
}

/**
 * Customer API. Looks up the experiment spec, resolves the user's assignment,
 * fires an exposure event, and returns a thunk that yields the matching
 * branch's value.
 *
 * Unknown experiment ids fall back to the first declared branch. `dif build`
 * catches these as orphan refs at compile time; the runtime fallback exists
 * so a missed cleanup doesn't crash production.
 */
export function difCall<V extends string, R>(
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
 *   1. Unknown id → fall back to the first declared branch.
 *   2. Disabled / no user / config missing → control variant, no exposure.
 *   3. Audience predicate misses → control variant, no exposure.
 *   4. Otherwise: bucket, pick by cumulative weight, fire one exposure event.
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

  const state = getState();
  if (!state || state.enabled === false) {
    return spec.variants[0] as V;
  }
  const userId = state.userId();
  if (userId === null) {
    return spec.variants[0] as V;
  }

  const attrs = state.attributes();
  if (!spec.audience(attrs)) {
    return spec.variants[0] as V;
  }

  const b = bucket(spec.salt, userId);
  const picked = selectVariant(spec.variants, spec.weights, b) ?? spec.variants[0];
  fireExposure(spec, picked!, userId, b, state.sinks);
  return picked as V;
}

// Experiment-assignment core. Lifted from the old @dif.sh/sdk index.ts
// substantively unchanged — the only swap is reading config via getState()
// instead of a module-local `currentConfig` variable.

import type { AttributeBag, ExperimentSpec } from "./types.js";
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
 * Read-only snapshot of every registered spec, in registration order. SSR
 * adapters use this to assign all experiments for a request; the browser
 * `dif()` path does not need it.
 */
export function registered(): ReadonlyArray<ExperimentSpec> {
  return Array.from(registry.values());
}

/** Look up a single registered spec by id, or `undefined`. */
export function getSpec(id: string): ExperimentSpec | undefined {
  return registry.get(id);
}

/**
 * Per-request assignment context. Supplied explicitly so a server never reads
 * the module-global init state (which is shared across every request).
 */
export interface AssignContext {
  /** Resolved user id for this request. `null` ⇒ control, no exposure. */
  userId: string | null;
  /** Resolved audience attribute bag for this request. */
  attributes: AttributeBag;
  /** QA/preview forces (experiment id → variant). A match returns that variant
   *  with `forced:true` and `exposed:false` — it never fires an exposure. */
  overrides?: Record<string, string>;
}

/** Outcome of a pure assignment. */
export interface Assignment {
  /** Chosen variant id — always a member of the spec's declared variants. */
  variant: string;
  /** Bucket `0..9999`, or `null` when the assignment fell through (no user /
   *  audience miss) or was forced. */
  bucket: number | null;
  /** True when the user was bucketed into a real variant and an exposure is owed. */
  exposed: boolean;
  /** True when this variant came from a QA/preview override. */
  forced?: boolean;
}

/**
 * Pure variant selection: no exposure firing, no reads/writes of module-global
 * init state. Mirrors {@link resolve}'s decision tree but returns the decision
 * instead of acting on it, so a server can call it per request with an explicit
 * context — never touching the shared singleton or firing an event.
 *
 * Returns `null` for an unknown id; only the browser caller knows the `branches`
 * map whose first key is the true fallback.
 */
export function assign(id: string, ctx: AssignContext): Assignment | null {
  const spec = registry.get(id);
  if (!spec) return null;

  // QA/preview force takes precedence over user/audience/exclusion/kill-switch —
  // but only for a real declared variant. A forced assignment never fires an
  // exposure (bucket null, exposed false), so it can't pollute results.
  const forced = ctx.overrides?.[id];
  if (forced !== undefined && spec.variants.includes(forced)) {
    return { variant: forced, bucket: null, exposed: false, forced: true };
  }

  const control = spec.variants[0]!;
  if (ctx.userId === null) {
    return { variant: control, bucket: null, exposed: false };
  }
  if (!spec.audience(ctx.attributes)) {
    return { variant: control, bucket: null, exposed: false };
  }

  const b = bucket(spec.salt, ctx.userId);
  const picked = selectVariant(spec.variants, spec.weights, b) ?? control;
  return { variant: picked, bucket: b, exposed: true };
}

/**
 * Client-only: fire exactly one exposure for an already-decided assignment,
 * using the current init state's sinks/userId and the supplied variant/bucket
 * (typically the server's decision). Deduped per `(id, user)` via the same set
 * as `dif(...)`, so a later bare `dif(id, …)()` won't double-fire.
 *
 * No-op when uninitialized, disabled, or `userId` is null. The caller is
 * responsible for only invoking this on the client (e.g. after mount).
 */
export function recordExposure(id: string, variant: string, bucket: number): void {
  const spec = registry.get(id);
  const state = getState();
  if (!spec || !state || state.enabled === false) return;
  const userId = state.userId();
  if (userId === null) return;
  fireExposure(spec, variant, userId, bucket, state.sinks);
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
  const variantKeys = Object.keys(branches) as V[];
  if (variantKeys.length === 0) {
    throw new Error(`dif("${id}"): branches map is empty`);
  }

  const spec = registry.get(id);
  if (!spec) {
    return variantKeys[0] as V;
  }

  const state = getState();
  if (!state || state.enabled === false) {
    return spec.variants[0] as V;
  }

  // Delegate the decision to the pure assigner, then own the side effect.
  // `assign` is non-null here because `spec` exists.
  const userId = state.userId();
  const result = assign(id, {
    userId,
    attributes: state.attributes(),
    overrides: state.overrides,
  })!;
  if (result.exposed && result.bucket !== null && userId !== null) {
    fireExposure(spec, result.variant, userId, result.bucket, state.sinks);
  }
  return result.variant as V;
}

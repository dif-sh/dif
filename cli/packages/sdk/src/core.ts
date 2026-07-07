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
  driftWarned.clear();
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

  const control = spec.variants[0]!;

  // Exclusion-group arbitration mirrors `dif qa` (dif-core exclusion.rs):
  // within a group, sorted by (created, id), the first member with a valid
  // force wins; otherwise the first member whose audience matches. A losing
  // member falls back to control with no exposure — even if it is itself
  // forced or audience-eligible.
  if (spec.exclusionGroup !== null && exclusionGroupWinner(spec, ctx) !== id) {
    return { variant: control, bucket: null, exposed: false };
  }

  // QA/preview force takes precedence over user/audience/kill-switch — but
  // only for a real declared variant. A forced assignment never fires an
  // exposure (bucket null, exposed false), so it can't pollute results.
  const forced = ctx.overrides?.[id];
  if (forced !== undefined && spec.variants.includes(forced)) {
    return { variant: forced, bucket: null, exposed: false, forced: true };
  }

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
 * The id of the experiment that wins `spec`'s exclusion group for this
 * context, mirroring `pick_winner` in dif-core: members sorted by
 * (created, id); the first validly-forced member wins, else the first whose
 * audience matches. Returns `null` when no member is eligible.
 */
function exclusionGroupWinner(spec: ExperimentSpec, ctx: AssignContext): string | null {
  const members = Array.from(registry.values())
    .filter((s) => s.exclusionGroup === spec.exclusionGroup)
    .sort((a, b) => {
      // `?? ""` tolerates a stale generated client.ts from before `created`
      // was emitted — those specs sort first, deterministically by id.
      const ac = a.created ?? "";
      const bc = b.created ?? "";
      if (ac !== bc) return ac < bc ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  for (const m of members) {
    const f = ctx.overrides?.[m.id];
    if (f !== undefined && m.variants.includes(f)) return m.id;
  }
  for (const m of members) {
    if (m.audience(ctx.attributes)) return m.id;
  }
  return null;
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

/** Experiments already warned about branch/spec drift — one warning each. */
const driftWarned = new Set<string>();

/** The chosen variant if the branches map can render it, else the first branch
 *  key — warning once per experiment on drift so the mismatch is visible in
 *  dev without spamming production consoles. */
function branchOrFallback<V extends string, R>(
  id: string,
  variant: string,
  branches: Record<V, () => R>,
  fallback: V,
): V {
  if (variant in branches) return variant as V;
  if (!driftWarned.has(id)) {
    driftWarned.add(id);
    if (typeof console !== "undefined") {
      console.warn(
        `[dif] dif("${id}"): assigned variant "${variant}" has no matching branch — ` +
          `rendering "${fallback}". Re-run \`dif build\` and sync the call site.`,
      );
    }
  }
  return fallback;
}

/**
 * Pick the variant for one call. The full resolution flow:
 *
 *   1. Unknown id → fall back to the first declared branch.
 *   2. A valid QA force wins — including over a disabled/uninitialized SDK —
 *      and emits no exposure.
 *   3. Disabled / no user / config missing → control variant, no exposure.
 *   4. Audience predicate misses → control variant, no exposure.
 *   5. Otherwise: bucket, pick by cumulative weight, fire one exposure event.
 *
 * A variant the branches map can't render falls back to the first branch key
 * and never fires an exposure — a missed cleanup must not crash production or
 * pollute results with an unrendered variant.
 */
function resolve<V extends string, R>(id: string, branches: Record<V, () => R>): V {
  const variantKeys = Object.keys(branches) as V[];
  if (variantKeys.length === 0) {
    throw new Error(`dif("${id}"): branches map is empty`);
  }
  const fallback = variantKeys[0] as V;

  const spec = registry.get(id);
  if (!spec) {
    return fallback;
  }

  const state = getState();

  // A QA force beats the kill switch (docs: "a valid QA force wins"), so
  // previews keep working in environments that disable the SDK. It does NOT
  // beat group arbitration: when two members of one exclusion group are both
  // forced, the earliest (created, id) one wins — same rule as `dif qa`.
  // (With this spec forced, the winner comes from the forced pass alone, so
  // empty attributes are safe here.)
  const forced = state?.overrides?.[id];
  if (forced !== undefined && spec.variants.includes(forced)) {
    const winsGroup =
      spec.exclusionGroup === null ||
      exclusionGroupWinner(spec, {
        userId: null,
        attributes: {},
        overrides: state?.overrides ?? {},
      }) === id;
    if (winsGroup) {
      return branchOrFallback(id, forced, branches, fallback);
    }
  }

  if (!state || state.enabled === false) {
    return branchOrFallback(id, spec.variants[0]!, branches, fallback);
  }

  // Delegate the decision to the pure assigner, then own the side effect.
  // `assign` is non-null here because `spec` exists.
  const userId = state.userId();
  const result = assign(id, {
    userId,
    attributes: state.attributes(),
    overrides: state.overrides,
  })!;
  const variant = branchOrFallback(id, result.variant, branches, fallback);
  if (
    variant === result.variant &&
    result.exposed &&
    result.bucket !== null &&
    userId !== null
  ) {
    fireExposure(spec, result.variant, userId, result.bucket, state.sinks);
  }
  return variant;
}

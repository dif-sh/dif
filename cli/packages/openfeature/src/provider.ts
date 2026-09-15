// OpenFeature server provider for dif.sh.
//
// A bridge, not the primary API: the typed `dif()` call from `@dif.sh/sdk` is
// still how dif is meant to be used. This provider lets a team that has
// standardised on OpenFeature evaluate the same experiments through
// `OpenFeature.getClient()`.
//
// Every decision is delegated to the SDK's pure `assign()` — the same function
// `@dif.sh/svelte` uses on the server — so a user gets the same variant here as
// from `dif()`. The spec registry is filled by the generated
// `dif/generated/client.ts` (side-effect import), so that file must be imported
// before the first evaluation.

import {
  ErrorCode,
  StandardResolutionReasons,
  type EvaluationContext,
  type FlagMetadata,
  type JsonValue,
  type Provider,
  type ResolutionDetails,
} from "@openfeature/server-sdk";
import {
  assign,
  getSpec,
  type AssignContext,
  type Assignment,
  type AttributeBag,
  type ExperimentSpec,
} from "@dif.sh/sdk";

/** Payload passed to {@link DifOpenFeatureProviderOptions.onExposure}. */
export interface DifExposure {
  /** Experiment id (the OpenFeature flag key). */
  flagKey: string;
  /** Variant id the user was bucketed into. */
  variant: string;
  /** Bucket `0..9999`. */
  bucket: number;
  /** The evaluation context's `targetingKey`. */
  userId: string;
}

/**
 * QA/preview forces (experiment id → variant id). Either a fixed map or a
 * function of the evaluation context, e.g. to read a `_dif` value you put on
 * the context from a request cookie.
 */
export type DifOverrides =
  | Record<string, string>
  | ((context: EvaluationContext) => Record<string, string> | undefined);

export interface DifOpenFeatureProviderOptions {
  /** QA/preview forces. A valid force resolves with reason `STATIC` and never
   *  calls `onExposure`. A variant id the spec doesn't declare is ignored. */
  overrides?: DifOverrides;
  /** Called when an evaluation bucketed a real user into a variant (reason
   *  `SPLIT`). Called on every such evaluation — not deduped. Errors thrown
   *  here are swallowed so they never change an evaluation result. */
  onExposure?: (exposure: DifExposure) => void;
}

interface Evaluated {
  spec: ExperimentSpec;
  assignment: Assignment;
}

export class DifOpenFeatureProvider implements Provider {
  readonly metadata = { name: "dif.sh" } as const;
  readonly runsOn = "server";

  readonly #overrides: DifOverrides | undefined;
  readonly #onExposure: ((exposure: DifExposure) => void) | undefined;

  constructor(options: DifOpenFeatureProviderOptions = {}) {
    this.#overrides = options.overrides;
    this.#onExposure = options.onExposure;
  }

  /** `value` and `variant` are the assigned variant id. */
  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext = {},
  ): Promise<ResolutionDetails<string>> {
    const result = this.#evaluate(flagKey, context);
    if (!result) return flagNotFound(flagKey, defaultValue);
    return details(result, result.assignment.variant);
  }

  /** `value` is `true` for any variant other than the first declared one
   *  (the control), so `off`/`on` and `control`/`variant_a` both map to
   *  `false`/`true`. `variant` is the variant id. */
  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext = {},
  ): Promise<ResolutionDetails<boolean>> {
    const result = this.#evaluate(flagKey, context);
    if (!result) return flagNotFound(flagKey, defaultValue);
    return details(result, result.assignment.variant !== result.spec.variants[0]);
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
  ): Promise<ResolutionDetails<number>> {
    return typeMismatch(flagKey, defaultValue, "number");
  }

  async resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
  ): Promise<ResolutionDetails<T>> {
    return typeMismatch(flagKey, defaultValue, "object");
  }

  #evaluate(flagKey: string, context: EvaluationContext): Evaluated | null {
    const spec = getSpec(flagKey);
    if (!spec) return null;

    const userId = userIdFrom(context);
    const ctx: AssignContext = { userId, attributes: attributesFrom(context) };
    const overrides =
      typeof this.#overrides === "function" ? this.#overrides(context) : this.#overrides;
    if (overrides) ctx.overrides = overrides;

    const assignment = assign(flagKey, ctx);
    if (!assignment) return null;

    if (
      this.#onExposure &&
      assignment.exposed &&
      assignment.bucket !== null &&
      userId !== null
    ) {
      try {
        this.#onExposure({
          flagKey,
          variant: assignment.variant,
          bucket: assignment.bucket,
          userId,
        });
      } catch {
        // An exposure sink must never change what the caller renders.
      }
    }

    return { spec, assignment };
  }
}

/** `targetingKey` → dif user id. Missing, empty, or non-string ⇒ `null`
 *  (control, no exposure) — an empty string would otherwise put every
 *  anonymous request into one shared bucket. */
function userIdFrom(context: EvaluationContext): string | null {
  const key: unknown = context.targetingKey;
  return typeof key === "string" && key !== "" ? key : null;
}

/** Every other top-level scalar (string / number / boolean / null) becomes an
 *  audience attribute. Dates, objects, and arrays are skipped: dif audience
 *  predicates only compare scalars. */
function attributesFrom(context: EvaluationContext): AttributeBag {
  const attrs: AttributeBag = {};
  for (const [key, value] of Object.entries(context)) {
    if (key === "targetingKey") continue;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      attrs[key] = value;
    }
  }
  return attrs;
}

function details<T>({ spec, assignment }: Evaluated, value: T): ResolutionDetails<T> {
  const flagMetadata: FlagMetadata = { surface: spec.surface };
  if (assignment.bucket !== null) flagMetadata.bucket = assignment.bucket;
  return {
    value,
    variant: assignment.variant,
    reason: assignment.forced
      ? StandardResolutionReasons.STATIC
      : assignment.exposed
        ? StandardResolutionReasons.SPLIT
        : StandardResolutionReasons.DEFAULT,
    flagMetadata,
  };
}

function flagNotFound<T>(flagKey: string, defaultValue: T): ResolutionDetails<T> {
  return {
    value: defaultValue,
    reason: StandardResolutionReasons.ERROR,
    errorCode: ErrorCode.FLAG_NOT_FOUND,
    errorMessage:
      `dif: no experiment "${flagKey}" is registered. Import the generated client ` +
      `(import "./dif/generated/client") before evaluating, and run \`dif build\` ` +
      `after adding or renaming a dif/experiments/active/*.md file.`,
  };
}

function typeMismatch<T>(
  flagKey: string,
  defaultValue: T,
  requested: "number" | "object",
): ResolutionDetails<T> {
  return {
    value: defaultValue,
    reason: StandardResolutionReasons.ERROR,
    errorCode: ErrorCode.TYPE_MISMATCH,
    errorMessage:
      `dif: "${flagKey}" can't resolve as ${requested === "number" ? "a number" : "an object"}. ` +
      `dif flags resolve to a variant id (getStringValue) or a boolean ` +
      `(getBooleanValue: true for any variant other than the first declared).`,
  };
}

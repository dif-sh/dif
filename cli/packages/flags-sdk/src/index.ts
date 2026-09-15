import {
  type Assignment,
  type AttributeBag,
  type ExperimentSpec,
  assign,
  getSpec,
  parseOverrides,
  registered,
} from '@dif.sh/sdk';
import type {
  Adapter,
  FlagDefinitionsType,
  Identify,
  ProviderData,
  ReadonlyRequestCookies,
} from 'flags';

export type { AttributeBag };

/**
 * The evaluation context the dif adapter buckets on.
 *
 * `userId` is hashed with the experiment's salt to pick a bucket `0..9999`.
 * `attributes` feed the experiment's compiled `audience:` predicate.
 */
export type DifEntities = {
  /** Stable id to bucket on. `null` serves the first declared variant and records no exposure. */
  userId: string | null;
  /** Audience attributes (`locale`, `device_type`, `plan`, ...). Defaults to `{}`. */
  attributes?: AttributeBag;
};

/** Cookie holding the anonymous id `identify` reads. Same name `@dif.sh/svelte` mints. */
export const DIF_UID_COOKIE = 'dif_uid';

/**
 * Cookie holding QA forces in the `id=variant,id2=variant` form that
 * `dif qa --force` preview links (`?_dif=...`) write.
 */
export const DIF_OVERRIDES_COOKIE = '_dif';

/** Payload passed to {@link DifAdapterOptions.onExposure}. */
export type DifExposure = {
  /** Flag key, which is the experiment id (the `.md` filename stem). */
  key: string;
  /** Variant the user was bucketed into. */
  variant: string;
  /** Bucket `0..9999`. */
  bucket: number;
  /** The `userId` that was bucketed. */
  userId: string;
};

export interface DifAdapterOptions {
  /** Cookie `identify` reads the user id from. Default `"dif_uid"`. */
  cookieName?: string;
  /** Honor the `_dif` QA force cookie. Default `true`; pass `false` to ignore it (e.g. in production). */
  overrides?: boolean;
  /**
   * Called once per `decide` that buckets a user into a variant. Not called for
   * a `null` userId, an audience miss, an exclusion-group loss, or a `_dif`
   * force. Errors and rejections are logged and never change the decision; the
   * returned promise is not awaited, so wrap slow work in `waitUntil`.
   */
  onExposure?: (exposure: DifExposure) => void | Promise<void>;
  /** Where a flag is managed, e.g. its `.md` file on GitHub. Shown in the Flags Explorer. */
  origin?: string | ((key: string) => string | undefined);
}

export type DifAdapter = {
  /** Adapter resolving to the assigned variant id (`"control"`, `"variant_a"`, ...). */
  variant: <V extends string = string>() => Adapter<V, DifEntities>;
  /**
   * Adapter resolving to `true` when the assigned variant is not the first
   * declared variant, or, with `{ on }`, when it equals `on`.
   */
  isEnabled: (options?: { on?: string }) => Adapter<boolean, DifEntities>;
  /** Reads `userId` from the `dif_uid` cookie. Returns `attributes: {}`. */
  identify: Identify<DifEntities>;
};

const PACKAGE = '@flags-sdk/dif';

function readCookie(
  cookies: ReadonlyRequestCookies | undefined,
  name: string,
): string | undefined {
  const value = cookies?.get(name)?.value;
  return value ? value : undefined;
}

/** Browsers write `_dif` URL-encoded (`a%3Dv1%2Cb%3Dv2`); some cookie parsers decode it, some don't. */
function decodeCookie(value: string | undefined): string | undefined {
  if (value === undefined || !value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unknownKeyError(key: string): Error {
  return new Error(
    `${PACKAGE}: No dif experiment is registered for flag "${key}". ` +
      `Import the generated client once in flags.ts (import './dif/generated/client'), ` +
      `run \`dif build\`, and check that dif/experiments/active/${key}.md has \`status: active\`.`,
  );
}

/**
 * Create a dif adapter for the Flags SDK.
 *
 * Assignment is local: `decide` calls `assign()` from `@dif.sh/sdk` against the
 * specs `dif/generated/client.ts` registered. No network request is made.
 *
 * ```ts
 * // flags.ts
 * import './dif/generated/client';
 * import { flag } from 'flags/next';
 * import { createDifAdapter } from '@flags-sdk/dif';
 *
 * const dif = createDifAdapter({
 *   onExposure: ({ key, variant, userId }) => track('dif.exposure', { key, variant, userId }),
 * });
 *
 * export const newCheckout = flag({
 *   key: 'new-checkout',
 *   defaultValue: false,
 *   adapter: dif.isEnabled(),
 * });
 * ```
 */
export function createDifAdapter(options: DifAdapterOptions = {}): DifAdapter {
  const cookieName = options.cookieName ?? DIF_UID_COOKIE;
  const honorOverrides = options.overrides !== false;
  const onExposure = options.onExposure;
  const adapterId = Symbol(PACKAGE);

  const identify: Identify<DifEntities> = ({ cookies }) => ({
    userId: readCookie(cookies, cookieName) ?? null,
    attributes: {},
  });

  function reportExposure(exposure: DifExposure): void {
    if (!onExposure) return;
    try {
      const result = onExposure(exposure);
      if (result && typeof result.then === 'function') {
        result.then(undefined, (error: unknown) => {
          console.error(`${PACKAGE}: onExposure rejected`, error);
        });
      }
    } catch (error) {
      console.error(`${PACKAGE}: onExposure threw`, error);
    }
  }

  function decideAssignment({
    key,
    entities,
    cookies,
  }: {
    key: string;
    entities?: DifEntities;
    cookies: ReadonlyRequestCookies;
  }): { assignment: Assignment; spec: ExperimentSpec } {
    const userId =
      (entities ? entities.userId : readCookie(cookies, cookieName)) ?? null;
    const overrides = honorOverrides
      ? (parseOverrides(
          decodeCookie(readCookie(cookies, DIF_OVERRIDES_COOKIE)),
        ) ?? {})
      : {};

    const assignment = assign(key, {
      userId,
      attributes: entities?.attributes ?? {},
      overrides,
    });
    const spec = getSpec(key);
    if (!assignment || !spec) throw unknownKeyError(key);

    if (assignment.exposed && assignment.bucket !== null && userId !== null) {
      reportExposure({
        key,
        variant: assignment.variant,
        bucket: assignment.bucket,
        userId,
      });
    }
    return { assignment, spec };
  }

  function base<V>(): Omit<Adapter<V, DifEntities>, 'decide'> {
    return {
      adapterId,
      identify,
      ...(options.origin !== undefined ? { origin: options.origin } : {}),
    };
  }

  function variant<V extends string = string>(): Adapter<V, DifEntities> {
    return {
      ...base<V>(),
      decide(params): V {
        return decideAssignment(params).assignment.variant as V;
      },
    };
  }

  function isEnabled(
    isEnabledOptions: { on?: string } = {},
  ): Adapter<boolean, DifEntities> {
    const on = isEnabledOptions.on;
    return {
      ...base<boolean>(),
      decide(params): boolean {
        const { assignment, spec } = decideAssignment(params);
        if (on === undefined) return assignment.variant !== spec.variants[0];
        if (!spec.variants.includes(on)) {
          throw new Error(
            `${PACKAGE}: isEnabled({ on: "${on}" }): "${on}" is not a declared variant of "${params.key}" ` +
              `(variants: ${spec.variants.join(', ')}).`,
          );
        }
        return assignment.variant === on;
      },
    };
  }

  return { variant, isEnabled, identify };
}

let defaultDifAdapter: DifAdapter | undefined;

function getOrCreateDefaultAdapter(): DifAdapter {
  if (!defaultDifAdapter) {
    defaultDifAdapter = createDifAdapter();
  }
  return defaultDifAdapter;
}

/**
 * The default dif adapter: `dif_uid` cookie, `_dif` forces honored, no
 * exposure callback. Use {@link createDifAdapter} to change any of those.
 *
 * ```ts
 * // flags.ts
 * import './dif/generated/client';
 * import { flag } from 'flags/next';
 * import { difAdapter } from '@flags-sdk/dif';
 *
 * export const heroCta = flag<string>({
 *   key: 'home-hero-cta',
 *   defaultValue: 'control',
 *   adapter: difAdapter.variant(),
 * });
 * ```
 */
export const difAdapter: DifAdapter = {
  variant: <V extends string = string>() =>
    getOrCreateDefaultAdapter().variant<V>(),
  isEnabled: (...args) => getOrCreateDefaultAdapter().isEnabled(...args),
  identify: (params) => getOrCreateDefaultAdapter().identify(params),
};

function describe(spec: ExperimentSpec): string {
  const weights = spec.variants
    .map((v) => `${v} ${spec.weights[v] ?? 0}%`)
    .join(', ');
  const group =
    spec.exclusionGroup !== null
      ? ` Exclusion group: ${spec.exclusionGroup}.`
      : '';
  return `Surface: ${spec.surface}. Weights: ${weights}. Fallback: ${spec.variants[0]}.${group}`;
}

/** The two fields of a `flag()` declaration {@link getProviderData} reads. */
type DeclaredFlag = { key: string; defaultValue?: unknown };

function isDeclaredFlag(value: unknown): value is DeclaredFlag {
  return (
    (typeof value === 'function' ||
      (typeof value === 'object' && value !== null)) &&
    typeof (value as DeclaredFlag).key === 'string'
  );
}

/**
 * Get Flags Explorer data for every experiment `dif/generated/client.ts`
 * registered. Import the generated client (or your `flags.ts`) in the route
 * first, or the registry is empty.
 *
 * Each definition lists the declared variants as options. Pass your `flags.ts`
 * exports as `flags` and any flag with a boolean `defaultValue` (an
 * `isEnabled()` flag) gets `false`/`true` options instead, so a Flags Explorer
 * override has the type the flag returns.
 *
 * ```ts
 * // app/.well-known/vercel/flags/route.ts
 * import { createFlagsDiscoveryEndpoint } from 'flags/next';
 * import { getProviderData } from '@flags-sdk/dif';
 * import * as flags from '../../../../flags';
 *
 * export const GET = createFlagsDiscoveryEndpoint(() => getProviderData({ flags }));
 * ```
 */
export function getProviderData(
  options: {
    origin?: DifAdapterOptions['origin'];
    /** Your `flags.ts` exports. Used only to find flags with a boolean `defaultValue`. */
    flags?: Record<string, unknown>;
  } = {},
): ProviderData {
  const booleanKeys = new Set<string>();
  for (const declared of Object.values(options.flags ?? {})) {
    if (isDeclaredFlag(declared) && typeof declared.defaultValue === 'boolean') {
      booleanKeys.add(declared.key);
    }
  }

  const specs = registered();
  const definitions = specs.reduce<FlagDefinitionsType>((acc, spec) => {
    const origin =
      typeof options.origin === 'function'
        ? options.origin(spec.id)
        : options.origin;
    acc[spec.id] = {
      options: booleanKeys.has(spec.id)
        ? [
            { value: false, label: `Disabled (${spec.variants[0]})` },
            { value: true, label: 'Enabled' },
          ]
        : spec.variants.map((v) => ({ value: v, label: v })),
      description: describe(spec),
      ...(origin !== undefined ? { origin } : {}),
    };
    return acc;
  }, {});

  return {
    definitions,
    hints:
      specs.length === 0
        ? [
            {
              key: 'dif/empty-registry',
              text: `${PACKAGE}: no experiments are registered. Import './dif/generated/client' in this route and run \`dif build\`.`,
            },
          ]
        : [],
  };
}

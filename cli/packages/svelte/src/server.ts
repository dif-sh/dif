// @dif.sh/svelte/server — SSR helpers.
//
// Pure TypeScript: importable from `+layout.server.ts` / `+page.server.ts`
// without dragging in any client/component code. Computes assignments on the
// server with the SDK's pure `assign()` (no exposure firing, no shared init
// singleton) and returns a serializable blob for the client.

import {
  assign,
  registered,
  parseOverrides,
  serializeOverrides,
  type AttributeBag,
} from "@dif.sh/sdk";
import type { DifData, SerializedAssignment } from "./context.js";

const COOKIE = "dif_uid";
const OVERRIDE_COOKIE = "_dif";
const ONE_YEAR = 60 * 60 * 24 * 365;

/** Structural subset of SvelteKit's `RequestEvent.cookies` we use. Declared
 *  here so `@sveltejs/kit` stays an optional peer — no value import. */
export interface DifCookies {
  get(name: string): string | undefined;
  set(
    name: string,
    value: string,
    opts: {
      path: string;
      httpOnly?: boolean;
      sameSite?: "lax" | "strict" | "none";
      secure?: boolean;
      maxAge?: number;
    },
  ): void;
}

export interface DifHeaders {
  get(name: string): string | null;
}

/** The bits of SvelteKit's `RequestEvent` that {@link difLoad} needs. `url` is
 *  optional only so older callers/tests keep compiling — SvelteKit always
 *  provides it, and it's required to honor `?_dif=` preview links server-side. */
export interface DifRequestEventLike {
  cookies: DifCookies;
  request: { headers: DifHeaders };
  url?: { searchParams: { get(name: string): string | null } };
}

export interface DifLoadOptions {
  /** Extra app-context attributes (plan, user_role, …) merged over header-derived ones. */
  attributes?: AttributeBag;
  /** Cookie name. Default `"dif_uid"`. */
  cookieName?: string;
  /** Custom attribute derivation. Defaults to {@link attributesFromHeaders}. */
  deriveAttributes?: (headers: DifHeaders) => AttributeBag;
  /** Kill switch — when `false`, returns no assignments (client shows control everywhere). */
  enabled?: boolean;
  /** Cookie `SameSite` (default `"lax"`). Use `"none"` for cross-site flows. */
  sameSite?: "lax" | "strict" | "none";
  /** Cookie `Secure` flag (default `true`). */
  secure?: boolean;
  /** Honor `?_dif=` / `_dif`-cookie QA forces. Default `true`; set `false` to gate by env. */
  allowOverrides?: boolean;
}

/**
 * Call inside `+layout.server.ts` / `+page.server.ts`. Reads or mints the
 * `dif_uid` cookie, derives audience attributes from request headers, assigns
 * every registered experiment, and returns a serializable blob for the client.
 *
 * ```ts
 * import "$lib/dif/generated/client";          // populate the registry (side effect)
 * import { difLoad } from "@dif.sh/svelte/server";
 * export const load = (event) => ({ dif: difLoad(event) });
 * ```
 *
 * Note: on an ISR-cached route the server `load` won't re-run per visitor, so
 * the client falls back to assigning from the cookie. Don't server-assign on
 * ISR routes unless you also vary the cache key on the relevant headers.
 */
export function difLoad(event: DifRequestEventLike, opts: DifLoadOptions = {}): DifData {
  const name = opts.cookieName ?? COOKIE;
  let difUid = event.cookies.get(name);
  if (!difUid) {
    difUid = crypto.randomUUID();
    event.cookies.set(name, difUid, {
      path: "/",
      // The client must read this to seed its userId so it buckets identically
      // to the server — hence httpOnly:false (it carries no secret, just a
      // random anonymous id).
      httpOnly: false,
      sameSite: opts.sameSite ?? "lax",
      secure: opts.secure ?? true,
      maxAge: ONE_YEAR,
    });
  }

  const derive = opts.deriveAttributes ?? attributesFromHeaders;
  const attributes: AttributeBag = {
    ...derive(event.request.headers),
    ...(opts.attributes ?? {}),
  };

  const overrides = opts.allowOverrides === false ? {} : resolveOverrides(event);

  const assignments: Record<string, SerializedAssignment> = {};
  if (opts.enabled !== false) {
    for (const spec of registered()) {
      const a = assign(spec.id, { userId: difUid, attributes, overrides });
      if (a) {
        assignments[spec.id] = { variant: a.variant, bucket: a.bucket, exposed: a.exposed };
      }
    }
  }

  return { difUid, cookieName: name, assignments, attributes, overrides };
}

/**
 * Reconcile QA/preview forces from the `?_dif=` URL param (which wins) or the
 * persisted `_dif` cookie, persisting the active set to a **session** cookie
 * (no maxAge) so it survives navigation but clears on tab close. `?_dif=off`
 * clears it.
 */
function resolveOverrides(event: DifRequestEventLike): Record<string, string> {
  const param = event.url?.searchParams.get(OVERRIDE_COOKIE) ?? null;
  if (param !== null) {
    const parsed = parseOverrides(param);
    if (parsed === null) {
      event.cookies.set(OVERRIDE_COOKIE, "", { path: "/", maxAge: 0, sameSite: "lax", httpOnly: false });
      return {};
    }
    event.cookies.set(OVERRIDE_COOKIE, serializeOverrides(parsed), {
      path: "/",
      sameSite: "lax",
      httpOnly: false,
    });
    return parsed;
  }
  return parseOverrides(event.cookies.get(OVERRIDE_COOKIE)) ?? {};
}

/**
 * Default request-header → audience-attribute mapping. Deliberately small and
 * dependency-free; override via `DifLoadOptions.deriveAttributes` for anything
 * richer. Maps `Accept-Language` → `locale` and `User-Agent` → `device_type`
 * so they match the scaffolded `dif/audiences/*` resolvers' shape.
 */
export function attributesFromHeaders(headers: DifHeaders): AttributeBag {
  const out: AttributeBag = {};
  const al = headers.get("accept-language");
  if (al) {
    const locale = al.split(",")[0]?.trim().split(";")[0]?.trim();
    if (locale) out.locale = locale;
  }
  const ua = headers.get("user-agent") ?? "";
  const isTablet = /iPad|Tablet/i.test(ua);
  const isMobile = /Mobi|Android|iPhone/i.test(ua);
  out.device_type = isTablet ? "tablet" : isMobile ? "mobile" : "desktop";
  return out;
}

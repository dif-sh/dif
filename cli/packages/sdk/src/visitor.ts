// `anonymousUserId: true`: a first-party visitor id in a cookie.

import { uuidv7 } from "./event-id.js";

export const DEFAULT_VISITOR_COOKIE = "dif_uid";

const ONE_YEAR_S = 365 * 24 * 60 * 60;

// A browser can block cookie writes.
// This keeps one id for the page load.
let minted: { name: string; id: string } | null = null;

/** Test-only. */
export function __resetVisitor(): void {
  minted = null;
}

function readCookie(name: string): string | null {
  try {
    const all = (globalThis as { document?: { cookie?: string } }).document?.cookie ?? "";
    for (const part of all.split("; ")) {
      const i = part.indexOf("=");
      if (part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1)) || null;
    }
  } catch {
    // An opaque origin throws on document.cookie.
  }
  return null;
}

/** The visitor id from the cookie. Mints one in a browser. */
export function visitorId(name: string): string | null {
  const g = globalThis as { document?: { cookie?: string }; location?: { protocol?: string } };
  // A server renders pages for many visitors.
  if (typeof g.document === "undefined") return null;
  const found = readCookie(name);
  if (found !== null) return found;
  if (minted?.name === name) return minted.id;
  const id = uuidv7();
  minted = { name, id };
  const secure = g.location?.protocol === "https:" ? "; secure" : "";
  try {
    g.document.cookie =
      `${name}=${encodeURIComponent(id)}; path=/; max-age=${ONE_YEAR_S}; samesite=lax${secure}`;
  } catch {
    // The page-load id still works.
  }
  return id;
}

// QA / preview overrides.
//
// Reads the `?_dif=` URL param (and the matching `_dif` cookie), persists the
// active forces for the session, and feeds them into SDK state so `dif(...)` /
// `assign(...)` serve the forced variant — and never fire an exposure. Also a
// tiny imperatively-mounted preview badge so QA/designers/PMs can see and clear
// a forced state.
//
// The `_dif` wire form matches `dif qa --preview-url`: a comma-separated list of
// `id=variant` pairs (`a=v1,b=v2`). `?_dif=off` (or `clear`) clears.

import { setOverrides, getOverrides } from "./config.js";

const COOKIE = "_dif";
const BADGE_ID = "dif-preview-badge";

/**
 * Parse a `_dif` value (already URL-decoded) into a force map. Returns `null`
 * when the value asks to clear (`off`/`clear`); an empty value yields `{}`.
 * Reused for both the URL param and the cookie.
 */
export function parseOverrides(raw: string | null | undefined): Record<string, string> | null {
  if (raw == null) return {};
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  if (trimmed === "off" || trimmed === "clear") return null;
  const out: Record<string, string> = {};
  for (const pair of trimmed.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const id = pair.slice(0, eq).trim();
    const variant = pair.slice(eq + 1).trim();
    if (id && variant) out[id] = variant;
  }
  return out;
}

/** Serialize a force map to the `_dif` wire form: `a=v1,b=v2`, sorted by id. */
export function serializeOverrides(map: Record<string, string>): string {
  return Object.keys(map)
    .sort()
    .map((id) => `${id}=${map[id]}`)
    .join(",");
}

export interface SyncOverridesOptions {
  /** When `false`, overrides are ignored and cleared (e.g. gate by environment). */
  allow?: boolean;
}

/**
 * Browser-only. Reconcile QA/preview forces from the `?_dif=` URL param (which
 * wins) or the persisted `_dif` cookie, persist the active set to a **session**
 * cookie, strip the param from the address bar, push the set into SDK state, and
 * return it. Safe no-op on the server.
 */
export function syncOverrides(opts: SyncOverridesOptions = {}): Record<string, string> {
  if (typeof window === "undefined" || typeof document === "undefined") return {};
  if (opts.allow === false) {
    deleteCookie(COOKIE);
    setOverrides({});
    return {};
  }

  const url = new URL(window.location.href);
  const param = url.searchParams.get(COOKIE);
  let active: Record<string, string>;
  if (param !== null) {
    const parsed = parseOverrides(param);
    if (parsed === null) {
      deleteCookie(COOKIE);
      active = {};
    } else {
      active = parsed;
      writeSessionCookie(COOKIE, serializeOverrides(active));
    }
    // Strip the param so the address bar stays clean; the force lives in the cookie.
    url.searchParams.delete(COOKIE);
    try {
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    } catch {
      // replaceState can throw in exotic sandboxes — non-fatal.
    }
  } else {
    active = parseOverrides(readCookie(COOKIE)) ?? {};
  }
  setOverrides(active);
  return active;
}

/** Clear every QA/preview force (cookie + state) and update the badge. Browser-only. */
export function clearOverrides(): void {
  deleteCookie(COOKIE);
  setOverrides({});
  mountDifPreview({ overrides: {} });
}

export interface MountPreviewOptions {
  /** Forces to display. Defaults to the SDK's active overrides. */
  overrides?: Record<string, string>;
}

/**
 * Browser-only. Inject a small fixed-position badge when any QA/preview force is
 * active — listing each `id → variant` with a one-click Clear. Idempotent;
 * removes the badge when nothing is forced. Built with `createElement` +
 * `addEventListener` (no inline handlers) so it's safe under a strict CSP.
 */
export function mountDifPreview(opts: MountPreviewOptions = {}): void {
  if (typeof document === "undefined") return;
  const overrides = opts.overrides ?? getOverrides();
  const ids = Object.keys(overrides).sort();
  document.getElementById(BADGE_ID)?.remove();
  if (ids.length === 0) return;

  const box = document.createElement("div");
  box.id = BADGE_ID;
  box.setAttribute("role", "status");
  box.style.cssText =
    "position:fixed;bottom:12px;right:12px;z-index:2147483647;max-width:320px;" +
    "padding:10px 12px;border-radius:10px;background:#111;color:#fff;" +
    "font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.3)";

  const head = document.createElement("div");
  head.style.cssText =
    "display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:6px";
  const title = document.createElement("b");
  title.textContent = "dif preview";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "clear ✕";
  clear.style.cssText =
    "background:none;border:0;color:#7db3ff;cursor:pointer;font:inherit;padding:0";
  clear.addEventListener("click", () => {
    clearOverrides();
    if (typeof window !== "undefined") window.location.reload();
  });
  head.append(title, clear);
  box.append(head);

  for (const id of ids) {
    const row = document.createElement("div");
    const k = document.createElement("span");
    k.style.opacity = "0.6";
    k.textContent = id;
    const v = document.createElement("b");
    v.textContent = overrides[id]!;
    row.append(k, document.createTextNode(" → "), v);
    box.append(row);
  }

  document.body.appendChild(box);
}

// -- cookie helpers (browser-guarded) -----------------------------------------

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]!) : null;
}

function writeSessionCookie(name: string, value: string): void {
  if (typeof document === "undefined") return;
  // Session cookie (no max-age) — a forced preview clears when the tab closes.
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; samesite=lax`;
}

function deleteCookie(name: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
}

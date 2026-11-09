// Query strings can hold tokens and emails.
// What the SDK does not send needs no erasure.

/** The query params the SDK keeps. */
export const KEPT_PARAMS: readonly string[] = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
];

// The collector keeps the name in `$click_id`.
/** Query params sent with no value. dif-db's `CLICK_IDS`. */
export const CLICK_IDS: readonly string[] = [
  "gclid",
  "gbraid",
  "wbraid",
  "dclid",
  "fbclid",
  "msclkid",
  "ttclid",
  "twclid",
  "li_fat_id",
  "yclid",
  "mc_eid",
];

/** The collector refuses a longer page URL. */
export const MAX_URL_BYTES = 8192;

function parse(href: string, base?: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

function paramName(segment: string): string | null {
  const eq = segment.indexOf("=");
  const raw = eq === -1 ? segment : segment.slice(0, eq);
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

// Kept segments keep their bytes, so values stay as sent.
function keep(segment: string): string | null {
  const name = paramName(segment);
  if (name === null) return null;
  if (KEPT_PARAMS.includes(name)) return segment;
  if (!CLICK_IDS.includes(name)) return null;
  const eq = segment.indexOf("=");
  return `${eq === -1 ? segment : segment.slice(0, eq)}=`;
}

function clean(u: URL): string {
  const kept = u.search
    .slice(1)
    .split("&")
    .map(keep)
    .filter((s): s is string => s !== null);
  // `;jsessionid=` and its kind carry session tokens.
  if (u.pathname.includes(";")) {
    u.pathname = u.pathname
      .split("/")
      .map((segment) => segment.split(";")[0])
      .join("/");
  }
  u.hash = "";
  u.username = "";
  u.password = "";
  u.search = kept.length ? `?${kept.join("&")}` : "";
  return u.href;
}

/**
 * The URL with no fragment and only the kept params.
 * Null when it is not http(s) or is too long.
 */
export function cleanPageUrl(href: string, base?: string): string | null {
  const u = parse(href, base);
  if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return null;
  const url = clean(u);
  // An http(s) href is ASCII, so its length is its bytes.
  return url.length > MAX_URL_BYTES ? null : url;
}

/**
 * The referrer, cleaned as a page URL.
 * The collector reads `android-app://` referrers, so they stay.
 */
export function cleanReferrer(href: string): string | null {
  const u = parse(href);
  if (!u || u.host === "") return null;
  return clean(u);
}

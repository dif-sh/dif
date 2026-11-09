// Reads the browser fields a page element carries.
// Servers do not have these globals. Each read allows for that.

interface BrowserGlobals {
  location?: { href?: unknown };
  document?: { referrer?: unknown };
  screen?: { width?: unknown; height?: unknown };
  navigator?: { language?: unknown; webdriver?: unknown };
}

function browser(): BrowserGlobals {
  return globalThis as BrowserGlobals;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** `location.href`, or null. */
export function currentHref(): string | null {
  return text(browser().location?.href);
}

/** `document.referrer`, or null. */
export function documentReferrer(): string | null {
  return text(browser().document?.referrer);
}

/** `"<width>x<height>"` of the screen, or null. */
export function screenSize(): string | null {
  const s = browser().screen;
  if (typeof s?.width !== "number" || typeof s.height !== "number") return null;
  return `${s.width}x${s.height}`;
}

/** `navigator.language`, or null. */
export function language(): string | null {
  return text(browser().navigator?.language);
}

/** True when automation drives the browser. */
export function webdriver(): boolean {
  return browser().navigator?.webdriver === true;
}

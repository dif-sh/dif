// Automatic page views: at init and on SPA navigation.
// Page views are billed. Do not send one URL twice.

import { onNavigate, __resetHistory } from "./history.js";
import { sendPage } from "./page.js";
import { currentHref } from "./stamp.js";
import { cleanPageUrl } from "./url.js";
import type { DifInitConfig } from "./types.js";

let lastUrl: string | null = null;
let stop: (() => void) | null = null;
let scriptWarned = false;

// The tracking script sends its own page views.
function scriptOnPage(): boolean {
  if (!(globalThis as { __difSite?: unknown }).__difSite) return false;
  if (!scriptWarned && typeof console !== "undefined") {
    scriptWarned = true;
    console.warn(
      '[dif] the dif tracking script is on this page, so pageViews: "auto" stays off. ' +
        "The script sends the page views.",
    );
  }
  return true;
}

function autoPage(): void {
  if (scriptOnPage()) return;
  const href = currentHref();
  const url = href === null ? null : cleanPageUrl(href);
  if (url === null || url === lastUrl) return;
  // Only the first page view has the document's referrer.
  const sent = sendPage(lastUrl === null ? { url } : { url, referrer: lastUrl });
  if (sent) lastUrl = url;
}

/** Starts or stops automatic page views. The default is off. */
export function startPageViews(mode: DifInitConfig["pageViews"]): void {
  if (mode !== "auto") {
    stop?.();
    stop = null;
    return;
  }
  stop ??= onNavigate(autoPage);
  try {
    autoPage();
  } catch {
    // A throwing userId resolver must not break init.
  }
}

/** Test-only. */
export function __resetPageViews(): void {
  stop?.();
  stop = null;
  lastUrl = null;
  scriptWarned = false;
  __resetHistory();
}

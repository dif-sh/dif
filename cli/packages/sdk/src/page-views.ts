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
let stopWaiting: (() => void) | null = null;

interface PrerenderDocument {
  prerendering?: unknown;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

function prerenderingDocument(): PrerenderDocument | null {
  const d = (globalThis as { document?: Partial<PrerenderDocument> }).document;
  if (d?.prerendering !== true || typeof d.addEventListener !== "function") return null;
  return typeof d.removeEventListener === "function" ? (d as PrerenderDocument) : null;
}

// A prerendered page can stay unseen.
// Then it gets no page view.
function waitForActivation(doc: PrerenderDocument): void {
  if (stopWaiting) return;
  const onChange = () => {
    stopWaiting?.();
    if (stop) safeAutoPage();
  };
  doc.addEventListener("prerenderingchange", onChange);
  stopWaiting = () => {
    doc.removeEventListener("prerenderingchange", onChange);
    stopWaiting = null;
  };
}

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
  const prerendering = prerenderingDocument();
  if (prerendering) return waitForActivation(prerendering);
  const href = currentHref();
  const url = href === null ? null : cleanPageUrl(href);
  if (url === null || url === lastUrl) return;
  // Only the first page view has the document's referrer.
  const sent = sendPage(lastUrl === null ? { url } : { url, referrer: lastUrl });
  if (sent) lastUrl = url;
}

function safeAutoPage(): void {
  try {
    autoPage();
  } catch {
    // A throwing userId resolver must not break init.
  }
}

/** Starts or stops automatic page views. The default is off. */
export function startPageViews(mode: DifInitConfig["pageViews"]): void {
  if (mode !== "auto") {
    stop?.();
    stop = null;
    stopWaiting?.();
    return;
  }
  stop ??= onNavigate(autoPage);
  safeAutoPage();
}

/** Test-only. */
export function __resetPageViews(): void {
  stop?.();
  stop = null;
  stopWaiting?.();
  lastUrl = null;
  scriptWarned = false;
  __resetHistory();
}

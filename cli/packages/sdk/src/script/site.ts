// The tracking script's logic. index.ts runs it on the page.
// It keeps nothing on the device.
// So its state lasts for the page load.

import { uuidv7 } from "../event-id.js";
import { EVENTS_PER_REQUEST_PUBLISHABLE } from "../limits.js";
import { cleanPageUrl, cleanReferrer } from "../url.js";

type Element = Record<string, unknown>;

/** The `<script>` tag that loaded the script. */
export interface ScriptTag {
  getAttribute(name: string): string | null;
}

interface ClickTarget {
  getAttribute(name: string): string | null;
  attributes: Iterable<{ name: string; value: string }>;
}

interface SiteGlobals {
  __difSite?: unknown;
  dif?: unknown;
  location: { href: string; hostname: string };
  navigator: {
    language?: string;
    webdriver?: unknown;
    doNotTrack?: unknown;
    globalPrivacyControl?: unknown;
    sendBeacon(url: string, body: string): boolean;
  };
  screen: { width: number; height: number };
  history: Record<"pushState" | "replaceState", (...args: unknown[]) => void>;
  document: {
    referrer: string;
    prerendering?: unknown;
    addEventListener(type: string, fn: (e: never) => void, opts?: unknown): void;
  };
  addEventListener(type: string, fn: () => void): void;
}

/** The URL with a `#/route` moved into the path. */
export function hashRoute(href: string): string {
  const u = new URL(href);
  if (!u.hash.startsWith("#/")) return href;
  const route = new URL(u.hash.slice(1), u.origin);
  u.pathname = u.pathname.replace(/\/$/, "") + route.pathname;
  if (route.search) u.search = u.search ? `${u.search}&${route.search.slice(1)}` : route.search;
  u.hash = "";
  return u.href;
}

// The collector refuses an empty id or one with U+0000.
function validId(id: unknown): string | null {
  return typeof id === "string" && id !== "" && !id.includes("\0") ? id : null;
}

/** Reads the tag's data-* attributes and starts. */
export function start(tag: ScriptTag | null): void {
  const w = globalThis as unknown as SiteGlobals;
  const key = tag && tag.getAttribute("data-key");
  // A second copy would count each event twice.
  if (!tag || !key || w.__difSite) return;
  w.__difSite = true;
  const attr = (name: string) => tag.getAttribute(`data-${name}`);
  const nav = w.navigator;
  const doc = w.document;
  const spa = attr("spa");
  const domains = attr("domains");
  const url = `${(attr("host") || "https://ingest.difdb.com").replace(/\/+$/, "")}/v1/batch?key=${encodeURIComponent(key)}`;
  const beacon = !(typeof Request === "function" && "keepalive" in Request.prototype);

  let user = validId(attr("user-id"));
  // Undefined until the consent tool answers.
  let consent: boolean | undefined = attr("consent") === "required" ? undefined : true;
  let held: Element[] = [];
  let last: string | null = null;
  let off =
    (attr("respect-dnt") === "true" &&
      (nav.doNotTrack === "1" || nav.globalPrivacyControl === true)) ||
    (domains !== null && !domains.split(",").some((d) => d.trim() === w.location.hostname));

  // A prerendered page can stay unseen.
  // Send only when the user sees it.
  const whenShown = (fn: () => void) =>
    doc.prerendering === true
      ? doc.addEventListener("prerenderingchange", fn)
      : fn();

  const post = (body: string, retried?: boolean): void => {
    // The same body again, so dif-db stores the event once.
    const retry = () => {
      if (!retried) setTimeout(() => post(body, true), 2000);
    };
    if (beacon) {
      nav.sendBeacon(url, body);
      return;
    }
    // A text body and no headers make no CORS preflight.
    fetch(url, { method: "POST", body, keepalive: true, credentials: "omit" }).then((r) => {
      // Analytics is off for this key or origin.
      // Each later request gets the same answer.
      if (r.status === 403) off = true;
      else if (r.status >= 500) retry();
    }, retry);
  };

  const send = (list: Element[]) =>
    whenShown(() => {
      try {
        post(JSON.stringify(list, (_, v: unknown) => (v === null ? undefined : v)));
      } catch {
        // Analytics must not break the page.
      }
    });

  const emit = (e: Element) => {
    if (off || consent === false) return;
    if (consent) send([e]);
    else if (held.length < EVENTS_PER_REQUEST_PUBLISHABLE) held.push(e);
  };

  const element = (type: string, fields: Element): Element =>
    Object.assign({ type, event_id: uuidv7(), fired_at: Date.now(), user_id: user }, fields);

  const pageUrl = () => {
    const href = w.location.href;
    return cleanPageUrl(spa === "hash" ? hashRoute(href) : href);
  };

  const referrer = () => (doc.referrer ? cleanReferrer(doc.referrer) : null);
  // The collector, not the script, decides on bots.
  const wd = () => nav.webdriver === true || null;

  // Page views are billed.
  // Do not send one URL twice in a row.
  const page = (auto?: boolean) => {
    const u = pageUrl();
    if (!u || (auto && u === last)) return;
    emit(
      element("page", {
        url: u,
        referrer: last || referrer(),
        screen: `${w.screen.width}x${w.screen.height}`,
        lang: nav.language,
        wd: wd(),
      }),
    );
    last = u;
  };

  const track = (name: unknown, props?: unknown) => {
    if (typeof name !== "string" || name === "") return;
    emit(
      element("track", {
        event: name,
        url: pageUrl(),
        referrer: referrer(),
        wd: wd(),
        props,
      }),
    );
  };

  const identify = (id: unknown, traits?: unknown) => {
    if (id === null) user = null;
    if (!validId(id)) return;
    user = id as string;
    // Only traits make an element. `$identify` rows are not billed.
    if (traits && typeof traits === "object" && !Array.isArray(traits)) {
      emit(element("identify", { traits }));
    }
  };

  const setConsent = (granted: unknown) => {
    consent = granted === true;
    const list = held;
    held = [];
    if (consent && list.length > 0 && !off) send(list);
  };

  if (!w.dif) w.dif = { page: () => page(), track, identify, consent: setConsent };

  // Capture, so an app handler cannot stop it.
  doc.addEventListener(
    "click",
    (e: { target: { closest(sel: string): ClickTarget | null } }) => {
      try {
        const t = e.target.closest("[data-dif-event]");
        if (!t) return;
        const props: Record<string, string> = {};
        for (const a of t.attributes) {
          if (a.name.startsWith("data-dif-prop-")) props[a.name.slice(14)] = a.value;
        }
        track(t.getAttribute("data-dif-event"), props);
      } catch {
        // A text node or the document has no closest().
      }
    },
    true,
  );

  whenShown(() => {
    if (attr("auto") === "false") return;
    page(true);
    if (spa === "off") return;
    const navigated = () => page(true);
    // The original runs first, so location has the new URL.
    for (const m of ["pushState", "replaceState"] as const) {
      const original = w.history[m];
      w.history[m] = function (this: unknown, ...args: unknown[]) {
        original.apply(this, args);
        navigated();
      };
    }
    w.addEventListener("popstate", navigated);
    if (spa === "hash") w.addEventListener("hashchange", navigated);
  });
}

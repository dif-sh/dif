// The tracking script: data-* attributes, window.dif,
// consent, DNT, retries and SPA page views.

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { hashRoute, start } from "./script/site.js";
import { installBrowser, type FakeBrowser } from "./fake-browser.test.js";

const KEY = "dif_pk_live_aaaaaaaa_secret-secret-secret";
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Call {
  url: string;
  init: RequestInit;
  body: Array<Record<string, unknown>>;
}

type Listener = (event: unknown) => void;

interface Site {
  page(): void;
  track(name: string, props?: Record<string, unknown>): void;
  identify(id: string | null, traits?: Record<string, unknown>): void;
  consent(granted: boolean): void;
}

let calls: Call[] = [];
let answer: () => Promise<Response> = async () => new Response(null, { status: 202 });
let beacons: Array<{ url: string; body: string }> = [];
let docListeners: Map<string, Listener[]>;
let docOptions: Map<string, unknown[]>;
let winListeners: Map<string, Listener[]>;
let browser: FakeBrowser | null = null;
let originalFetch: typeof fetch;
let originalRequest: typeof Request;

const g = globalThis as unknown as Record<string, unknown>;
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};
const elements = () => calls.flatMap((c) => c.body);
const site = () => g.dif as Site;

function open(href = "https://shop.example/pricing?utm_source=news&token=t", referrer = "https://search.example/?q=x") {
  browser = installBrowser({ href, referrer });
  const loc = browser.location as { href: string; hostname?: string };
  Object.defineProperty(loc, "hostname", { get: () => new URL(loc.href).hostname });
  // The fake keeps document listeners to itself. Record them too.
  const doc = g.document as { addEventListener(t: string, fn: Listener, o?: unknown): void };
  const add = doc.addEventListener.bind(doc);
  doc.addEventListener = (type, fn, o) => {
    docListeners.set(type, [...(docListeners.get(type) ?? []), fn]);
    docOptions.set(type, [...(docOptions.get(type) ?? []), o]);
    add(type, fn, o);
  };
  const addWindow = g.addEventListener as (t: string, fn: Listener) => void;
  g.addEventListener = (type: string, fn: Listener) => {
    winListeners.set(type, [...(winListeners.get(type) ?? []), fn]);
    addWindow(type, fn);
  };
  return browser;
}

function load(attrs: Record<string, string> = {}) {
  const all: Record<string, string> = { "data-key": KEY, ...attrs };
  start({ getAttribute: (name: string) => all[name] ?? null });
}

function fire(type: string, event: unknown) {
  for (const fn of docListeners.get(type) ?? []) fn(event);
}

function fireWindow(type: string) {
  for (const fn of winListeners.get(type) ?? []) fn({ type });
}

beforeEach(() => {
  calls = [];
  beacons = [];
  docListeners = new Map();
  docOptions = new Map();
  winListeners = new Map();
  answer = async () => new Response(null, { status: 202 });
  originalFetch = globalThis.fetch;
  originalRequest = globalThis.Request;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) });
    return answer();
  }) as typeof fetch;
});

afterEach(() => {
  mock.timers.reset();
  browser?.uninstall();
  browser = null;
  delete g.dif;
  globalThis.fetch = originalFetch;
  globalThis.Request = originalRequest;
});

describe("hashRoute", () => {
  it("moves a #/ route into the path", () => {
    assert.equal(hashRoute("https://a.example/#/pricing"), "https://a.example/pricing");
    assert.equal(hashRoute("https://a.example/app/#/x/y"), "https://a.example/app/x/y");
    assert.equal(hashRoute("https://a.example/app#/x"), "https://a.example/app/x");
  });

  it("joins the route's query to the page's query", () => {
    assert.equal(
      hashRoute("https://a.example/?ref=a#/p?utm_source=b"),
      "https://a.example/p?ref=a&utm_source=b",
    );
    assert.equal(hashRoute("https://a.example/#/p?utm_source=b"), "https://a.example/p?utm_source=b");
  });

  it("keeps a URL with no #/ route", () => {
    assert.equal(hashRoute("https://a.example/a#top"), "https://a.example/a#top");
    assert.equal(hashRoute("https://a.example/a"), "https://a.example/a");
  });

  it("does not throw on a URL with no origin", () => {
    assert.equal(hashRoute("file:///app/index.html#/x"), "file:///app/index.html/x");
    assert.equal(hashRoute("about:blank#/x"), "about:blank");
  });
});

describe("the tracking script", () => {
  it("sends a page view on load, as a CORS simple request", () => {
    open();
    load();
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, `https://ingest.difdb.com/v1/batch?key=${KEY}`);
    assert.equal(call.init.method, "POST");
    assert.equal(typeof call.init.body, "string");
    assert.equal(call.init.headers, undefined);
    assert.equal(call.init.keepalive, true);
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.body.length, 1);
    const e = call.body[0]!;
    assert.equal(e.type, "page");
    assert.match(String(e.event_id), UUID_V7);
    assert.equal(typeof e.fired_at, "number");
    assert.equal(e.url, "https://shop.example/pricing?utm_source=news");
    assert.equal(e.referrer, "https://search.example/");
    assert.equal(e.screen, "1440x900");
    assert.equal(e.lang, "en-GB");
    assert.equal("user_id" in e, false);
    assert.equal("wd" in e, false);
    assert.equal("source" in e, false);
  });

  it("sends no referrer when the document has none", () => {
    open("https://shop.example/", "");
    load();
    site().track("a");
    assert.deepEqual(
      elements().map((e) => "referrer" in e),
      [false, false],
    );
  });

  it("does nothing without data-key", () => {
    open();
    start({ getAttribute: () => null });
    start(null);
    assert.equal(calls.length, 0);
    assert.equal(g.dif, undefined);
  });

  it("uses data-host, with no trailing slash", () => {
    open();
    load({ "data-host": "https://staging.example/" });
    assert.equal(calls[0]!.url, `https://staging.example/v1/batch?key=${KEY}`);
  });

  it("sends no page view with data-auto=false, but page() sends one", () => {
    open();
    load({ "data-auto": "false" });
    history.pushState({}, "", "/a");
    assert.equal(calls.length, 0);
    site().page();
    assert.equal(elements()[0]!.url, "https://shop.example/a");
  });

  it("sends a page view on SPA navigation, with the last page as referrer", () => {
    const b = open("https://shop.example/");
    load();
    history.pushState({}, "", "/a");
    history.replaceState({}, "", "/a");
    history.pushState({}, "", "/a#x");
    b.pop("https://shop.example/");
    assert.deepEqual(
      elements().map((e) => [e.url, e.referrer]),
      [
        ["https://shop.example/", "https://search.example/"],
        ["https://shop.example/a", "https://shop.example/"],
        ["https://shop.example/", "https://shop.example/a"],
      ],
    );
    assert.deepEqual(b.calls, ["pushState", "replaceState", "pushState"]);
  });

  it("sends no SPA page views with data-spa=off", () => {
    open();
    load({ "data-spa": "off" });
    history.pushState({}, "", "/a");
    assert.equal(calls.length, 1);
  });

  it("moves #/ routes into the path with data-spa=hash", () => {
    const b = open("https://shop.example/#/home");
    load({ "data-spa": "hash" });
    b.location.href = "https://shop.example/#/pricing";
    fireWindow("hashchange");
    assert.deepEqual(
      elements().map((e) => e.url),
      ["https://shop.example/home", "https://shop.example/pricing"],
    );
  });

  it("sends nothing on a host outside data-domains", () => {
    open();
    load({ "data-domains": "www.shop.example, other.example" });
    site().track("signup");
    assert.equal(calls.length, 0);
  });

  it("sends on a host in data-domains", () => {
    open();
    load({ "data-domains": "other.example,shop.example" });
    assert.equal(calls.length, 1);
  });

  it("takes an empty data-domains as no list", () => {
    open();
    load({ "data-domains": "" });
    assert.equal(calls.length, 1);
  });

  it("sends no page view on a page that is not http(s)", () => {
    open("file:///site/index.html#/home", "");
    load({ "data-spa": "hash" });
    assert.doesNotThrow(() => site().track("a"));
    assert.equal(calls.length, 1);
    assert.equal(elements()[0]!.type, "track");
    assert.equal("url" in elements()[0]!, false);
  });

  it("ignores Do Not Track unless data-respect-dnt is true", () => {
    open();
    (g.navigator as Record<string, unknown>).doNotTrack = "1";
    load();
    assert.equal(calls.length, 1);
  });

  it("sends nothing with data-respect-dnt and Do Not Track", () => {
    open();
    (g.navigator as Record<string, unknown>).doNotTrack = "1";
    load({ "data-respect-dnt": "true" });
    site().track("signup");
    assert.equal(calls.length, 0);
  });

  it("sends nothing with data-respect-dnt and Global Privacy Control", () => {
    open();
    (g.navigator as Record<string, unknown>).globalPrivacyControl = true;
    load({ "data-respect-dnt": "true" });
    assert.equal(calls.length, 0);
  });

  it("marks webdriver page views and tracks with wd", () => {
    browser = installBrowser({ href: "https://shop.example/", webdriver: true });
    Object.defineProperty(browser.location, "hostname", { value: "shop.example" });
    load();
    site().track("signup");
    assert.deepEqual(
      elements().map((e) => e.wd),
      [true, true],
    );
  });

  it("waits for prerendering to end", () => {
    browser = installBrowser({ href: "https://shop.example/", prerendering: true });
    Object.defineProperty(browser.location, "hostname", { value: "shop.example" });
    load();
    assert.equal(calls.length, 0);
    browser.activate();
    assert.equal(calls.length, 1);
    assert.equal(elements()[0]!.type, "page");
  });

  it("sends tracks with the page and the props", () => {
    open();
    load({ "data-auto": "false" });
    site().track("signup", { plan: "pro" });
    const e = elements()[0]!;
    assert.equal(e.type, "track");
    assert.equal(e.event, "signup");
    assert.match(String(e.event_id), UUID_V7);
    assert.equal(e.url, "https://shop.example/pricing?utm_source=news");
    assert.equal(e.referrer, "https://search.example/");
    assert.deepEqual(e.props, { plan: "pro" });
    assert.equal("screen" in e, false);
  });

  it("sends no track without a name", () => {
    open();
    load({ "data-auto": "false" });
    site().track("");
    (site().track as (n: unknown) => void)(undefined);
    assert.equal(calls.length, 0);
  });

  it("sends a track on a click on a data-dif-event element", () => {
    open();
    load({ "data-auto": "false" });
    const target = {
      getAttribute: (n: string) => (n === "data-dif-event" ? "signup" : null),
      attributes: [
        { name: "data-dif-event", value: "signup" },
        { name: "data-dif-prop-plan", value: "pro" },
        { name: "data-dif-prop-seats", value: "5" },
        { name: "class", value: "btn" },
      ],
    };
    const inner = { closest: (sel: string) => (sel === "[data-dif-event]" ? target : null) };
    fire("click", { target: inner });
    fire("click", { target: { closest: () => null } });
    fire("click", { target: null });
    // Capture, so an app's stopPropagation() does not hide the click.
    assert.deepEqual(docOptions.get("click"), [true]);
    assert.equal(calls.length, 1);
    const e = elements()[0]!;
    assert.equal(e.event, "signup");
    assert.deepEqual(e.props, { plan: "pro", seats: "5" });
  });

  it("puts data-user-id and identify's id on later events", () => {
    open();
    load({ "data-user-id": "u1" });
    site().identify("u2");
    site().track("a");
    site().identify(null);
    site().track("b");
    assert.deepEqual(
      elements().map((e) => e.user_id),
      ["u1", "u2", undefined],
    );
  });

  it("sends an identify element only with traits", () => {
    open();
    load({ "data-auto": "false" });
    site().identify("u1");
    assert.equal(calls.length, 0);
    site().identify("u1", { plan: "pro" });
    const e = elements()[0]!;
    assert.equal(e.type, "identify");
    assert.equal(e.user_id, "u1");
    assert.deepEqual(e.traits, { plan: "pro" });
    assert.match(String(e.event_id), UUID_V7);
    assert.equal("url" in e, false);
  });

  it("sends no identify element when traits are not an object", () => {
    open();
    load({ "data-auto": "false" });
    const identify = site().identify as (id: string, traits: unknown) => void;
    identify("u1", ["pro"]);
    identify("u1", "pro");
    assert.equal(calls.length, 0);
    site().track("a");
    assert.equal(elements()[0]!.user_id, "u1");
  });

  it("ignores an id the collector refuses", () => {
    open();
    load({ "data-auto": "false" });
    site().identify("");
    site().identify("a\u0000b", { plan: "pro" });
    site().track("a");
    assert.equal(calls.length, 1);
    assert.equal("user_id" in elements()[0]!, false);
  });

  it("holds events with data-consent=required until consent(true)", () => {
    open();
    load({ "data-consent": "required" });
    site().track("a");
    assert.equal(calls.length, 0);
    site().consent(true);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0]!.body.map((e) => e.type),
      ["page", "track"],
    );
    site().track("b");
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.body.length, 1);
  });

  it("holds at most 50 events", () => {
    open();
    load({ "data-consent": "required" });
    for (let i = 0; i < 60; i++) site().track(`t${i}`);
    site().consent(true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.body.length, 50);
    assert.equal(calls[0]!.body[0]!.type, "page");
    assert.equal(calls[0]!.body[49]!.event, "t48");
  });

  it("drops held events on consent(false), and sends no more", () => {
    open();
    load({ "data-consent": "required" });
    site().consent(false);
    site().track("a");
    site().consent(true);
    assert.equal(calls.length, 0);
    site().track("b");
    assert.equal(elements()[0]!.event, "b");
  });

  it("stops sending after consent(false) without data-consent", () => {
    open();
    load();
    site().consent(false);
    site().track("a");
    assert.equal(calls.length, 1);
  });

  it("retries a 5xx once after 2 s with the same body", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    open();
    answer = async () => new Response(null, { status: 503 });
    load();
    await settle();
    mock.timers.tick(1999);
    assert.equal(calls.length, 1);
    mock.timers.tick(1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.init.body, calls[0]!.init.body);
    await settle();
    mock.timers.tick(10_000);
    assert.equal(calls.length, 2);
  });

  it("retries a network error once", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    open();
    answer = () => Promise.reject(new TypeError("offline"));
    load();
    await settle();
    mock.timers.tick(2000);
    assert.equal(calls.length, 2);
    await settle();
    mock.timers.tick(10_000);
    assert.equal(calls.length, 2);
  });

  it("does not retry a 4xx", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    open();
    answer = async () => new Response(null, { status: 400 });
    load();
    await settle();
    mock.timers.tick(10_000);
    assert.equal(calls.length, 1);
  });

  it("sends nothing more after a 403", async () => {
    open();
    answer = async () => new Response(null, { status: 403 });
    load();
    await settle();
    site().track("a");
    assert.equal(calls.length, 1);
  });

  it("uses sendBeacon where fetch has no keepalive", () => {
    open();
    (g.navigator as Record<string, unknown>).sendBeacon = (url: string, body: string) => {
      beacons.push({ url, body });
      return true;
    };
    g.Request = function Request() {} as unknown as typeof Request;
    load();
    assert.equal(calls.length, 0);
    assert.equal(beacons.length, 1);
    assert.equal(beacons[0]!.url, `https://ingest.difdb.com/v1/batch?key=${KEY}`);
    assert.equal(JSON.parse(beacons[0]!.body)[0].type, "page");
  });

  it("sets window.__difSite and keeps an existing window.dif", () => {
    open();
    const mine = { mine: true };
    g.dif = mine;
    load();
    assert.equal(g.__difSite, true);
    assert.equal(g.dif, mine);
    assert.equal(calls.length, 1);
  });

  it("does nothing when a copy already runs on the page", () => {
    open();
    load();
    load();
    assert.equal(calls.length, 1);
  });

  it("never throws at the caller", () => {
    open();
    load({ "data-auto": "false" });
    globalThis.fetch = (() => {
      throw new Error("boom");
    }) as typeof fetch;
    assert.doesNotThrow(() => site().track("a"));
    assert.doesNotThrow(() => site().page());
  });
});

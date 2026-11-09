import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { dif, __reset } from "./index.js";
import { setElementSink, type BatchElement } from "./elements.js";
import { SOURCE } from "./version.js";
import { installBrowser, type FakeBrowser } from "./fake-browser.test.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = "dif_pk_live_aaaaaaaa_secret-secret-secret";

let sent: BatchElement[] = [];
let browser: FakeBrowser | null = null;
let originalFetch: typeof fetch;

beforeEach(() => {
  __reset();
  sent = [];
  setElementSink((e) => sent.push(e));
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 202 })) as typeof fetch;
});

afterEach(() => {
  browser?.uninstall();
  browser = null;
  globalThis.fetch = originalFetch;
  __reset();
});

function open(href: string, more: Partial<Parameters<typeof installBrowser>[0]> = {}): FakeBrowser {
  browser = installBrowser({ href, ...more });
  return browser;
}

describe("dif.page", () => {
  it("does nothing before init", () => {
    open("https://shop.example/");
    dif.page();
    assert.equal(sent.length, 0);
  });

  it("does nothing when enabled is false", () => {
    open("https://shop.example/");
    dif.init({ publishableKey: KEY, userId: () => "u-1", enabled: false });
    dif.page();
    assert.equal(sent.length, 0);
  });

  it("sends one page element with the stamped fields", () => {
    open("https://shop.example/pricing/?utm_source=News&gclid=x&token=t#plans", {
      referrer: "https://news.ycombinator.com/item?id=1",
      screen: { width: 390, height: 844 },
      language: "fr-CA",
    });
    dif.init({ publishableKey: KEY, userId: () => null });
    const before = Date.now();
    dif.page();
    assert.equal(sent.length, 1);
    const e = sent[0]!;
    assert.match(e.event_id, UUID_V7);
    assert.ok(e.fired_at >= before && e.fired_at <= Date.now());
    const { event_id: _id, fired_at: _at, ...rest } = e;
    assert.deepEqual(rest, {
      type: "page",
      source: SOURCE,
      url: "https://shop.example/pricing/?utm_source=News&gclid=",
      referrer: "https://news.ycombinator.com/item",
      screen: "390x844",
      lang: "fr-CA",
    });
  });

  it("carries the user id the resolver gives", () => {
    open("https://shop.example/");
    dif.init({ publishableKey: KEY, userId: () => "u-1" });
    dif.page();
    assert.equal(sent[0]!.user_id, "u-1");
  });

  it("has no user_id when the resolver gives none", () => {
    open("https://shop.example/");
    dif.init({ publishableKey: KEY, userId: () => "" });
    dif.page();
    assert.equal("user_id" in sent[0]!, false);
  });

  it("takes url, referrer, userId, firedAt and props from the call", () => {
    open("https://shop.example/now");
    dif.init({ publishableKey: KEY, userId: () => "u-1" });
    dif.page({
      url: "/later?ref=mail&email=a@b.c#x",
      referrer: "https://mail.example/inbox?id=9",
      userId: "u-2",
      firedAt: 1_792_000_000_000,
      props: { plan: "pro" },
    });
    const e = sent[0]!;
    assert.equal(e.type, "page");
    if (e.type !== "page") return;
    assert.equal(e.url, "https://shop.example/later?ref=mail");
    assert.equal(e.referrer, "https://mail.example/inbox");
    assert.equal(e.user_id, "u-2");
    assert.equal(e.fired_at, 1_792_000_000_000);
    assert.deepEqual(e.props, { plan: "pro" });
  });

  it("leaves out referrer when there is none", () => {
    open("https://shop.example/", { referrer: "" });
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.page();
    assert.equal("referrer" in sent[0]!, false);
  });

  it("sends wd when navigator.webdriver is true", () => {
    open("https://shop.example/", { webdriver: true });
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.page();
    assert.equal(sent[0]!.type === "page" && sent[0]!.wd, true);
  });

  it("gives each element its own event_id", () => {
    open("https://shop.example/");
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.page();
    dif.page();
    assert.notEqual(sent[0]!.event_id, sent[1]!.event_id);
  });

  it("drops a page view with no URL to send", () => {
    // No browser: a server render.
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.page();
    assert.equal(sent.length, 0);
  });

  it("drops a page view whose URL is not http(s)", () => {
    open("file:///Users/me/index.html");
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.page();
    dif.page({ url: "capacitor://localhost/home" });
    assert.equal(sent.length, 0);
  });

  it("never throws at the call site when the sink throws", () => {
    open("https://shop.example/");
    dif.init({ publishableKey: KEY, userId: () => null });
    setElementSink(() => {
      throw new Error("boom");
    });
    assert.doesNotThrow(() => dif.page());
  });
});

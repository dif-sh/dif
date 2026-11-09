import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { dif, __reset } from "./index.js";
import { setElementSink, type BatchElement, type PageElement } from "./elements.js";
import { installBrowser, type FakeBrowser } from "./fake-browser.test.js";

const KEY = "dif_pk_live_aaaaaaaa_secret-secret-secret";

let sent: BatchElement[] = [];
let warnings: unknown[][] = [];
let browser: FakeBrowser | null = null;
let originalFetch: typeof fetch;
let originalWarn: typeof console.warn;

beforeEach(() => {
  __reset();
  sent = [];
  setElementSink((e) => sent.push(e));
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 202 })) as typeof fetch;
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
});

afterEach(() => {
  __reset();
  browser?.uninstall();
  browser = null;
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

function open(href = "https://shop.example/", referrer = "https://search.example/?q=x"): FakeBrowser {
  browser = installBrowser({ href, referrer });
  return browser;
}

function pages(): PageElement[] {
  return sent.filter((e): e is PageElement => e.type === "page");
}

function auto(): void {
  dif.init({ publishableKey: KEY, userId: () => null, pageViews: "auto" });
}

describe("pageViews", () => {
  it("is off by default", () => {
    open();
    dif.init({ publishableKey: KEY, userId: () => null });
    history.pushState({}, "", "/a");
    assert.equal(sent.length, 0);
  });

  it("sends a page view at init, with the document referrer", () => {
    open("https://shop.example/home?utm_source=ad&s=1");
    auto();
    assert.equal(pages().length, 1);
    assert.equal(pages()[0]!.url, "https://shop.example/home?utm_source=ad");
    assert.equal(pages()[0]!.referrer, "https://search.example/");
  });

  it("sends a page view on pushState, with the last page as referrer", () => {
    open("https://shop.example/home?utm_source=ad");
    auto();
    history.pushState({}, "", "/pricing");
    assert.equal(pages().length, 2);
    assert.equal(pages()[1]!.url, "https://shop.example/pricing");
    assert.equal(pages()[1]!.referrer, "https://shop.example/home?utm_source=ad");
  });

  it("sends a page view on replaceState to a new path and on popstate", () => {
    const b = open();
    auto();
    history.replaceState({}, "", "/b");
    b.pop("https://shop.example/");
    assert.deepEqual(
      pages().map((p) => p.url),
      ["https://shop.example/", "https://shop.example/b", "https://shop.example/"],
    );
  });

  it("sends nothing when the cleaned URL does not change", () => {
    open("https://shop.example/a");
    auto();
    history.replaceState({ scroll: 1 }, "");
    history.replaceState({}, "", "/a");
    history.pushState({}, "", "/a");
    history.pushState({}, "", "/a#section");
    history.pushState({}, "", "/a?token=1");
    assert.equal(pages().length, 1);
  });

  it("sends a page view when a kept param changes", () => {
    open("https://shop.example/a");
    auto();
    history.pushState({}, "", "/a?utm_campaign=x");
    assert.equal(pages().length, 2);
  });

  it("sends no second init page view on a repeat init", () => {
    open();
    auto();
    auto();
    history.pushState({}, "", "/a");
    assert.equal(pages().length, 2);
  });

  it("stops when a repeat init turns it off", () => {
    open();
    auto();
    dif.init({ publishableKey: KEY, userId: () => null, pageViews: "off" });
    history.pushState({}, "", "/a");
    assert.equal(pages().length, 1);
  });

  it("carries the identified user id", () => {
    open();
    auto();
    dif.identify("u-9");
    history.pushState({}, "", "/a");
    assert.equal("user_id" in pages()[0]!, false);
    assert.equal(pages()[1]!.user_id, "u-9");
  });

  it("sends the page view once the SDK is enabled again", () => {
    open();
    dif.init({ publishableKey: KEY, userId: () => null, pageViews: "auto", enabled: false });
    assert.equal(sent.length, 0);
    auto();
    assert.equal(pages().length, 1);
  });

  it("stays off and warns once when the tracking script is on the page", () => {
    open();
    (globalThis as Record<string, unknown>).__difSite = {};
    auto();
    auto();
    history.pushState({}, "", "/a");
    assert.equal(sent.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]![0]), /tracking script/);
  });

  it("stops when the tracking script loads after init", () => {
    open();
    auto();
    (globalThis as Record<string, unknown>).__difSite = {};
    history.pushState({}, "", "/a");
    assert.equal(pages().length, 1);
    assert.equal(warnings.length, 1);
  });

  it("does nothing on a server", () => {
    assert.doesNotThrow(auto);
    assert.equal(sent.length, 0);
  });
});

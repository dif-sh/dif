import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { dif, __reset } from "./index.js";
import type { IdentifyEvent, PageEvent } from "./types.js";
import { installBrowser, type FakeBrowser } from "./fake-browser.test.js";

let browser: FakeBrowser;
let debugCalls: string[];
let originalDebug: typeof console.debug;

beforeEach(() => {
  __reset();
  browser = installBrowser({ href: "https://shop.example/pricing?utm_source=x&q=1#top" });
  debugCalls = [];
  originalDebug = console.debug;
  console.debug = (...args: unknown[]) => void debugCalls.push(String(args[0]));
});

afterEach(() => {
  console.debug = originalDebug;
  browser.uninstall();
  __reset();
});

const noop = () => {};

describe("custom mode page and identify", () => {
  it("gives a page view to the page handler", () => {
    const pages: PageEvent[] = [];
    dif.init({
      userId: () => "u-1",
      events: { mode: "custom", exposure: noop, track: noop, page: (e) => pages.push(e) },
    });
    dif.page();
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.type, "page");
    assert.equal(pages[0]!.url, "https://shop.example/pricing?utm_source=x");
    assert.equal(pages[0]!.user_id, "u-1");
  });

  it("gives identify traits to the identify handler", () => {
    const seen: IdentifyEvent[] = [];
    dif.init({
      userId: () => null,
      events: { mode: "custom", exposure: noop, track: noop, identify: (e) => seen.push(e) },
    });
    dif.identify("u-9", { plan: "pro" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.user_id, "u-9");
    assert.deepEqual(seen[0]!.traits, { plan: "pro" });
  });

  it("drops both with one debug line each when no handler is set", () => {
    dif.init({ userId: () => null, events: { mode: "custom", exposure: noop, track: noop } });
    dif.page();
    dif.page();
    dif.identify("u-9", { plan: "pro" });
    dif.identify("u-9", { plan: "pro" });
    assert.equal(debugCalls.filter((m) => m.includes("page")).length, 1);
    assert.equal(debugCalls.filter((m) => m.includes("identify")).length, 1);
  });

  it("does not throw when a handler throws", () => {
    dif.init({
      userId: () => null,
      events: {
        mode: "custom",
        exposure: noop,
        track: noop,
        page: () => {
          throw new Error("boom");
        },
      },
    });
    assert.doesNotThrow(() => dif.page());
  });
});

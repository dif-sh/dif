import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { onNavigate, __resetHistory } from "./history.js";
import { installBrowser, type FakeBrowser } from "./fake-browser.test.js";

let browser: FakeBrowser | null = null;

beforeEach(() => {
  __resetHistory();
});

afterEach(() => {
  __resetHistory();
  browser?.uninstall();
  browser = null;
});

function open(): FakeBrowser {
  browser = installBrowser({ href: "https://shop.example/" });
  return browser;
}

describe("onNavigate", () => {
  it("calls back after pushState, with the new location", () => {
    const b = open();
    const seen: string[] = [];
    onNavigate(() => seen.push(b.location.href));
    history.pushState({}, "", "/a");
    assert.deepEqual(seen, ["https://shop.example/a"]);
    assert.deepEqual(b.calls, ["pushState"]);
  });

  it("calls back after replaceState and popstate", () => {
    const b = open();
    const seen: string[] = [];
    onNavigate(() => seen.push(b.location.href));
    history.replaceState({}, "", "/b");
    b.pop("https://shop.example/c");
    assert.deepEqual(seen, ["https://shop.example/b", "https://shop.example/c"]);
  });

  it("passes the arguments and the result of the original", () => {
    const b = open();
    const got: unknown[][] = [];
    const original = b.history.pushState;
    b.history.pushState = function (this: unknown, ...args: unknown[]) {
      got.push([this, ...args]);
      original.apply(b.history, args as Parameters<typeof original>);
      return "result";
    } as typeof original;
    onNavigate(() => {});
    const result: unknown = history.pushState({ n: 1 }, "t", "/x");
    assert.deepEqual(got, [[b.history, { n: 1 }, "t", "/x"]]);
    assert.equal(result, "result");
  });

  it("wraps the history methods once", () => {
    const b = open();
    let n = 0;
    onNavigate(() => n++);
    onNavigate(() => n++);
    const wrapped = history.pushState;
    onNavigate(() => n++);
    assert.equal(history.pushState, wrapped);
    history.pushState({}, "", "/a");
    assert.equal(n, 3);
    assert.deepEqual(b.calls, ["pushState"]);
  });

  it("stops calling back after unsubscribe", () => {
    open();
    let n = 0;
    const stop = onNavigate(() => n++);
    stop();
    history.pushState({}, "", "/a");
    assert.equal(n, 0);
  });

  it("navigates even when a callback throws", () => {
    const b = open();
    let n = 0;
    onNavigate(() => {
      throw new Error("boom");
    });
    onNavigate(() => n++);
    assert.doesNotThrow(() => history.pushState({}, "", "/a"));
    assert.equal(b.location.href, "https://shop.example/a");
    assert.equal(n, 1);
  });

  it("does nothing on a server", () => {
    const stop = onNavigate(() => {});
    assert.equal(typeof stop, "function");
    assert.equal("history" in globalThis, false);
  });

  it("puts the originals back on reset", () => {
    const b = open();
    const original = b.history.pushState;
    onNavigate(() => {});
    assert.notEqual(b.history.pushState, original);
    __resetHistory();
    assert.equal(b.history.pushState, original);
  });
});

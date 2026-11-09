import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { dif, __reset, __register } from "./index.js";
import { getState } from "./config.js";
import { setElementSink, type BatchElement } from "./elements.js";
import { SOURCE } from "./version.js";
import { installBrowser, type FakeBrowser } from "./fake-browser.test.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = "dif_pk_live_aaaaaaaa_secret-secret-secret";

let sent: BatchElement[] = [];
let browser: FakeBrowser;
let originalFetch: typeof fetch;

beforeEach(() => {
  __reset();
  sent = [];
  setElementSink((e) => sent.push(e));
  browser = installBrowser({ href: "https://shop.example/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 202 })) as typeof fetch;
});

afterEach(() => {
  browser.uninstall();
  globalThis.fetch = originalFetch;
  __reset();
});

describe("dif.identify", () => {
  it("sends no element without traits", () => {
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.identify("u-9");
    assert.equal(sent.length, 0);
  });

  it("sends one identify element with traits", () => {
    dif.init({ publishableKey: KEY, userId: () => null });
    const before = Date.now();
    dif.identify("u-9", { plan: "pro", seats: 3 });
    assert.equal(sent.length, 1);
    const e = sent[0]!;
    assert.match(e.event_id, UUID_V7);
    assert.ok(e.fired_at >= before && e.fired_at <= Date.now());
    const { event_id: _id, fired_at: _at, ...rest } = e;
    assert.deepEqual(rest, {
      type: "identify",
      source: SOURCE,
      user_id: "u-9",
      traits: { plan: "pro", seats: 3 },
    });
  });

  it("sends empty traits, which are still traits", () => {
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.identify("u-9", {});
    assert.equal(sent.length, 1);
  });

  it("sends no element when traits are not an object", () => {
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.identify("u-9", ["a"] as unknown as Record<string, unknown>);
    dif.identify("u-9", null as unknown as Record<string, unknown>);
    assert.equal(sent.length, 0);
    assert.equal(getState()!.userId(), "u-9");
  });

  it("sets the id the resolver gives for later events", () => {
    dif.init({ publishableKey: KEY, userId: () => "anon-1" });
    dif.identify("u-9");
    assert.equal(getState()!.userId(), "u-9");
    dif.page();
    assert.equal(sent[0]!.user_id, "u-9");
  });

  it("keeps the id across a repeat init", () => {
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.identify("u-9");
    dif.init({ publishableKey: KEY, userId: () => null });
    assert.equal(getState()!.userId(), "u-9");
  });

  it("keeps an id set before init", () => {
    dif.identify("u-9", { plan: "pro" });
    assert.equal(sent.length, 0);
    dif.init({ publishableKey: KEY, userId: () => null });
    assert.equal(getState()!.userId(), "u-9");
  });

  it("buckets experiments on the identified id", () => {
    __register({
      id: "exp",
      surface: "home",
      variants: ["control", "b"],
      salt: "00000000000000000000000000000000",
      weights: { control: 0, b: 100 },
      exclusionGroup: null,
      created: "2026-01-01",
      audience: () => true,
    });
    dif.init({ publishableKey: KEY, userId: () => null });
    const branches = { control: () => "control", b: () => "b" };
    assert.equal(dif("exp", branches)(), "control");
    dif.identify("u-9");
    assert.equal(dif("exp", branches)(), "b");
  });

  it("ignores an empty or non-string id", () => {
    dif.init({ publishableKey: KEY, userId: () => "anon-1" });
    dif.identify("", { plan: "pro" });
    dif.identify(7 as unknown as string, { plan: "pro" });
    assert.equal(sent.length, 0);
    assert.equal(getState()!.userId(), "anon-1");
  });

  it("sends nothing when enabled is false", () => {
    dif.init({ publishableKey: KEY, userId: () => null, enabled: false });
    dif.identify("u-9", { plan: "pro" });
    assert.equal(sent.length, 0);
  });

  it("keeps no id and sends nothing on a server", () => {
    // One server process renders for many users.
    browser.uninstall();
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.identify("u-9", { plan: "pro" });
    assert.equal(getState()!.userId(), null);
    assert.equal(sent.length, 0);
  });

  it("forgets the id on reset", () => {
    dif.identify("u-9");
    __reset();
    dif.init({ publishableKey: KEY, userId: () => null });
    assert.equal(getState()!.userId(), null);
  });
});

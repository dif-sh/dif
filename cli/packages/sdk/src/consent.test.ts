import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { dif, __reset, __register } from "./index.js";
import { __tapElements, type BatchElement } from "./elements.js";
import type { ExposureEvent, MetricEvent } from "./types.js";
import { installBrowser, type FakeBrowser } from "./fake-browser.test.js";

const KEY = "dif_pk_live_aaaaaaaa_secret-secret-secret";

let sent: BatchElement[] = [];
let tracks: MetricEvent[] = [];
let exposures: ExposureEvent[] = [];
let order: string[] = [];
let browser: FakeBrowser;
let originalFetch: typeof fetch;

function customEvents() {
  return {
    mode: "custom" as const,
    exposure: (e: ExposureEvent) => {
      exposures.push(e);
      order.push("exposure");
    },
    track: (e: MetricEvent) => {
      tracks.push(e);
      order.push("track");
    },
  };
}

function registerExp(): void {
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
}

const branches = { control: () => "control", b: () => "b" };

beforeEach(() => {
  __reset();
  sent = [];
  tracks = [];
  exposures = [];
  order = [];
  __tapElements((e) => {
    sent.push(e);
    order.push(e.type);
  });
  browser = installBrowser({ href: "https://shop.example/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 202 })) as typeof fetch;
});

afterEach(() => {
  browser.uninstall();
  globalThis.fetch = originalFetch;
  __reset();
});

describe("dif.consent", () => {
  it("sends at once when consent is not required", () => {
    dif.init({ publishableKey: KEY, userId: () => "u1" });
    dif.page();
    assert.equal(sent.length, 1);
  });

  it("holds page, track and exposure until consent(true)", () => {
    registerExp();
    dif.init({
      publishableKey: KEY,
      userId: () => "u1",
      consent: "required",
      events: customEvents(),
    });
    dif.page();
    dif.track("signup_completed");
    dif("exp", branches)();
    assert.equal(sent.length + tracks.length + exposures.length, 0);
    dif.consent(true);
    assert.equal(sent.length, 1);
    assert.equal(tracks.length, 1);
    assert.equal(exposures.length, 1);
    assert.deepEqual(order, ["page", "track", "exposure"]);
  });

  it("drops held events on consent(false) and sends nothing later", () => {
    dif.init({ publishableKey: KEY, userId: () => "u1", consent: "required" });
    dif.page();
    dif.consent(false);
    dif.page();
    dif.consent(true);
    assert.equal(sent.length, 0);
  });

  it("holds at most 50 events", () => {
    dif.init({ publishableKey: KEY, userId: () => "u1", consent: "required" });
    for (let i = 0; i < 60; i++) dif.page({ url: `https://shop.example/${i}` });
    dif.consent(true);
    assert.equal(sent.length, 50);
  });

  it("sends later events after consent(true) follows consent(false)", () => {
    dif.init({ publishableKey: KEY, userId: () => "u1", consent: "required" });
    dif.page();
    dif.consent(false);
    dif.consent(true);
    assert.equal(sent.length, 0);
    dif.page();
    assert.equal(sent.length, 1);
  });

  it("keeps the gate state and held sends on a repeat init", () => {
    dif.init({ publishableKey: KEY, userId: () => "u1", consent: "required" });
    dif.page();
    dif.init({ publishableKey: KEY, userId: () => "u1", consent: "required" });
    assert.equal(sent.length, 0);
    dif.consent(true);
    assert.equal(sent.length, 1);
    dif.init({ publishableKey: KEY, userId: () => "u1", consent: "required" });
    dif.page();
    assert.equal(sent.length, 2);
  });

  it("consent() before init does not throw", () => {
    assert.doesNotThrow(() => dif.consent(true));
    assert.doesNotThrow(() => dif.consent(false));
  });

  it("consent(false) without the gate changes nothing", () => {
    dif.init({ publishableKey: KEY, userId: () => "u1" });
    dif.consent(false);
    dif.page();
    assert.equal(sent.length, 1);
  });
});

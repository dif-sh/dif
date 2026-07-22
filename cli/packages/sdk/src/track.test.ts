import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { dif, __reset } from "./index.js";
import { SOURCE } from "./version.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

let fetchCalls: FetchCall[] = [];
let originalFetch: typeof fetch;
let consoleDebugs: unknown[][] = [];
let originalDebug: typeof console.debug;

beforeEach(() => {
  __reset();
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  }) as typeof fetch;
  consoleDebugs = [];
  originalDebug = console.debug;
  console.debug = (...args: unknown[]) => {
    consoleDebugs.push(args);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.debug = originalDebug;
  __reset();
});

describe("dif.track", () => {
  it("does nothing when init has not been called", () => {
    dif.track("noop");
    assert.equal(fetchCalls.length, 0);
  });

  it("does nothing when enabled is false", () => {
    dif.init({
      project: "acme",
      publishableKey: "dif_pk_live_aaaaaaaa_secret-secret-secret",
      userId: () => "u-1",
      enabled: false,
    });
    dif.track("disabled");
    assert.equal(fetchCalls.length, 0);
  });

  it("drops when there is no userId", () => {
    dif.init({
      project: "acme",
      publishableKey: "dif_pk_live_aaaaaaaa_secret-secret-secret",
      userId: () => null,
    });
    dif.track("no-user");
    assert.equal(fetchCalls.length, 0);
  });

  it("console.debugs when publishableKey is missing", () => {
    dif.init({
      project: "acme",
      userId: () => "u-1",
    });
    dif.track("no-pk");
    assert.equal(fetchCalls.length, 0);
    assert.ok(consoleDebugs.some(([msg]) => String(msg).includes("no publishableKey")));
  });

  it("POSTs to the cloud with the expected body", async () => {
    dif.init({
      project: "acme",
      publishableKey: "dif_pk_live_aaaaaaaa_secret-secret-secret",
      apiUrl: "https://api.example.test",
      userId: () => "u-1",
    });
    dif.track("completed_checkout", { value: 49, currency: "USD" });
    await Promise.resolve();
    assert.equal(fetchCalls.length, 1);
    const call = fetchCalls[0]!;
    assert.equal(call.url, "https://api.example.test/v1/track");
    assert.equal(call.init.method, "POST");
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers.authorization, "Bearer dif_pk_live_aaaaaaaa_secret-secret-secret");
    const body = JSON.parse(call.init.body as string);
    assert.equal(body.metric, "completed_checkout");
    assert.equal(body.user_id, "u-1");
    assert.equal(body.value, 49);
    assert.equal(body.currency, "USD");
    assert.equal(body.source, SOURCE);
    assert.ok(typeof body.fired_at === "number");
  });

  it("uses the publishable key baked into events config", async () => {
    dif.init({
      userId: () => "u-1",
      events: {
        mode: "cloud",
        apiUrl: "https://api.example.test",
        publishableKey: "dif_pk_live_from_events",
      },
    });
    dif.track("completed_checkout", { value: 10 });
    await Promise.resolve();
    assert.equal(fetchCalls.length, 1);
    const call = fetchCalls[0]!;
    assert.equal(call.url, "https://api.example.test/v1/track");
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer dif_pk_live_from_events");
  });

  it("strips trailing slash from apiUrl", async () => {
    dif.init({
      project: "acme",
      publishableKey: "dif_pk_live_aaaaaaaa_secret-secret-secret",
      apiUrl: "https://api.example.test/",
      userId: () => "u-1",
    });
    dif.track("metric");
    await Promise.resolve();
    assert.equal(fetchCalls[0]!.url, "https://api.example.test/v1/track");
  });

  it("swallows fetch failures without throwing", () => {
    globalThis.fetch = (() => {
      throw new Error("boom");
    }) as typeof fetch;
    dif.init({
      project: "acme",
      publishableKey: "dif_pk_live_aaaaaaaa_secret-secret-secret",
      userId: () => "u-1",
    });
    assert.doesNotThrow(() => dif.track("metric"));
  });

  it("opts.userId overrides the configured resolver", async () => {
    dif.init({
      project: "acme",
      publishableKey: "dif_pk_live_aaaaaaaa_secret-secret-secret",
      userId: () => "configured",
    });
    dif.track("metric", { userId: "override" });
    await Promise.resolve();
    const body = JSON.parse(fetchCalls[0]!.init.body as string);
    assert.equal(body.user_id, "override");
  });

  it("custom mode calls the user's track handler instead of the cloud", () => {
    const seen: { metric: string; value?: number; user_id: string }[] = [];
    dif.init({
      userId: () => "u-1",
      events: {
        mode: "custom",
        exposure: () => {},
        track: (event) => seen.push(event),
      },
    });
    dif.track("revenue", { value: 49, currency: "USD" });
    assert.equal(fetchCalls.length, 0, "custom mode must not POST to the cloud");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.metric, "revenue");
    assert.equal(seen[0]!.value, 49);
    assert.equal(seen[0]!.user_id, "u-1");
  });

  it("custom mode needs no publishableKey", () => {
    let called = 0;
    dif.init({
      userId: () => "u-1",
      events: { mode: "custom", exposure: () => {}, track: () => { called++; } },
    });
    dif.track("metric");
    assert.equal(called, 1);
    assert.equal(consoleDebugs.length, 0, "no 'missing key' debug in custom mode");
  });
});

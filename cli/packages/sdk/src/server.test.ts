import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { DifServer } from "./server.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

let fetchCalls: FetchCall[] = [];
let originalFetch: typeof fetch;
let originalWarn: typeof console.warn;
let warnCalls: unknown[][] = [];

beforeEach(() => {
  fetchCalls = [];
  warnCalls = [];
  originalFetch = globalThis.fetch;
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

describe("DifServer.track", () => {
  it("throws if apiKey is missing", () => {
    // @ts-expect-error — testing runtime guard
    assert.throws(() => new DifServer({}));
  });

  it("posts a track event with bearer auth", async () => {
    const server = new DifServer({
      apiKey: "dif_live_aaaaaaaa_secret-secret-secret",
      apiUrl: "https://api.example.test",
    });
    await server.track({
      metric: "completed_checkout",
      userId: "u-1",
      value: 49,
      currency: "USD",
    });
    assert.equal(fetchCalls.length, 1);
    const call = fetchCalls[0]!;
    assert.equal(call.url, "https://api.example.test/v1/track");
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer dif_live_aaaaaaaa_secret-secret-secret");
    const body = JSON.parse(call.init.body as string);
    assert.equal(body.metric, "completed_checkout");
    assert.equal(body.user_id, "u-1");
    assert.equal(body.value, 49);
    assert.equal(body.currency, "USD");
    assert.equal(body.source, "@dif.sh/sdk@0.2.0");
  });

  it("warns on non-2xx without throwing", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    const server = new DifServer({ apiKey: "dif_live_aaaaaaaa_x" });
    await server.track({ metric: "m", userId: "u" });
    assert.ok(warnCalls.length >= 1, "expected at least one warn call");
  });

  it("warns on network failure without throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    const server = new DifServer({ apiKey: "dif_live_aaaaaaaa_x" });
    await server.track({ metric: "m", userId: "u" });
    assert.ok(warnCalls.length >= 1, "expected at least one warn call");
  });

  it("uses custom source when provided", async () => {
    const server = new DifServer({
      apiKey: "dif_live_aaaaaaaa_x",
      apiUrl: "https://api.example.test",
      source: "acme-shop@1.2.3",
    });
    await server.track({ metric: "m", userId: "u" });
    const body = JSON.parse(fetchCalls[0]!.init.body as string);
    assert.equal(body.source, "acme-shop@1.2.3");
  });
});

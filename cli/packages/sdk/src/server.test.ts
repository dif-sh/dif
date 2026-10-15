import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { DifServer } from "./server.js";
import { MAX_BODY_BYTES, utf8Length } from "./queue.js";
import { SOURCE } from "./version.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
    assert.equal(body.source, SOURCE);
  });

  it("puts a new UUIDv7 event_id on every track", async () => {
    const server = new DifServer({ apiKey: "dif_live_aaaaaaaa_x", apiUrl: "https://api.example.test" });
    await server.track({ metric: "m", userId: "u" });
    await server.track({ metric: "m", userId: "u", idempotencyKey: "k" });
    const [a, b] = fetchCalls.map((c) => JSON.parse(c.init.body as string));
    assert.match(a.event_id, UUID_V7);
    assert.match(b.event_id, UUID_V7);
    assert.notEqual(a.event_id, b.event_id);
    assert.equal(b.idempotency_key, "k");
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

describe("DifServer default", () => {
  it("sends one object per call, awaited, with no keepalive and no retry", async () => {
    let n = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      n++;
      return new Response("{}", { status: 503 });
    }) as typeof fetch;
    const server = new DifServer({ apiKey: "dif_live_aaaaaaaa_x", apiUrl: "https://api.example.test" });
    await server.track({ metric: "a", userId: "u" });
    await server.track({ metric: "b", userId: "u" });
    assert.equal(n, 2);
    assert.equal(fetchCalls.length, 2);
    const body = JSON.parse(fetchCalls[0]!.init.body as string);
    assert.ok(!Array.isArray(body));
    assert.equal("keepalive" in fetchCalls[0]!.init, false);
    await server.flush();
    await server.close();
    assert.equal(fetchCalls.length, 2);
  });

  it("sends an invalid event as before, and lets the cloud answer", async () => {
    const server = new DifServer({ apiKey: "dif_live_aaaaaaaa_x" });
    await server.track({ metric: "", userId: "u" });
    assert.equal(fetchCalls.length, 1);
  });
});

describe("DifServer batch", () => {
  const make = (batch: ConstructorParameters<typeof DifServer>[0]["batch"] = true) =>
    new DifServer({ apiKey: "dif_live_aaaaaaaa_x", apiUrl: "https://api.example.test", batch });
  const bodies = () => fetchCalls.map((c) => JSON.parse(c.init.body as string) as Array<Record<string, unknown>>);

  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  it("holds tracks until flush, then sends one array request", async () => {
    const server = make();
    await server.track({ metric: "a", userId: "u-1" });
    await server.track({ metric: "b", userId: "u-2", value: 2 });
    assert.equal(fetchCalls.length, 0);
    await server.flush();
    assert.equal(fetchCalls.length, 1);
    const call = fetchCalls[0]!;
    assert.equal(call.url, "https://api.example.test/v1/track");
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer dif_live_aaaaaaaa_x");
    assert.equal("keepalive" in call.init, false);
    const events = bodies()[0]!;
    assert.deepEqual(events.map((e) => e.metric), ["a", "b"]);
    assert.match(String(events[0]!.event_id), UUID_V7);
    assert.equal(events[0]!.source, SOURCE);
    assert.equal(events[1]!.value, 2);
  });

  it("sends at 20 events", async () => {
    const server = make();
    for (let i = 0; i < 20; i++) await server.track({ metric: "m", userId: "u" });
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(fetchCalls.length, 1);
    assert.equal(bodies()[0]!.length, 20);
  });

  it("takes its size and interval from the options", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const server = make({ size: 2, intervalMs: 500 });
    await server.track({ metric: "a", userId: "u" });
    mock.timers.tick(500);
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(fetchCalls.length, 1);
    await server.track({ metric: "b", userId: "u" });
    await server.track({ metric: "c", userId: "u" });
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(fetchCalls.length, 2);
  });

  it("drops one invalid event alone, with a warning", async () => {
    const server = make();
    await server.track({ metric: "a", userId: "u" });
    await server.track({ metric: "b", userId: "u", value: Number.NaN });
    await server.track({ metric: "c", userId: "u" });
    await server.flush();
    assert.deepEqual(bodies()[0]!.map((e) => e.metric), ["a", "c"]);
    assert.ok(warnCalls.some((w) => String(w[0]).includes("value must be a finite number")));
  });

  it("keeps every body at 60 KB or less", async () => {
    const server = make({ size: 500 });
    for (let i = 0; i < 30; i++) {
      await server.track({ metric: "m", userId: "u", props: { pad: "x".repeat(5000) } });
    }
    await server.flush();
    assert.ok(fetchCalls.length >= 3);
    for (const c of fetchCalls) assert.ok(utf8Length(c.init.body as string) <= MAX_BODY_BYTES);
    assert.equal(bodies().reduce((n, b) => n + b.length, 0), 30);
  });

  it("retries a 503 with the same body and the same event ids", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    mock.method(Math, "random", () => 1);
    let n = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: ++n === 1 ? 503 : 202 });
    }) as typeof fetch;
    const server = make();
    await server.track({ metric: "a", userId: "u" });
    await server.track({ metric: "b", userId: "u" });
    const done = server.flush();
    await new Promise<void>((r) => setImmediate(r));
    mock.timers.tick(1000);
    await done;
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[1]!.init.body, fetchCalls[0]!.init.body);
  });

  it("warns once when a batch is lost", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 401 })) as typeof fetch;
    const server = make();
    await server.track({ metric: "a", userId: "u" });
    await server.flush();
    assert.equal(warnCalls.length, 1);
    assert.match(String(warnCalls[0]![0]), /401/);
  });

  it("close sends what is queued, then sends each track at once", async () => {
    const server = make();
    await server.track({ metric: "a", userId: "u" });
    await server.close();
    assert.equal(fetchCalls.length, 1);
    await server.track({ metric: "b", userId: "u" });
    assert.equal(fetchCalls.length, 2);
    assert.ok(!Array.isArray(JSON.parse(fetchCalls[1]!.init.body as string)));
  });

  it("flush with nothing queued sends nothing", async () => {
    const server = make();
    await server.flush();
    assert.equal(fetchCalls.length, 0);
  });
});

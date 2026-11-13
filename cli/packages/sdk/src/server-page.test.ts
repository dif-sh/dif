import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { DifServer } from "./server.js";
import { SOURCE } from "./version.js";
import { __resetLimitWarning } from "./limit.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = "dif_live_aaaaaaaa_secret-secret-secret";

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[] = [];
let warns: unknown[][] = [];
let originalFetch: typeof fetch;
let originalWarn: typeof console.warn;

beforeEach(() => {
  __resetLimitWarning();
  calls = [];
  warns = [];
  originalFetch = globalThis.fetch;
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args);
  };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

const make = (extra: Partial<ConstructorParameters<typeof DifServer>[0]> = {}) =>
  new DifServer({ apiKey: KEY, apiUrl: "https://api.example.test", ...extra });

describe("DifServer.page", () => {
  it("posts one page object to the default ingest url with the bearer", async () => {
    await make().page({ url: "https://example.com/pricing", userId: "u1" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://ingest.difdb.com/v1/batch");
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.type, "page");
    assert.match(body.event_id, UUID_V7);
    assert.equal(typeof body.fired_at, "number");
    assert.equal(body.source, SOURCE);
    assert.equal(body.user_id, "u1");
    assert.equal(body.url, "https://example.com/pricing");
    assert.equal(body.anon, undefined);
  });

  it("uses ingestUrl, not apiUrl, and strips trailing slashes", async () => {
    await make({ ingestUrl: "https://ingest.example.test//" }).page({
      url: "https://example.com/",
      userId: "u",
    });
    assert.equal(calls[0]!.url, "https://ingest.example.test/v1/batch");
  });

  it("cleans the url and the referrer and keeps firedAt and props", async () => {
    await make().page({
      url: "https://example.com/a?utm_source=News&token=s3cret&gclid=x#frag",
      referrer: "https://news.example/item?id=1&email=a@b.c#top",
      userId: "u",
      firedAt: 1792000000000,
      props: { plan: "pro", nothing: undefined },
    });
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.url, "https://example.com/a?utm_source=News&gclid=");
    assert.equal(body.referrer, "https://news.example/item");
    assert.equal(body.fired_at, 1792000000000);
    assert.deepEqual(body.props, { plan: "pro" });
  });

  it("keeps a firedAt of 0 and uses the time now only when it is absent", async () => {
    await make().page({ url: "https://example.com/", userId: "u", firedAt: 0 });
    await make().page({ url: "https://example.com/", userId: "u" });
    assert.equal(JSON.parse(calls[0]!.init.body as string).fired_at, 0);
    assert.ok(JSON.parse(calls[1]!.init.body as string).fired_at > 0);
  });

  it("drops a url that is not http(s), with one warning, and sends nothing", async () => {
    await make().page({ url: "/pricing", userId: "u" });
    await make().page({ url: "ftp://example.com/", userId: "u" });
    assert.equal(calls.length, 0);
    assert.equal(warns.length, 2);
  });

  it("drops a page with no user id", async () => {
    await make().page({ url: "https://example.com/", userId: "" });
    assert.equal(calls.length, 0);
    assert.match(String(warns[0]![0]), /userId/);
  });

  it("warns, and does not throw, on a refusal and on a network error", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 403 })) as typeof fetch;
    await make().page({ url: "https://example.com/", userId: "u" });
    assert.match(String(warns[0]![0]), /403/);
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as typeof fetch;
    await make().page({ url: "https://example.com/", userId: "u" });
    assert.equal(warns.length, 2);
  });

  it("track still goes to apiUrl /v1/track", async () => {
    await make().track({ metric: "m", userId: "u" });
    assert.equal(calls[0]!.url, "https://api.example.test/v1/track");
  });
});

describe("DifServer.page with batch", () => {
  const make2 = (batch: ConstructorParameters<typeof DifServer>[0]["batch"] = true) =>
    make({ batch });

  it("queues page views to /v1/batch as one array on flush", async () => {
    const server = make2();
    await server.page({ url: "https://example.com/a", userId: "u" });
    await server.page({ url: "https://example.com/b", userId: "u" });
    assert.equal(calls.length, 0);
    await server.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://ingest.difdb.com/v1/batch");
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.length, 2);
    assert.equal(body[0].type, "page");
    assert.equal(
      (calls[0]!.init.headers as Record<string, string>).authorization,
      `Bearer ${KEY}`,
    );
  });

  it("keeps tracks and page views in separate queues", async () => {
    const server = make2();
    await server.track({ metric: "m", userId: "u" });
    await server.page({ url: "https://example.com/", userId: "u" });
    await server.flush();
    assert.deepEqual(calls.map((c) => c.url).sort(), [
      "https://api.example.test/v1/track",
      "https://ingest.difdb.com/v1/batch",
    ]);
  });

  it("makes no page queue when page is never called", async () => {
    const server = make2();
    await server.track({ metric: "m", userId: "u" });
    await server.flush();
    assert.equal(calls.length, 1);
  });

  it("close sends what is queued, then each page view at once as an object", async () => {
    const server = make2();
    await server.page({ url: "https://example.com/a", userId: "u" });
    await server.close();
    assert.equal(calls.length, 1);
    await server.page({ url: "https://example.com/b", userId: "u" });
    assert.equal(calls.length, 2);
    assert.ok(!Array.isArray(JSON.parse(calls[1]!.init.body as string)));
  });

  it("warns once when a page batch is lost", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 401 })) as typeof fetch;
    const server = make2();
    await server.page({ url: "https://example.com/", userId: "u" });
    await server.flush();
    assert.equal(warns.length, 1);
    assert.match(String(warns[0]![0]), /batch.*401/);
  });
});

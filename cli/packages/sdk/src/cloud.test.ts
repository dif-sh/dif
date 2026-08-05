import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { dif, __reset, __register, cloudSink, cloudTrack } from "./index.js";
import type { ExposureEvent } from "./index.js";
import { __resetCloudWarnings } from "./sinks/cloud.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

let fetchCalls: FetchCall[] = [];
let originalFetch: typeof fetch;
let expCounter = 0;
const nextExpId = () => `cloud-test-${++expCounter}`;
let warnCalls: unknown[][] = [];
let originalWarn: typeof console.warn;

const SAMPLE_EVENT: ExposureEvent = {
  event: "dif.exposure",
  experiment: "x",
  variant: "control",
  user_id: "u-1",
  surface: "home",
  bucket: 42,
  fired_at: 1700000000000,
  source: "test",
};

beforeEach(() => {
  __reset();
  __resetCloudWarnings();
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  }) as typeof fetch;
  warnCalls = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  __reset();
  __resetCloudWarnings();
});

describe("cloudSink", () => {
  it("POSTs to /v1/exposure with the publishable key as Bearer auth", async () => {
    const sink = cloudSink({
      apiUrl: "https://api.example.test",
      publishableKey: "dif_pk_test_aaaaaaaa_secret",
    });
    sink.emit(SAMPLE_EVENT);
    await Promise.resolve();
    assert.equal(fetchCalls.length, 1);
    const call = fetchCalls[0]!;
    assert.equal(call.url, "https://api.example.test/v1/exposure");
    assert.equal(call.init.method, "POST");
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers.authorization, "Bearer dif_pk_test_aaaaaaaa_secret");
    const body = JSON.parse(call.init.body as string);
    assert.deepEqual(body, SAMPLE_EVENT);
  });

  it("strips trailing slashes from apiUrl", () => {
    const sink = cloudSink({
      apiUrl: "https://api.example.test///",
      publishableKey: "k",
    });
    sink.emit(SAMPLE_EVENT);
    assert.equal(fetchCalls[0]!.url, "https://api.example.test/v1/exposure");
  });

  it("kind is 'cloud'", () => {
    const sink = cloudSink({ apiUrl: "https://x", publishableKey: "k" });
    assert.equal(sink.kind, "cloud");
  });

  it("swallows synchronous fetch failures without throwing", () => {
    globalThis.fetch = (() => {
      throw new Error("boom");
    }) as typeof fetch;
    const sink = cloudSink({ apiUrl: "https://x", publishableKey: "k" });
    assert.doesNotThrow(() => sink.emit(SAMPLE_EVENT));
  });

  it("swallows async fetch rejections without throwing", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("net down"))) as typeof fetch;
    const sink = cloudSink({ apiUrl: "https://x", publishableKey: "k" });
    assert.doesNotThrow(() => sink.emit(SAMPLE_EVENT));
    // Give the promise a tick to reject and be swallowed.
    await Promise.resolve();
    await Promise.resolve();
  });

  it("warns exactly once across two events on a non-2xx response", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    const sink = cloudSink({ apiUrl: "https://x", publishableKey: "k" });
    sink.emit(SAMPLE_EVENT);
    await Promise.resolve();
    await Promise.resolve();
    sink.emit(SAMPLE_EVENT);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(warnCalls.length, 1, "expected exactly one warning across two failed events");
    assert.ok(String(warnCalls[0]![0]).includes("HTTP 401"));
  });

  it("shares its warn-once flag with cloudTrack", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    const sink = cloudSink({ apiUrl: "https://x", publishableKey: "k" });
    const track = cloudTrack({ apiUrl: "https://x", publishableKey: "k" });
    sink.emit(SAMPLE_EVENT);
    await Promise.resolve();
    await Promise.resolve();
    track({ metric: "m", user_id: "u-1", fired_at: 1, source: "test" });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(warnCalls.length, 1, "further failures across sinks stay silent");
  });
});

describe("dif.init exposure delivery", () => {
  function registerActive(id: string): void {
    __register({
      id,
      surface: "home",
      variants: ["control", "variant_a"],
      salt: "00000000000000000000000000000000",
      weights: { control: 50, variant_a: 50 },
      exclusionGroup: null,
      created: "2026-01-01",
      audience: () => true,
    });
  }

  it("cloud mode (default) posts to /v1/exposure with the publishable key", async () => {
    const id = nextExpId();
    registerActive(id);
    dif.init({
      publishableKey: "dif_pk_live_aaaaaaaa",
      apiUrl: "https://api.example.test",
      userId: () => "u-1",
    });
    dif(id, { control: () => "c", variant_a: () => "v" })();
    await Promise.resolve();
    const posts = fetchCalls.filter((c) => c.url.endsWith("/v1/exposure"));
    assert.equal(posts.length, 1, "expected exactly one POST to /v1/exposure");
    const headers = posts[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer dif_pk_live_aaaaaaaa");
    const body = JSON.parse(posts[0]!.init.body as string);
    assert.equal(body.event, "dif.exposure");
    assert.equal(body.experiment, id);
    assert.equal(body.user_id, "u-1");
    assert.equal(body.surface, "home");
    assert.ok(typeof body.bucket === "number");
    assert.ok(typeof body.fired_at === "number");
  });

  it("cloud mode reads apiUrl from events config", async () => {
    const id = nextExpId();
    registerActive(id);
    dif.init({
      publishableKey: "dif_pk_live_aaaaaaaa",
      userId: () => "u-1",
      events: { mode: "cloud", apiUrl: "https://cloud.example.test" },
    });
    dif(id, { control: () => "c", variant_a: () => "v" })();
    await Promise.resolve();
    const posts = fetchCalls.filter((c) => c.url.endsWith("/v1/exposure"));
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.url, "https://cloud.example.test/v1/exposure");
  });

  it("custom mode routes exposures to the user's handler, not the cloud", async () => {
    const id = nextExpId();
    registerActive(id);
    const spied: ExposureEvent[] = [];
    dif.init({
      publishableKey: "dif_pk_live_aaaaaaaa",
      apiUrl: "https://api.example.test",
      userId: () => "u-1",
      events: {
        mode: "custom",
        exposure: (event) => spied.push(event),
        track: () => {},
      },
    });
    dif(id, { control: () => "c", variant_a: () => "v" })();
    await Promise.resolve();
    assert.equal(spied.length, 1, "custom exposure handler should receive the event");
    assert.equal(spied[0]!.experiment, id);
    assert.equal(
      fetchCalls.filter((c) => c.url.endsWith("/v1/exposure")).length,
      0,
      "cloud sink must not fire in custom mode",
    );
  });

  it("cloud mode without a publishable key does not post", async () => {
    const id = nextExpId();
    registerActive(id);
    dif.init({
      project: "acme",
      userId: () => "u-1",
    });
    dif(id, { control: () => "c", variant_a: () => "v" })();
    await Promise.resolve();
    assert.equal(
      fetchCalls.filter((c) => c.url.endsWith("/v1/exposure")).length,
      0,
    );
  });

  it("cloud mode reads the publishable key baked into events config", async () => {
    const id = nextExpId();
    registerActive(id);
    // No top-level publishableKey — it rides on the generated events object,
    // as produced by `dif connect` / `dif init --key`.
    dif.init({
      userId: () => "u-1",
      events: {
        mode: "cloud",
        apiUrl: "https://api.example.test",
        publishableKey: "dif_pk_live_from_events",
      },
    });
    dif(id, { control: () => "c", variant_a: () => "v" })();
    await Promise.resolve();
    const posts = fetchCalls.filter((c) => c.url.endsWith("/v1/exposure"));
    assert.equal(posts.length, 1, "expected one POST authorized by the events key");
    const headers = posts[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer dif_pk_live_from_events");
  });

  it("explicit top-level publishableKey overrides the events key", async () => {
    const id = nextExpId();
    registerActive(id);
    dif.init({
      publishableKey: "dif_pk_live_explicit",
      userId: () => "u-1",
      events: {
        mode: "cloud",
        apiUrl: "https://api.example.test",
        publishableKey: "dif_pk_live_from_events",
      },
    });
    dif(id, { control: () => "c", variant_a: () => "v" })();
    await Promise.resolve();
    const posts = fetchCalls.filter((c) => c.url.endsWith("/v1/exposure"));
    assert.equal(posts.length, 1);
    const headers = posts[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer dif_pk_live_explicit");
  });
});

describe("dif.init loud-failure warnings", () => {
  it("warns once when cloud mode has no publishableKey", () => {
    dif.init({ project: "acme", userId: () => "u-1" });
    dif.init({ project: "acme", userId: () => "u-1" });
    assert.equal(warnCalls.length, 1, "expected exactly one warning across two inits");
    assert.ok(String(warnCalls[0]![0]).includes("no publishableKey is set"));
  });

  it("warns once when init is called without a userId", () => {
    dif.init({ publishableKey: "dif_pk_live_aaaaaaaa" });
    dif.init({ publishableKey: "dif_pk_live_aaaaaaaa" });
    assert.equal(warnCalls.length, 1, "expected exactly one warning across two inits");
    assert.ok(String(warnCalls[0]![0]).includes("without a userId"));
  });

  it("custom mode never warns, even without a publishableKey or userId", () => {
    dif.init({
      events: { mode: "custom", exposure: () => {}, track: () => {} },
    });
    assert.equal(warnCalls.length, 0);
  });
});

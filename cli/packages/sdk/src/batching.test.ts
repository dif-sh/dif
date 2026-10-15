// The browser path with batching on: a window that can hear pagehide.
// An exposure's dedup entry follows the 2xx of the batch that held it.

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { __reset, __register, dif } from "./index.js";
import { __resetCloudWarnings } from "./sinks/cloud.js";
import { __resetExposures } from "./exposure.js";
import { __resetQueues, FLUSH_BYTES, MAX_BODY_BYTES, utf8Length } from "./queue.js";
import { bytesToHex, sha256 } from "./sha256.js";

const g = globalThis as Record<string, unknown>;
const hashOf = (user: string) =>
  bytesToHex(sha256(new TextEncoder().encode(user)).subarray(0, 8));
const keyFor = (user: string, exp: string) => `dif:exp:v1:${exp}:${hashOf(user)}`;

class MemoryStorage {
  readonly data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
  get length(): number {
    return this.data.size;
  }
  key(i: number): string | null {
    return [...this.data.keys()][i] ?? null;
  }
}

class FakeWindow extends EventTarget {
  localStorage = new MemoryStorage();
}

interface Call {
  url: string;
  body: string;
  events: Array<Record<string, unknown>>;
}

let win: FakeWindow;
let calls: Call[] = [];
let responder: (n: number, call: Call) => number | "throw";
let savedWindow: unknown;
let savedDocument: unknown;
let originalFetch: typeof fetch;
let savedWarn: typeof console.warn;
let warns: string[] = [];

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

function register(id: string, variants = ["control", "variant_a"]): void {
  __register({
    id,
    surface: "home",
    variants,
    salt: "00000000000000000000000000000000",
    weights: { control: 50, variant_a: 50 },
    exclusionGroup: null,
    created: "2026-01-01",
    audience: () => true,
  });
}

function initCloud(userId = "u-1", publishableKey = "dif_pk_test_aaaaaaaa_secret"): void {
  dif.init({
    project: "acme",
    publishableKey,
    apiUrl: "https://api.example.test",
    userId: () => userId,
  });
}

const expose = (id: string) => dif(id, { control: () => "c", variant_a: () => "a" })();

beforeEach(() => {
  __reset();
  __resetQueues();
  __resetCloudWarnings();
  calls = [];
  warns = [];
  responder = () => 202;
  win = new FakeWindow();
  savedWindow = g.window;
  savedDocument = g.document;
  g.window = win;
  delete g.document;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    const call: Call = { url: String(url), body, events: JSON.parse(body) };
    calls.push(call);
    const r = responder(calls.length, call);
    if (r === "throw") throw new TypeError("network down");
    return new Response("{}", { status: r });
  }) as typeof fetch;
  savedWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a.map(String).join(" "));
  };
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  __reset();
  __resetQueues();
  globalThis.fetch = originalFetch;
  console.warn = savedWarn;
  g.window = savedWindow;
  g.document = savedDocument;
  if (savedWindow === undefined) delete g.window;
  if (savedDocument === undefined) delete g.document;
});

describe("batched exposure dedup", () => {
  it("writes an entry only after the 2xx of the batch that held the exposure", async () => {
    register("e1");
    register("e2");
    initCloud();
    expose("e1");
    expose("e2");
    await settle();
    assert.equal(calls.length, 0, "queued, not sent");
    assert.equal(win.localStorage.data.size, 0, "queued is not delivered");

    await dif.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.events.length, 2);
    assert.ok(win.localStorage.getItem(keyFor("u-1", "e1")));
    assert.ok(win.localStorage.getItem(keyFor("u-1", "e2")));
  });

  it("writes nothing while the batch is on a 5xx, and writes after the retry's 2xx", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    mock.method(Math, "random", () => 1);
    responder = (n) => (n === 1 ? 503 : 202);
    register("e1");
    initCloud();
    expose("e1");
    void dif.flush();
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(win.localStorage.data.size, 0, "a 503 writes no entry");

    mock.timers.tick(1000);
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.body, calls[0]!.body, "same body");
    assert.equal(calls[1]!.events[0]!.event_id, calls[0]!.events[0]!.event_id, "same event id");
    assert.ok(win.localStorage.getItem(keyFor("u-1", "e1")));
  });

  it("writes nothing when every retry fails, so the next load fires again", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    responder = () => 500;
    register("e1");
    initCloud();
    expose("e1");
    void dif.flush();
    for (let i = 0; i < 6; i++) {
      await settle();
      mock.timers.tick(10_000);
    }
    await settle();
    assert.equal(calls.length, 4);
    assert.equal(win.localStorage.data.size, 0);

    __resetExposures();
    responder = () => 202;
    expose("e1");
    await dif.flush();
    assert.equal(calls.length, 5, "a lost exposure fires again");
  });

  it("does not write an entry for an exposure that was dropped as invalid", async () => {
    register("e1");
    register("e2");
    initCloud("u\ud800");
    expose("e1");
    expose("e2");
    await dif.flush();
    assert.equal(calls.length, 0);
    assert.equal(win.localStorage.data.size, 0);
    assert.equal(warns.length, 2);
  });

  it("drops one invalid event and still delivers and records the others", async () => {
    register("e1");
    register("e2");
    register("e3");
    let user = "u-1";
    dif.init({
      publishableKey: "dif_pk_test_aaaaaaaa_secret",
      apiUrl: "https://api.example.test",
      userId: () => user,
    });
    expose("e1");
    // A lone surrogate in the id makes this exposure invalid.
    user = "u-1\ud800";
    expose("e2");
    user = "u-1";
    expose("e3");
    await dif.flush();
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0]!.events.map((e) => e.experiment),
      ["e1", "e3"],
    );
    assert.ok(win.localStorage.getItem(keyFor("u-1", "e1")));
    assert.ok(win.localStorage.getItem(keyFor("u-1", "e3")));
    assert.equal(win.localStorage.data.size, 2);
  });

  it("flushes at 20 events and keeps every body at 60 KB or less", async () => {
    initCloud();
    for (let i = 0; i < 45; i++) dif.track(`m${i}`, { props: { pad: "x".repeat(200) } });
    await settle();
    assert.equal(calls.length, 2, "two flushes at 20 events");
    await dif.flush();
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((c) => c.events.length),
      [20, 20, 5],
    );
    for (const c of calls) assert.ok(utf8Length(c.body) <= MAX_BODY_BYTES);
  });

  it("sends large events in bodies of 16 KB or less", async () => {
    initCloud();
    for (let i = 0; i < 20; i++) dif.track(`m${i}`, { props: { pad: "x".repeat(10_000) } });
    await dif.flush();
    assert.ok(calls.length >= 4);
    for (const c of calls) assert.ok(utf8Length(c.body) <= FLUSH_BYTES);
    assert.equal(calls.reduce((n, c) => n + c.events.length, 0), 20);
  });
});

describe("batching with exposure and track", () => {
  it("keeps one queue per endpoint and sends each in its own request", async () => {
    register("e1");
    initCloud();
    expose("e1");
    dif.track("a");
    dif.track("b");
    await dif.flush();
    assert.deepEqual(
      calls.map((c) => [c.url.replace("https://api.example.test", ""), c.events.length]).sort(),
      [
        ["/v1/exposure", 1],
        ["/v1/track", 2],
      ],
    );
  });

  it("flushes both queues on pagehide", async () => {
    register("e1");
    initCloud();
    expose("e1");
    dif.track("a");
    win.dispatchEvent(new Event("pagehide"));
    await settle();
    assert.equal(calls.length, 2);
  });

  it("sends a track made while the page is closing without waiting", async () => {
    initCloud();
    dif.track("early");
    win.dispatchEvent(new Event("pagehide"));
    dif.track("late");
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.events[0]!.metric, "late");
  });

  it("keeps the queue across a repeat init with the same key", async () => {
    initCloud();
    dif.track("a");
    initCloud("u-2");
    dif.track("b");
    await dif.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.events.length, 2);
  });

  it("sends the old queue at once when the key changes", async () => {
    initCloud();
    dif.track("a");
    initCloud("u-1", "dif_pk_test_bbbbbbbb_secret");
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.events[0]!.metric, "a");
  });

  it("flush resolves with nothing queued and before init", async () => {
    await dif.flush();
    initCloud();
    await dif.flush();
    assert.equal(calls.length, 0);
  });

  it("sends nothing for a track without a key", async () => {
    dif.init({ apiUrl: "https://api.example.test", userId: () => "u-1" });
    dif.track("a");
    await dif.flush();
    assert.equal(calls.length, 0);
  });
});

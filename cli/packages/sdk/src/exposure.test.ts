// Persisted exposure dedup. The cloud sink reports a 2xx and only then does
// the SDK write `dif:exp:v1:<experiment>:<user hash>` to localStorage.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { __reset, __register, dif } from "./index.js";
import { __resetCloudWarnings } from "./sinks/cloud.js";
import { __resetExposures } from "./exposure.js";
import { bytesToHex, sha256 } from "./sha256.js";
import type { ExposureEvent } from "./index.js";

const DAY = 24 * 60 * 60 * 1000;
/** The key rule: 8 bytes of SHA-256, in hex. */
const hashOf = (user: string) =>
  bytesToHex(sha256(new TextEncoder().encode(user)).subarray(0, 8));
const keyFor = (user: string, exp = "persist-exp") => `dif:exp:v1:${exp}:${hashOf(user)}`;
const KEY = keyFor("u-1");
const g = globalThis as Record<string, unknown>;

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

let store: MemoryStorage;
let bodies: Record<string, unknown>[] = [];
let status = 202;
let originalFetch: typeof fetch;
let savedWindow: unknown;
let savedWarn: typeof console.warn;

/** Let the fetch promise chain and the sink's report settle. */
const settle = () => new Promise<void>((r) => setImmediate(r));

function register(weights: Record<string, number>): void {
  __register({
    id: "persist-exp",
    surface: "home",
    variants: ["control", "variant_a"],
    salt: "00000000000000000000000000000000",
    weights,
    exclusionGroup: null,
    created: "2026-01-01",
    audience: () => true,
  });
}

function initCloud(): void {
  dif.init({
    project: "acme",
    publishableKey: "dif_pk_test_aaaaaaaa_secret",
    apiUrl: "https://api.example.test",
    userId: () => "u-1",
  });
}

/** A new page load: the per-load set is empty, localStorage stays. */
function newPageLoad(): void {
  __resetExposures();
}

beforeEach(() => {
  __reset();
  __resetCloudWarnings();
  bodies = [];
  status = 202;
  store = new MemoryStorage();
  savedWindow = g.window;
  g.window = { localStorage: store };
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(...JSON.parse(init?.body as string));
    return new Response("{}", { status });
  }) as typeof fetch;
  savedWarn = console.warn;
  console.warn = () => {};
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = savedWarn;
  if (savedWindow === undefined) delete g.window;
  else g.window = savedWindow;
  __reset();
  __resetCloudWarnings();
});

describe("persisted exposure dedup", () => {
  it("fires on the first load and not on the next one", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    const pick = dif("persist-exp", { control: () => "c", variant_a: () => "a" });
    pick();
    await settle();
    assert.equal(bodies.length, 1);

    newPageLoad();
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    assert.equal(bodies.length, 1, "second load must not fire");
  });

  it("writes {variant, until} with a 30 day expiry after a 2xx", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    const before = Date.now();
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    const after = Date.now();
    const entry = JSON.parse(store.getItem(KEY)!);
    assert.equal(entry.variant, (bodies[0] as unknown as ExposureEvent).variant);
    assert.ok(entry.until >= before + 30 * DAY && entry.until <= after + 30 * DAY);
  });

  it("writes nothing when the cloud answers non-2xx, so the next load fires again", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    status = 500;
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    assert.equal(bodies.length, 1);
    assert.equal(store.data.size, 0);

    newPageLoad();
    status = 202;
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    assert.equal(bodies.length, 2, "a lost exposure fires again");
    assert.equal(store.data.size, 1);
  });

  it("writes nothing when the request fails on the network", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    globalThis.fetch = (() => Promise.reject(new Error("net down"))) as typeof fetch;
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    assert.equal(store.data.size, 0);
  });

  it("fires again when the stored entry has expired", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    const entry = JSON.parse(store.getItem(KEY)!);
    store.setItem(KEY, JSON.stringify({ ...entry, until: Date.now() - 1 }));

    newPageLoad();
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    assert.equal(bodies.length, 2);
    assert.ok(JSON.parse(store.getItem(KEY)!).until > Date.now());
  });

  it("fires again when the stored entry names another variant", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    const first = (bodies[0] as unknown as ExposureEvent).variant;
    const other = first === "control" ? "variant_a" : "control";
    store.setItem(KEY, JSON.stringify({ variant: other, until: Date.now() + DAY }));

    newPageLoad();
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    assert.equal(bodies.length, 2, "reassignment still fires");
    assert.equal(JSON.parse(store.getItem(KEY)!).variant, first);
  });

  it("treats a malformed entry as absent", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    store.setItem(KEY, "{not json");
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    assert.equal(bodies.length, 1);
    assert.doesNotThrow(() => JSON.parse(store.getItem(KEY)!));
  });

  it("keeps the entries of other users and experiments apart", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    store.setItem(
      keyFor("u-2"),
      JSON.stringify({ variant: "control", until: Date.now() + DAY }),
    );
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    assert.equal(bodies.length, 1);
  });

  it("falls back to the per-load set when localStorage throws", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    const boom = () => {
      throw new Error("denied");
    };
    g.window = {
      get localStorage() {
        return boom();
      },
    };
    const pick = dif("persist-exp", { control: () => "c", variant_a: () => "a" });
    assert.doesNotThrow(() => pick());
    await settle();
    pick();
    await settle();
    assert.equal(bodies.length, 1, "per-load dedup still holds");

    newPageLoad();
    pick();
    await settle();
    assert.equal(bodies.length, 2, "no persistence, so a new load fires");
  });

  it("falls back to the per-load set when setItem throws", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    store.setItem = () => {
      throw new Error("quota");
    };
    const pick = dif("persist-exp", { control: () => "c", variant_a: () => "a" });
    assert.doesNotThrow(() => pick());
    await settle();
    pick();
    await settle();
    assert.equal(bodies.length, 1);
  });

  it("falls back to the per-load set when window has no localStorage", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    g.window = {};
    const pick = dif("persist-exp", { control: () => "c", variant_a: () => "a" });
    pick();
    await settle();
    newPageLoad();
    pick();
    await settle();
    assert.equal(bodies.length, 2);
  });

  it("keeps per-load dedup only for custom sinks and writes no entry", () => {
    register({ control: 50, variant_a: 50 });
    const events: ExposureEvent[] = [];
    dif.init({
      userId: () => "u-1",
      events: {
        mode: "custom",
        exposure: (e) => {
          events.push(e);
        },
        track: () => {},
      },
    });
    const pick = dif("persist-exp", { control: () => "c", variant_a: () => "a" });
    pick();
    pick();
    assert.equal(events.length, 1);
    assert.equal(store.data.size, 0);

    newPageLoad();
    pick();
    assert.equal(events.length, 2, "a new load fires again for a custom sink");
  });

  it("puts a UUIDv7 event_id on the exposure and keeps the rest of the payload", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    const body = bodies[0]!;
    assert.match(String(body.event_id), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(Object.keys(body).sort(), [
      "bucket",
      "event",
      "event_id",
      "experiment",
      "fired_at",
      "source",
      "surface",
      "user_id",
      "variant",
    ]);
  });

  it("makes a new event_id for each exposure that fires", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    status = 500;
    const pick = dif("persist-exp", { control: () => "c", variant_a: () => "a" });
    pick();
    await settle();
    newPageLoad();
    pick();
    await settle();
    assert.equal(bodies.length, 2);
    assert.notEqual(bodies[0]!.event_id, bodies[1]!.event_id);
  });
});

describe("exposure entry key", () => {
  it("holds a short hash of the user id and never the raw id", async () => {
    register({ control: 50, variant_a: 50 });
    dif.init({
      project: "acme",
      publishableKey: "dif_pk_test_aaaaaaaa_secret",
      apiUrl: "https://api.example.test",
      userId: () => "ann@example.com",
    });
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    const keys = [...store.data.keys()];
    assert.deepEqual(keys, [keyFor("ann@example.com")]);
    assert.ok(!keys[0]!.includes("ann"));
    assert.match(keys[0]!, /^dif:exp:v1:persist-exp:[0-9a-f]{16}$/);
  });
});

describe("entry window", () => {
  it("treats an entry whose until is over 30 days ahead as expired", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    const variant = (bodies[0] as unknown as ExposureEvent).variant;
    store.setItem(KEY, JSON.stringify({ variant, until: Date.now() + 31 * DAY }));
    newPageLoad();
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    assert.equal(bodies.length, 2);
    const entry = JSON.parse(store.getItem(KEY)!);
    assert.ok(entry.until <= Date.now() + 30 * DAY);
  });

  it("keeps an entry that ends inside the 30 day window", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    const variant = (bodies[0] as unknown as ExposureEvent).variant;
    store.setItem(KEY, JSON.stringify({ variant, until: Date.now() + 29 * DAY }));
    newPageLoad();
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
    assert.equal(bodies.length, 1);
  });
});

describe("pruning stale entries", () => {
  const P = "dif:exp:v1:";
  const live = () => JSON.stringify({ variant: "control", until: Date.now() + DAY });

  function seed(): void {
    store.setItem(`${P}old:aaaaaaaaaaaaaaaa`, JSON.stringify({ variant: "control", until: Date.now() - 1 }));
    store.setItem(`${P}bad:bbbbbbbbbbbbbbbb`, "{not json");
    store.setItem(`${P}shape:cccccccccccccccc`, JSON.stringify({ variant: 3, until: "x" }));
    store.setItem(`${P}null:dddddddddddddddd`, "null");
    store.setItem(`${P}far:eeeeeeeeeeeeeeee`, JSON.stringify({ variant: "control", until: Date.now() + 60 * DAY }));
    store.setItem(`${P}live:ffffffffffffffff`, live());
    store.setItem("other:key", "{not json");
    store.setItem("dif:exp:v0:old:aaaa", "{not json");
  }

  const run = async () => {
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    await settle();
  };

  it("removes expired, malformed and too far entries and keeps the rest", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    seed();
    await run();
    const keys = [...store.data.keys()].sort();
    assert.deepEqual(keys, [
      "dif:exp:v0:old:aaaa",
      `${P}live:ffffffffffffffff`,
      KEY,
      "other:key",
    ].sort());
  });

  it("prunes once per page load", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    await run();
    seed();
    const other = dif("persist-exp", { control: () => "c", variant_a: () => "a" });
    other();
    assert.ok(store.getItem(`${P}old:aaaaaaaaaaaaaaaa`) !== null, "no second prune");

    newPageLoad();
    other();
    assert.equal(store.getItem(`${P}old:aaaaaaaaaaaaaaaa`), null, "next load prunes");
  });

  it("does not prune for custom sinks", () => {
    register({ control: 50, variant_a: 50 });
    dif.init({
      userId: () => "u-1",
      events: { mode: "custom", exposure: () => {}, track: () => {} },
    });
    seed();
    dif("persist-exp", { control: () => "c", variant_a: () => "a" })();
    assert.ok(store.getItem(`${P}old:aaaaaaaaaaaaaaaa`) !== null);
  });

  it("survives a store whose key, getItem or removeItem throws", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    seed();
    store.key = () => {
      throw new Error("denied");
    };
    await assert.doesNotReject(run());
    assert.equal(bodies.length, 1);

    newPageLoad();
    store.key = MemoryStorage.prototype.key;
    store.removeItem = () => {
      throw new Error("denied");
    };
    await assert.doesNotReject(run());
  });

  it("looks at a bounded number of keys", async () => {
    register({ control: 50, variant_a: 50 });
    initCloud();
    for (let i = 0; i < 5000; i++) store.setItem(`k${i}`, "x");
    store.setItem(`${P}old:aaaaaaaaaaaaaaaa`, "{not json");
    let calls = 0;
    const key = store.key.bind(store);
    store.key = (i: number) => {
      calls++;
      return key(i);
    };
    await run();
    assert.ok(calls <= 1000, `key() called ${calls} times`);
  });
});

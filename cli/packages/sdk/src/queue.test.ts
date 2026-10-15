import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  EventQueue,
  FLUSH_BYTES,
  MAX_BODY_BYTES,
  MAX_RETRIES,
  __resetQueues,
  parseRetryAfter,
  retryDelay,
  utf8Length,
  type QueueOptions,
} from "./queue.js";
import { validateTrack } from "./validate.js";

const g = globalThis as Record<string, unknown>;

interface Call {
  url: string;
  init: RequestInit;
  body: string;
  events: Array<Record<string, unknown>>;
}

let calls: Call[] = [];
let responder: (call: Call, n: number) => Response | Promise<Response> | "throw";
let gaveUp: Array<[number | null, number]> = [];
let warns: string[] = [];
let originalFetch: typeof fetch;
let originalWarn: typeof console.warn;
let savedWindow: unknown;
let savedDocument: unknown;

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

const ok = () => new Response('{"accepted":1}', { status: 202 });
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response("{}", { status: code, headers });

function ev(i: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
    metric: "m",
    user_id: "u-1",
    fired_at: 1700000000000 + i,
    source: "test",
    ...extra,
  };
}

function make(over: Partial<QueueOptions> = {}): EventQueue {
  return new EventQueue({
    url: "https://api.example.test/v1/track",
    headers: { "content-type": "application/json", authorization: "Bearer k" },
    label: "track",
    validate: validateTrack,
    maxEvents: 20,
    intervalMs: 2000,
    keepalive: true,
    lifecycle: false,
    onGiveUp: (s, n) => gaveUp.push([s, n]),
    ...over,
  });
}

class FakeDocument extends EventTarget {
  visibilityState = "visible";
}

beforeEach(() => {
  calls = [];
  gaveUp = [];
  warns = [];
  responder = () => ok();
  originalFetch = globalThis.fetch;
  originalWarn = console.warn;
  savedWindow = g.window;
  savedDocument = g.document;
  console.warn = (...a: unknown[]) => {
    warns.push(a.map(String).join(" "));
  };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    const call: Call = { url: String(url), init: init ?? {}, body, events: JSON.parse(body) };
    calls.push(call);
    const r = responder(call, calls.length);
    if (r === "throw") throw new TypeError("network down");
    return r;
  }) as typeof fetch;
});

afterEach(() => {
  mock.timers.reset();
  __resetQueues();
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  g.window = savedWindow;
  g.document = savedDocument;
});

describe("retryDelay", () => {
  it("doubles from the base and jitters between half and all of it", () => {
    assert.equal(retryDelay(1, 1000, undefined, () => 0), 500);
    assert.equal(retryDelay(1, 1000, undefined, () => 1), 1000);
    assert.equal(retryDelay(2, 1000, undefined, () => 1), 2000);
    assert.equal(retryDelay(3, 1000, undefined, () => 0), 2000);
  });

  it("waits at least as long as Retry-After, to a cap of 30 s", () => {
    assert.equal(retryDelay(1, 1000, 7000, () => 0), 7000);
    assert.equal(retryDelay(3, 1000, 100, () => 1), 4000);
    assert.equal(retryDelay(1, 1000, 600_000, () => 0), 30_000);
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds", () => {
    assert.equal(parseRetryAfter("2", 0), 2000);
    assert.equal(parseRetryAfter("0", 0), 0);
  });

  it("reads an HTTP date", () => {
    const now = Date.parse("2026-10-14T10:00:00Z");
    assert.equal(parseRetryAfter("Wed, 14 Oct 2026 10:00:05 GMT", now), 5000);
    assert.equal(parseRetryAfter("Wed, 14 Oct 2026 09:00:00 GMT", now), 0);
  });

  it("ignores a missing or unreadable value", () => {
    assert.equal(parseRetryAfter(null, 0), undefined);
    assert.equal(parseRetryAfter("soon", 0), undefined);
    assert.equal(parseRetryAfter("-3", 0), undefined);
  });
});

describe("utf8Length", () => {
  it("counts bytes, not code units", () => {
    assert.equal(utf8Length("abc"), 3);
    assert.equal(utf8Length("é"), 2);
    assert.equal(utf8Length("€"), 3);
    assert.equal(utf8Length("\u{1F600}"), 4);
  });
});

describe("EventQueue batching", () => {
  it("holds events until a flush, then sends one array request", async () => {
    const q = make();
    const a = q.add(ev(1));
    const b = q.add(ev(2));
    await settle();
    assert.equal(calls.length, 0);
    await q.flush();
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0]!.events.map((e) => e.event_id),
      [ev(1).event_id, ev(2).event_id],
    );
    assert.equal(await a, true);
    assert.equal(await b, true);
  });

  it("sends with the headers, the method and keepalive", async () => {
    const q = make();
    q.add(ev(1));
    await q.flush();
    const init = calls[0]!.init;
    assert.equal(init.method, "POST");
    assert.equal(init.keepalive, true);
    assert.deepEqual(init.headers, {
      "content-type": "application/json",
      authorization: "Bearer k",
    });
  });

  it("leaves keepalive off when asked", async () => {
    const q = make({ keepalive: false });
    q.add(ev(1));
    await q.flush();
    assert.equal("keepalive" in calls[0]!.init, false);
  });

  it("flushes when the queue reaches maxEvents", async () => {
    const q = make({ maxEvents: 3 });
    q.add(ev(1));
    q.add(ev(2));
    assert.equal(calls.length, 0);
    q.add(ev(3));
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.events.length, 3);
  });

  it("flushes 2 s after the first event", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const q = make();
    q.add(ev(1));
    mock.timers.tick(1999);
    await settle();
    assert.equal(calls.length, 0);
    q.add(ev(2));
    mock.timers.tick(1);
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.events.length, 2);
  });

  it("sends at once when maxEvents is 1", async () => {
    const q = make({ maxEvents: 1 });
    q.add(ev(1));
    await settle();
    assert.equal(calls.length, 1);
  });

  it("sends an event at once while the page is closing", async () => {
    const win = new EventTarget();
    g.window = win;
    g.document = new FakeDocument();
    const q = make({ lifecycle: true });
    win.dispatchEvent(new Event("pagehide"));
    q.add(ev(1));
    await settle();
    assert.equal(calls.length, 1);
    win.dispatchEvent(new Event("pageshow"));
    q.add(ev(2));
    await settle();
    assert.equal(calls.length, 1);
  });
});

describe("EventQueue validation", () => {
  it("drops one bad event and sends the rest", async () => {
    const q = make();
    const good1 = q.add(ev(1));
    const bad = q.add(ev(2, { value: "nine" }));
    const good2 = q.add(ev(3));
    await q.flush();
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0]!.events.map((e) => e.event_id),
      [ev(1).event_id, ev(3).event_id],
    );
    assert.equal(await good1, true);
    assert.equal(await bad, false);
    assert.equal(await good2, true);
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /value must be a finite number/);
  });

  it("drops an event with U+0000 alone and sends the rest", async () => {
    const q = make();
    const good1 = q.add(ev(1));
    const inValue = q.add(ev(2, { props: { k: "a\u0000b" } }));
    const inKey = q.add(ev(3, { props: { "k\u0000": 1 } }));
    const inField = q.add(ev(4, { user_id: "u\u0000" }));
    const good2 = q.add(ev(5));
    await q.flush();
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0]!.events.map((e) => e.event_id),
      [ev(1).event_id, ev(5).event_id],
    );
    assert.deepEqual(
      await Promise.all([good1, inValue, inKey, inField, good2]),
      [true, false, false, false, true],
    );
    assert.equal(warns.length, 3);
    assert.match(warns[0]!, /props must not contain U\+0000/);
    assert.match(warns[2]!, /user_id must not contain U\+0000/);
  });

  it("drops an event that cannot be turned into JSON", async () => {
    const q = make();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    assert.equal(await q.add(ev(1, { props: loop })), false);
    assert.equal(await q.add(ev(2, { props: { n: 1n } })), false);
    assert.equal(warns.length, 2);
    assert.equal(calls.length, 0);
  });

  it("drops one event over the body limit, alone", async () => {
    const q = make();
    const big = q.add(ev(1, { props: { blob: "x".repeat(MAX_BODY_BYTES) } }));
    const small = q.add(ev(2));
    await q.flush();
    assert.equal(await big, false);
    assert.equal(await small, true);
    assert.match(warns[0]!, /larger than 60 KB/);
    assert.equal(calls[0]!.events.length, 1);
  });

  it("stops warning after 20 dropped events", async () => {
    const q = make();
    for (let i = 0; i < 30; i++) q.add(ev(i, { metric: "" }));
    assert.equal(warns.length, 21);
    assert.match(warns[20]!, /further/);
  });
});

describe("EventQueue body size", () => {
  it("splits a large batch so every body is at most 60 KB", async () => {
    const q = make({ maxEvents: 500 });
    const sent: string[] = [];
    // About 5 KB each, 40 events, 200 KB in all.
    for (let i = 0; i < 40; i++) {
      sent.push(String(ev(i).event_id));
      q.add(ev(i, { props: { pad: "é".repeat(2500) } }));
    }
    await q.flush();
    assert.ok(calls.length >= 4, `expected a split, got ${calls.length} requests`);
    for (const c of calls) {
      assert.ok(utf8Length(c.body) <= MAX_BODY_BYTES, `body is ${utf8Length(c.body)} bytes`);
    }
    assert.deepEqual(
      calls.flatMap((c) => c.events.map((e) => e.event_id)),
      sent,
    );
  });

  it("allows a body of exactly 60 KB", async () => {
    const q = make();
    const base = utf8Length(JSON.stringify([ev(1, { props: { p: "" } })]));
    q.add(ev(1, { props: { p: "x".repeat(MAX_BODY_BYTES - base) } }));
    await q.flush();
    assert.equal(calls.length, 1);
    assert.equal(utf8Length(calls[0]!.body), MAX_BODY_BYTES);
  });
});

describe("EventQueue byte threshold", () => {
  const kb = (n: number) => ({ props: { pad: "x".repeat(n * 1000) } });

  it("flushes before a new event would pass the threshold", async () => {
    const q = make();
    for (let i = 1; i <= 4; i++) void q.add(ev(i, kb(5)));
    await settle();
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0]!.events.map((e) => e.event_id),
      [1, 2, 3].map((i) => ev(i).event_id),
    );
    assert.ok(utf8Length(calls[0]!.body) <= FLUSH_BYTES);
    await q.flush();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.events.length, 1);
  });

  it("sends one event at once when it alone passes the threshold", async () => {
    const q = make();
    void q.add(ev(1, kb(20)));
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.events.length, 1);
  });

  it("keeps small events waiting for the count and the timer", async () => {
    const q = make();
    for (let i = 0; i < 19; i++) void q.add(ev(i));
    await settle();
    assert.equal(calls.length, 0);
  });
});

describe("EventQueue retries", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    mock.method(Math, "random", () => 1);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it("resends the same body with the same event ids after a 503", async () => {
    responder = (_c, n) => (n === 1 ? status(503) : ok());
    const q = make();
    const p = q.add(ev(1));
    q.add(ev(2));
    const flushed = q.flush();
    await settle();
    assert.equal(calls.length, 1);
    mock.timers.tick(1000);
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.body, calls[0]!.body);
    assert.equal(calls[1]!.init.body, calls[0]!.init.body);
    assert.equal(await p, true);
    await flushed;
    assert.equal(gaveUp.length, 0);
  });

  it("retries a network error", async () => {
    responder = (_c, n) => (n === 1 ? "throw" : ok());
    const q = make();
    const p = q.add(ev(1));
    q.flush();
    await settle();
    mock.timers.tick(1000);
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.body, calls[0]!.body);
    assert.equal(await p, true);
  });

  it("retries a 429 and waits for Retry-After", async () => {
    responder = (_c, n) => (n === 1 ? status(429, { "retry-after": "7" }) : ok());
    const q = make();
    const p = q.add(ev(1));
    q.flush();
    await settle();
    mock.timers.tick(6999);
    await settle();
    assert.equal(calls.length, 1);
    mock.timers.tick(1);
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(await p, true);
  });

  it("makes at most 3 retries, then gives up", async () => {
    responder = () => status(500);
    const q = make();
    const p = q.add(ev(1));
    q.add(ev(2));
    q.flush();
    for (let i = 0; i < 6; i++) {
      await settle();
      mock.timers.tick(10_000);
    }
    await settle();
    assert.equal(calls.length, 1 + MAX_RETRIES);
    assert.equal(new Set(calls.map((c) => c.body)).size, 1);
    assert.equal(await p, false);
    assert.deepEqual(gaveUp, [[500, 2]]);
  });

  it("gives up on a network error that never clears", async () => {
    responder = () => "throw";
    const q = make();
    const p = q.add(ev(1));
    q.flush();
    for (let i = 0; i < 6; i++) {
      await settle();
      mock.timers.tick(10_000);
    }
    assert.equal(calls.length, 1 + MAX_RETRIES);
    assert.equal(await p, false);
    assert.deepEqual(gaveUp, [[null, 1]]);
  });

  it("does not retry a 401, a 403 or a 413", async () => {
    for (const code of [401, 403, 413]) {
      calls = [];
      gaveUp = [];
      responder = () => status(code);
      const q = make();
      const p = q.add(ev(1));
      q.flush();
      await settle();
      mock.timers.tick(60_000);
      await settle();
      assert.equal(calls.length, 1, `status ${code}`);
      assert.equal(await p, false);
      assert.deepEqual(gaveUp, [[code, 1]]);
    }
  });

  it("does not retry a 400 on a single event", async () => {
    responder = () => status(400);
    const q = make();
    const p = q.add(ev(1));
    q.flush();
    await settle();
    mock.timers.tick(60_000);
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(await p, false);
  });

  it("settles a flush only after the retries end", async () => {
    responder = (_c, n) => (n < 3 ? status(502) : ok());
    const q = make();
    q.add(ev(1));
    let done = false;
    void q.flush().then(() => {
      done = true;
    });
    await settle();
    assert.equal(done, false);
    mock.timers.tick(10_000);
    await settle();
    assert.equal(done, false);
    mock.timers.tick(10_000);
    await settle();
    assert.equal(done, true);
    assert.equal(calls.length, 3);
  });
});

describe("EventQueue rejected batches", () => {
  it("drops only the event the handler names and sends the rest", async () => {
    responder = (_c, n) =>
      n === 1
        ? new Response('{"error":"event[1]: value must be a finite number"}', { status: 400 })
        : ok();
    const q = make();
    const a = q.add(ev(1));
    const b = q.add(ev(2));
    const c = q.add(ev(3));
    await q.flush();
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls[1]!.events.map((e) => e.event_id),
      [ev(1).event_id, ev(3).event_id],
    );
    assert.equal(await a, true);
    assert.equal(await b, false);
    assert.equal(await c, true);
    assert.match(warns[0]!, /value must be a finite number/);
  });

  it("splits the batch in two when the 400 names no event", async () => {
    responder = (call) =>
      call.events.some((e) => e.event_id === ev(3).event_id) ? status(400) : ok();
    const q = make();
    const results = [1, 2, 3, 4].map((i) => q.add(ev(i)));
    await q.flush();
    assert.deepEqual(await Promise.all(results), [true, true, false, true]);
    assert.ok(calls.every((c) => c.events.length >= 1));
    assert.equal(calls[calls.length - 1]!.events.length, 1);
  });
});

describe("EventQueue page lifecycle", () => {
  let win: EventTarget;
  let doc: FakeDocument;

  beforeEach(() => {
    win = new EventTarget();
    doc = new FakeDocument();
    g.window = win;
    g.document = doc;
  });

  const hide = () => {
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
  };

  it("flushes the queue on pagehide", async () => {
    const q = make({ lifecycle: true });
    q.add(ev(1));
    win.dispatchEvent(new Event("pagehide"));
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.init.keepalive, true);
  });

  it("flushes the queue when the page turns hidden, not when it turns visible", async () => {
    const q = make({ lifecycle: true });
    q.add(ev(1));
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    assert.equal(calls.length, 0);
    hide();
    await settle();
    assert.equal(calls.length, 1);
  });

  it("flushes every queue on one pagehide", async () => {
    const a = make({ lifecycle: true, url: "https://api.example.test/v1/exposure" });
    const b = make({ lifecycle: true });
    a.add(ev(1));
    b.add(ev(2));
    win.dispatchEvent(new Event("pagehide"));
    await settle();
    assert.deepEqual(calls.map((c) => c.url).sort(), [
      "https://api.example.test/v1/exposure",
      "https://api.example.test/v1/track",
    ]);
  });

  it("sends a batch that waits to retry, at once, with the same body", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    responder = (_c, n) => (n === 1 ? status(503) : ok());
    const q = make({ lifecycle: true });
    const p = q.add(ev(1));
    q.flush();
    await settle();
    assert.equal(calls.length, 1);
    win.dispatchEvent(new Event("pagehide"));
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.body, calls[0]!.body);
    assert.equal(calls[1]!.init.keepalive, true);
    assert.equal(await p, true);
    mock.timers.tick(60_000);
    await settle();
    assert.equal(calls.length, 2, "the cancelled retry does not fire again");
  });

  it("does not copy a keepalive request that is in flight", async () => {
    responder = () => new Promise<Response>(() => {});
    const q = make({ lifecycle: true });
    q.add(ev(1));
    q.flush();
    await settle();
    hide();
    win.dispatchEvent(new Event("pagehide"));
    await settle();
    assert.equal(calls.length, 1);
  });

  it("copies a request that is not keepalive, with keepalive and the same body", async () => {
    const held: Array<(r: Response) => void> = [];
    responder = () => new Promise<Response>((r) => held.push(r));
    const q = make({ lifecycle: true, keepalive: false });
    const p = q.add(ev(1));
    q.flush();
    await settle();
    assert.equal(calls.length, 1);
    win.dispatchEvent(new Event("pagehide"));
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.body, calls[0]!.body);
    assert.equal(calls[1]!.init.keepalive, true);
    held[1]!(ok());
    assert.equal(await p, true);
    held[0]!(ok());
    await settle();
  });

  it("copies a request that is not keepalive once, however many times the page hides", async () => {
    responder = () => new Promise<Response>(() => {});
    const q = make({ lifecycle: true, keepalive: false });
    q.add(ev(1));
    q.flush();
    await settle();
    hide();
    win.dispatchEvent(new Event("pagehide"));
    hide();
    await settle();
    assert.equal(calls.length, 2);
  });

  // The browser shares 64 KiB of keepalive bodies in flight.
  const enforceQuota = (rejected: string[]) => {
    let inflight = 0;
    responder = (call) => {
      if (call.init.keepalive === true) {
        const bytes = utf8Length(call.body);
        if (inflight + bytes > 65_536) {
          rejected.push(call.url);
          throw new Error("quota");
        }
        inflight += bytes;
      }
      return new Promise<Response>(() => {});
    };
  };
  const exposureUrl = "https://api.example.test/v1/exposure";
  const note = "x".repeat(1500);

  it("sends the unsent batch of a second queue beside a large request in flight", async () => {
    const rejected: string[] = [];
    enforceQuota(rejected);
    const track = make({ lifecycle: true });
    const exposure = make({ lifecycle: true, url: exposureUrl });
    for (let i = 0; i < 20; i++) void track.add(ev(i, { note }));
    track.flush();
    await settle();
    for (let i = 100; i < 110; i++) void exposure.add(ev(i));
    win.dispatchEvent(new Event("pagehide"));
    await settle();
    assert.deepEqual(rejected, []);
    assert.equal(calls.filter((c) => c.url === exposureUrl).length, 1);
  });

  it("sends the unsent batches of every queue before any copy", async () => {
    const rejected: string[] = [];
    enforceQuota(rejected);
    const track = make({ lifecycle: true, keepalive: false });
    const exposure = make({ lifecycle: true, url: exposureUrl, maxEvents: 50 });
    for (let i = 0; i < 20; i++) void track.add(ev(i, { note }));
    track.flush();
    await settle();
    for (let i = 100; i < 108; i++) void exposure.add(ev(i, { note }));
    win.dispatchEvent(new Event("pagehide"));
    await settle();
    assert.equal(rejected.includes(exposureUrl), false);
    assert.equal(calls.filter((c) => c.url === exposureUrl).length, 1);
  });

  it("keeps large-props events of both queues inside the quota at pagehide", async () => {
    const sent = new Set<string>();
    const track = make({ lifecycle: true });
    const exposure = make({ lifecycle: true, url: exposureUrl });
    const pad = "x".repeat(4000);
    for (let i = 0; i < 12; i++) {
      void track.add(ev(i, { props: { pad } }));
      void exposure.add(ev(100 + i, { props: { pad } }));
      sent.add(String(ev(i).event_id));
      sent.add(String(ev(100 + i).event_id));
    }
    await settle();
    const rejected: string[] = [];
    enforceQuota(rejected);
    win.dispatchEvent(new Event("pagehide"));
    await settle();
    assert.deepEqual(rejected, []);
    // Every event went out, whether before or at the hide.
    assert.deepEqual(new Set(calls.flatMap((c) => c.events.map((e) => String(e.event_id)))), sent);
  });

  it("sends a keepalive request that fails at hide again in smaller pieces", async () => {
    // The quota left is small: a body over 8 KB cannot go.
    const delivered: string[] = [];
    responder = (call) => {
      if (utf8Length(call.body) > 8000) return "throw";
      delivered.push(...call.events.map((e) => String(e.event_id)));
      return ok();
    };
    const q = make({ lifecycle: true });
    const all: string[] = [];
    for (let i = 0; i < 10; i++) {
      all.push(String(ev(i).event_id));
      void q.add(ev(i, { props: { pad: "x".repeat(1400) } }));
    }
    win.dispatchEvent(new Event("pagehide"));
    await settle();
    assert.deepEqual([...delivered].sort(), all);
    for (const c of calls) assert.equal(c.init.keepalive, true);
  });

  it("does not split forever a single event that always fails at hide", async () => {
    responder = () => "throw";
    const q = make({ lifecycle: true });
    void q.add(ev(1));
    win.dispatchEvent(new Event("pagehide"));
    await settle();
    assert.equal(calls.length, 1);
  });

  it("does not split a batch that fails while the page is visible", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    responder = (_c, n) => (n === 1 ? "throw" : ok());
    const q = make({ lifecycle: true });
    for (let i = 0; i < 4; i++) void q.add(ev(i));
    void q.flush();
    await settle();
    mock.timers.tick(5000);
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.body, calls[0]!.body);
  });

  it("does not send a batch again that the hide itself sent", async () => {
    responder = () => new Promise<Response>(() => {});
    const q = make({ lifecycle: true });
    q.add(ev(1));
    hide();
    win.dispatchEvent(new Event("pagehide"));
    await settle();
    assert.equal(calls.length, 1);
  });

  it("keeps working after the page shows again", async () => {
    const q = make({ lifecycle: true });
    q.add(ev(1));
    hide();
    await settle();
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    const p = q.add(ev(2));
    await settle();
    assert.equal(calls.length, 1);
    await q.flush();
    assert.equal(calls.length, 2);
    assert.equal(await p, true);
  });

  it("stops listening once every queue is closed", async () => {
    const removed: string[] = [];
    const wrap = (target: EventTarget) => {
      const original = target.removeEventListener.bind(target);
      target.removeEventListener = ((type: string, ...rest: unknown[]) => {
        removed.push(type);
        return (original as (...a: unknown[]) => void)(type, ...rest);
      }) as typeof target.removeEventListener;
    };
    wrap(win);
    wrap(doc);
    const a = make({ lifecycle: true });
    const b = make({ lifecycle: true });
    await a.close();
    assert.deepEqual(removed, []);
    await b.close();
    assert.deepEqual(removed.sort(), ["pagehide", "pageshow", "visibilitychange"]);
  });
});

describe("EventQueue close", () => {
  it("flushes what is queued and then sends at once", async () => {
    const q = make();
    q.add(ev(1));
    await q.close();
    assert.equal(calls.length, 1);
    const p = q.add(ev(2));
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(await p, true);
  });
});

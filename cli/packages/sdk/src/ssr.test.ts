// SSR-safety regression tests: server-side `assign()` must compute variants
// without firing exposures, touching the per-session dedupe set, or reading the
// DOM — the three properties that make it safe to call on a long-lived,
// request-shared Node server.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { __reset, __register, assign, registered, dif } from "./index.js";

let fetchCalls = 0;
let originalFetch: typeof fetch;

beforeEach(() => {
  __reset();
  fetchCalls = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response("{}", { status: 202 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __reset();
});

function register(id: string): void {
  __register({
    id,
    surface: "home",
    variants: ["control", "variant_a"],
    salt: "00000000000000000000000000000000",
    weights: { control: 50, variant_a: 50 },
    exclusionGroup: null,
    audience: () => true,
  });
}

describe("SSR safety", () => {
  it("assign() across many requests fires zero exposures and never pollutes the dedupe set", async () => {
    register("a");
    register("b");

    // Simulate 1000 distinct-user requests assigning every experiment.
    for (let i = 0; i < 1000; i++) {
      for (const spec of registered()) {
        const r = assign(spec.id, { userId: `u-${i}`, attributes: {} });
        assert.ok(r);
      }
    }
    await Promise.resolve();
    assert.equal(fetchCalls, 0, "server assignment must not fire exposures");

    // The module-global `fired` set was never touched by assign() — so a real
    // client exposure for a user we already "assigned" still fires exactly once.
    let clientCount = 0;
    dif.init({
      userId: () => "u-0",
      events: { mode: "custom", exposure: () => { clientCount++; }, track: () => {} },
    });
    dif("a", { control: () => "c", variant_a: () => "v" })();
    await Promise.resolve();
    assert.equal(clientCount, 1, "server path must leave the client dedupe set clean");
  });

  it("assign() works with window and document undefined", () => {
    register("a");
    const g = globalThis as Record<string, unknown>;
    const savedWindow = g.window;
    const savedDoc = g.document;
    try {
      delete g.window;
      delete g.document;
      const r = assign("a", { userId: "u1", attributes: {} });
      assert.ok(r);
      assert.equal(r.exposed, true);
    } finally {
      if (savedWindow !== undefined) g.window = savedWindow;
      if (savedDoc !== undefined) g.document = savedDoc;
    }
  });
});

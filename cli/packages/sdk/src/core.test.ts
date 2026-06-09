import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { dif, __reset, __register, assign, registered, getSpec } from "./index.js";
import type { Sink, ExposureEvent, AudienceFn } from "./index.js";

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

function register(id: string, audience: AudienceFn = () => true): void {
  __register({
    id,
    surface: "home",
    variants: ["control", "variant_a"],
    salt: "00000000000000000000000000000000",
    weights: { control: 50, variant_a: 50 },
    exclusionGroup: null,
    audience,
  });
}

describe("assign (pure)", () => {
  it("returns null for an unregistered id", () => {
    assert.equal(assign("nope", { userId: "u1", attributes: {} }), null);
  });

  it("returns control/exposed:false and fires nothing when userId is null", () => {
    register("a");
    const r = assign("a", { userId: null, attributes: {} });
    assert.deepEqual(r, { variant: "control", bucket: null, exposed: false });
    assert.equal(fetchCalls, 0);
  });

  it("returns control/exposed:false on an audience miss", () => {
    register("a", (attr) => attr.locale === "en-US");
    const r = assign("a", { userId: "u1", attributes: { locale: "fr-FR" } });
    assert.deepEqual(r, { variant: "control", bucket: null, exposed: false });
    assert.equal(fetchCalls, 0);
  });

  it("buckets into a real variant with exposed:true on a hit, without firing", () => {
    register("a");
    const r = assign("a", { userId: "u1", attributes: {} });
    assert.ok(r);
    assert.equal(r.exposed, true);
    assert.ok(r.bucket !== null && r.bucket >= 0 && r.bucket < 10000);
    assert.ok(["control", "variant_a"].includes(r.variant));
    assert.equal(fetchCalls, 0, "assign must never fire an exposure");
  });

  it("is deterministic for the same (id, ctx)", () => {
    register("a");
    const r1 = assign("a", { userId: "stable-user", attributes: {} });
    const r2 = assign("a", { userId: "stable-user", attributes: {} });
    assert.deepEqual(r1, r2);
  });
});

describe("registered / getSpec", () => {
  it("registered() returns specs in registration order", () => {
    register("first");
    register("second");
    assert.deepEqual(
      registered().map((s) => s.id),
      ["first", "second"],
    );
  });

  it("getSpec returns a spec or undefined", () => {
    register("a");
    assert.equal(getSpec("a")?.id, "a");
    assert.equal(getSpec("missing"), undefined);
  });
});

describe("resolve refactor — backward compatible dif()", () => {
  it("fires exactly one exposure whose payload matches the returned branch", async () => {
    register("exp");
    const seen: ExposureEvent[] = [];
    const sink: Sink = { kind: "spy", emit: (e) => seen.push(e) };
    dif.init({ userId: () => "u-1", sink });

    const value = dif("exp", { control: () => "c", variant_a: () => "v" })();
    await Promise.resolve();

    assert.ok(value === "c" || value === "v");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.experiment, "exp");
    assert.equal(seen[0]!.user_id, "u-1");
    assert.equal(seen[0]!.surface, "home");
    assert.equal(typeof seen[0]!.bucket, "number");
    assert.equal(seen[0]!.variant === "control" ? "c" : "v", value);
  });

  it("dedupes — same (id,user) fires only once across calls", async () => {
    register("exp");
    let count = 0;
    const sink: Sink = { kind: "spy", emit: () => { count++; } };
    dif.init({ userId: () => "u-1", sink });
    dif("exp", { control: () => "c", variant_a: () => "v" })();
    dif("exp", { control: () => "c", variant_a: () => "v" })();
    await Promise.resolve();
    assert.equal(count, 1);
  });

  it("returns control and fires nothing when userId is null", async () => {
    register("exp");
    let count = 0;
    const sink: Sink = { kind: "spy", emit: () => { count++; } };
    dif.init({ userId: () => null, sink });
    const value = dif("exp", { control: () => "c", variant_a: () => "v" })();
    await Promise.resolve();
    assert.equal(value, "c", "control is the first declared branch");
    assert.equal(count, 0);
  });

  it("falls back to the first branch for an unknown id", () => {
    dif.init({ userId: () => "u-1", sink: [] });
    const value = dif("never-registered", { control: () => "c", variant_a: () => "v" })();
    assert.equal(value, "c");
  });
});

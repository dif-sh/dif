import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { dif, __reset, __register, assign, registered, getSpec } from "./index.js";
import type { ExposureEvent, AudienceFn } from "./index.js";

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
    created: "2026-01-01",
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
    dif.init({
      userId: () => "u-1",
      events: { mode: "custom", exposure: (e) => seen.push(e), track: () => {} },
    });

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
    dif.init({
      userId: () => "u-1",
      events: { mode: "custom", exposure: () => { count++; }, track: () => {} },
    });
    dif("exp", { control: () => "c", variant_a: () => "v" })();
    dif("exp", { control: () => "c", variant_a: () => "v" })();
    await Promise.resolve();
    assert.equal(count, 1);
  });

  it("returns control and fires nothing when userId is null", async () => {
    register("exp");
    let count = 0;
    dif.init({
      userId: () => null,
      events: { mode: "custom", exposure: () => { count++; }, track: () => {} },
    });
    const value = dif("exp", { control: () => "c", variant_a: () => "v" })();
    await Promise.resolve();
    assert.equal(value, "c", "control is the first declared branch");
    assert.equal(count, 0);
  });

  it("falls back to the first branch for an unknown id", () => {
    dif.init({ userId: () => "u-1" });
    const value = dif("never-registered", { control: () => "c", variant_a: () => "v" })();
    assert.equal(value, "c");
  });
});

describe("overrides / forced assignment", () => {
  it("assign() forces a valid variant with exposed:false/forced:true and no fetch", () => {
    register("a");
    const r = assign("a", { userId: "u1", attributes: {}, overrides: { a: "variant_a" } });
    assert.deepEqual(r, { variant: "variant_a", bucket: null, exposed: false, forced: true });
    assert.equal(fetchCalls, 0);
  });

  it("a force outranks an audience miss", () => {
    register("a", (attr) => attr.locale === "en-US");
    const r = assign("a", {
      userId: "u1",
      attributes: { locale: "fr-FR" },
      overrides: { a: "variant_a" },
    });
    assert.equal(r!.variant, "variant_a");
    assert.equal(r!.forced, true);
  });

  it("ignores a force for a variant that isn't declared", () => {
    register("a");
    const r = assign("a", { userId: "u1", attributes: {}, overrides: { a: "ghost" } });
    assert.ok(r);
    assert.notEqual(r.forced, true);
    assert.equal(r.exposed, true); // fell through to normal bucketing
  });

  it("dif() honors state overrides, fires NO exposure, and leaves dedupe clean", async () => {
    register("a");
    register("b");
    let count = 0;
    dif.init({
      userId: () => "u-1",
      overrides: { a: "variant_a" },
      events: { mode: "custom", exposure: () => { count++; }, track: () => {} },
    });

    // Forced experiment → forced value, no exposure.
    const forced = dif("a", { control: () => "c", variant_a: () => "v" })();
    await Promise.resolve();
    assert.equal(forced, "v");
    assert.equal(count, 0, "forced assignment must not fire an exposure");

    // A non-forced experiment still buckets + fires normally (dedupe untouched).
    dif("b", { control: () => "c", variant_a: () => "v" })();
    await Promise.resolve();
    assert.equal(count, 1, "non-forced experiment still fires");
  });

  it("dif.setOverrides / getOverrides update state at runtime", () => {
    register("a");
    dif.init({ userId: () => "u-1" });
    assert.deepEqual(dif.getOverrides(), {});
    dif.setOverrides({ a: "variant_a" });
    assert.deepEqual(dif.getOverrides(), { a: "variant_a" });
    const v = dif("a", { control: () => "c", variant_a: () => "v" })();
    assert.equal(v, "v");
    dif.setOverrides({});
    assert.deepEqual(dif.getOverrides(), {});
  });

  it("a force wins over enabled:false and fires no exposure", async () => {
    register("a");
    let count = 0;
    dif.init({
      userId: () => "u-1",
      events: { mode: "custom", exposure: () => { count++; }, track: () => {} },
      enabled: false,
      overrides: { a: "variant_a" },
    });

    const forced = dif("a", { control: () => "c", variant_a: () => "v" })();
    await Promise.resolve();
    assert.equal(forced, "v", "docs: a valid QA force wins, including over the kill switch");
    assert.equal(count, 0);

    // Without a force the kill switch still returns control.
    register("b");
    const off = dif("b", { control: () => "c", variant_a: () => "v" })();
    assert.equal(off, "c");
    assert.equal(count, 0);
  });
});

function registerGrouped(
  id: string,
  opts: {
    group: string;
    created: string;
    audience?: AudienceFn;
  },
): void {
  __register({
    id,
    surface: "home",
    variants: ["control", "variant_a"],
    salt: "00000000000000000000000000000000",
    weights: { control: 50, variant_a: 50 },
    exclusionGroup: opts.group,
    created: opts.created,
    audience: opts.audience ?? (() => true),
  });
}

describe("exclusion groups (runtime arbitration)", () => {
  it("the earliest-created eligible member wins; the loser gets control, no exposure", () => {
    registerGrouped("younger", { group: "g", created: "2026-02-01" });
    registerGrouped("older", { group: "g", created: "2026-01-01" });

    const winner = assign("older", { userId: "u1", attributes: {} });
    assert.equal(winner!.exposed, true, "group winner buckets normally");

    const loser = assign("younger", { userId: "u1", attributes: {} });
    assert.deepEqual(loser, { variant: "control", bucket: null, exposed: false });
  });

  it("ties on created break by experiment id", () => {
    registerGrouped("bbb", { group: "g", created: "2026-01-01" });
    registerGrouped("aaa", { group: "g", created: "2026-01-01" });

    assert.equal(assign("aaa", { userId: "u1", attributes: {} })!.exposed, true);
    assert.equal(assign("bbb", { userId: "u1", attributes: {} })!.exposed, false);
  });

  it("an audience-missing member cedes the group to the next eligible member", () => {
    registerGrouped("older", {
      group: "g",
      created: "2026-01-01",
      audience: (a) => a.locale === "en-US",
    });
    registerGrouped("younger", { group: "g", created: "2026-02-01" });

    const ctx = { userId: "u1", attributes: { locale: "fr-FR" } };
    assert.equal(assign("older", ctx)!.exposed, false, "audience miss");
    assert.equal(assign("younger", ctx)!.exposed, true, "next member wins the group");
  });

  it("a forced member beats an earlier audience-matching member", () => {
    registerGrouped("older", { group: "g", created: "2026-01-01" });
    registerGrouped("younger", { group: "g", created: "2026-02-01" });

    const ctx = { userId: "u1", attributes: {}, overrides: { younger: "variant_a" } };
    const forced = assign("younger", ctx);
    assert.deepEqual(forced, { variant: "variant_a", bucket: null, exposed: false, forced: true });

    const loser = assign("older", ctx);
    assert.deepEqual(loser, { variant: "control", bucket: null, exposed: false });
  });

  it("with two forced members, the earlier one wins and the later force is ignored", () => {
    registerGrouped("older", { group: "g", created: "2026-01-01" });
    registerGrouped("younger", { group: "g", created: "2026-02-01" });

    const ctx = {
      userId: "u1",
      attributes: {},
      overrides: { older: "variant_a", younger: "variant_a" },
    };
    assert.equal(assign("older", ctx)!.forced, true);
    const loser = assign("younger", ctx);
    assert.deepEqual(loser, { variant: "control", bucket: null, exposed: false });
  });

  it("different groups and ungrouped experiments don't interact", () => {
    registerGrouped("g1-member", { group: "g1", created: "2026-01-01" });
    registerGrouped("g2-member", { group: "g2", created: "2026-02-01" });
    register("solo");

    const ctx = { userId: "u1", attributes: {} };
    assert.equal(assign("g1-member", ctx)!.exposed, true);
    assert.equal(assign("g2-member", ctx)!.exposed, true);
    assert.equal(assign("solo", ctx)!.exposed, true);
  });

  it("dif() agrees with assign(): later forced member of a group loses", async () => {
    registerGrouped("older", { group: "g", created: "2026-01-01" });
    registerGrouped("younger", { group: "g", created: "2026-02-01" });
    dif.init({
      userId: () => "u-1",
      overrides: { older: "variant_a", younger: "variant_a" },
    });

    const winner = dif("older", { control: () => "c", variant_a: () => "v" })();
    const loser = dif("younger", { control: () => "c", variant_a: () => "v" })();
    assert.equal(winner, "v", "earliest forced member wins its force");
    assert.equal(loser, "c", "later forced member loses the group");
  });

  it("dif() renders control for the losing member of a group", async () => {
    registerGrouped("older", { group: "g", created: "2026-01-01" });
    registerGrouped("younger", { group: "g", created: "2026-02-01" });
    let count = 0;
    dif.init({
      userId: () => "u-1",
      events: { mode: "custom", exposure: () => { count++; }, track: () => {} },
    });

    dif("older", { control: () => "c", variant_a: () => "v" })();
    const loser = dif("younger", { control: () => "c", variant_a: () => "v" })();
    await Promise.resolve();

    assert.equal(loser, "c");
    assert.equal(count, 1, "only the group winner fires an exposure");
  });
});

describe("branch drift (spec variants ≠ branch keys)", () => {
  function registerAllVariantA(id: string): void {
    __register({
      id,
      surface: "home",
      variants: ["control", "variant_a"],
      salt: "00000000000000000000000000000000",
      weights: { control: 0, variant_a: 100 }, // deterministic: always variant_a
      exclusionGroup: null,
      created: "2026-01-01",
      audience: () => true,
    });
  }

  it("falls back to the first branch and fires no exposure when the assigned variant has no branch", async () => {
    registerAllVariantA("drifted");
    let count = 0;
    dif.init({
      userId: () => "u-1",
      events: { mode: "custom", exposure: () => { count++; }, track: () => {} },
    });

    // The call site only knows `control` — e.g. the .md renamed a variant.
    const value = dif("drifted", { control: () => "c" })();
    await Promise.resolve();

    assert.equal(value, "c", "must render the fallback branch, not crash");
    assert.equal(count, 0, "an unrendered variant must not fire an exposure");
  });

  it("a forced variant without a matching branch renders the fallback, no exposure", async () => {
    register("a");
    let count = 0;
    dif.init({
      userId: () => "u-1",
      events: { mode: "custom", exposure: () => { count++; }, track: () => {} },
      overrides: { a: "variant_a" },
    });

    const value = dif("a", { control: () => "c" })();
    await Promise.resolve();
    assert.equal(value, "c");
    assert.equal(count, 0);
  });

  it("uninitialized SDK with drifted branches still renders the first branch", () => {
    registerAllVariantA("drifted");
    // No dif.init at all.
    const value = dif("drifted", { something_else: () => "x" })();
    assert.equal(value, "x");
  });
});

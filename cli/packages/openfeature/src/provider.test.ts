import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  OpenFeature,
  ErrorCode,
  StandardResolutionReasons,
  type Logger,
} from "@openfeature/server-sdk";
import { __register, __reset, assign } from "@dif.sh/sdk";
import type { AudienceFn } from "@dif.sh/sdk";
import { DifOpenFeatureProvider } from "./index.js";
import type { DifExposure, DifOpenFeatureProviderOptions } from "./index.js";

// The OpenFeature client logs every errorCode result; keep test output clean.
const silent: Logger = { error() {}, warn() {}, info() {}, debug() {} };

function register(
  id: string,
  variants: readonly string[],
  audience: AudienceFn = () => true,
  weights?: Record<string, number>,
): void {
  const even = Math.floor(100 / variants.length);
  __register({
    id,
    surface: "checkout",
    variants,
    salt: "00000000000000000000000000000000",
    weights:
      weights ??
      Object.fromEntries(
        variants.map((v, i) => [v, i === 0 ? 100 - even * (variants.length - 1) : even]),
      ),
    exclusionGroup: null,
    created: "2026-01-01",
    audience,
  });
}

async function client(opts: DifOpenFeatureProviderOptions = {}) {
  await OpenFeature.setProviderAndWait(new DifOpenFeatureProvider(opts));
  return OpenFeature.getClient();
}

/** Find a user id the SDK buckets into `variant` for experiment `id`. */
function userFor(id: string, variant: string): string {
  for (let i = 0; i < 10_000; i++) {
    const userId = `user-${i}`;
    if (assign(id, { userId, attributes: {} })?.variant === variant) return userId;
  }
  throw new Error(`no user buckets into ${id}=${variant}`);
}

beforeEach(async () => {
  __reset();
  await OpenFeature.clearProviders();
  OpenFeature.setLogger(silent);
});

afterEach(async () => {
  await OpenFeature.clearProviders();
  __reset();
});

describe("DifOpenFeatureProvider", () => {
  it("declares server metadata", () => {
    const p = new DifOpenFeatureProvider();
    assert.equal(p.metadata.name, "dif.sh");
    assert.equal(p.runsOn, "server");
  });

  it("string value matches the SDK's own assign() across many user ids", async () => {
    register("pricing-copy", ["control", "variant_a", "variant_b"]);
    const of = await client();
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const userId = `u-${i}`;
      const expected = assign("pricing-copy", { userId, attributes: {} })!;
      const d = await of.getStringDetails("pricing-copy", "fallback", { targetingKey: userId });
      assert.equal(d.value, expected.variant);
      assert.equal(d.variant, expected.variant);
      assert.equal(d.reason, StandardResolutionReasons.SPLIT);
      assert.equal(d.flagMetadata.bucket, expected.bucket);
      assert.equal(d.flagMetadata.surface, "checkout");
      assert.equal(d.errorCode, undefined);
      seen.add(d.value);
    }
    assert.deepEqual([...seen].sort(), ["control", "variant_a", "variant_b"]);
  });

  it("boolean is false for the first declared variant, true otherwise (off/on)", async () => {
    register("new-checkout", ["off", "on"]);
    const of = await client();
    const offUser = userFor("new-checkout", "off");
    const onUser = userFor("new-checkout", "on");

    const off = await of.getBooleanDetails("new-checkout", true, { targetingKey: offUser });
    assert.equal(off.value, false);
    assert.equal(off.variant, "off");
    assert.equal(off.reason, StandardResolutionReasons.SPLIT);

    const on = await of.getBooleanDetails("new-checkout", false, { targetingKey: onUser });
    assert.equal(on.value, true);
    assert.equal(on.variant, "on");
    assert.equal(on.reason, StandardResolutionReasons.SPLIT);
  });

  it("boolean is false for the first declared variant, true otherwise (control/variant_a)", async () => {
    register("hero-copy", ["control", "variant_a"]);
    const of = await client();

    const c = await of.getBooleanDetails("hero-copy", true, {
      targetingKey: userFor("hero-copy", "control"),
    });
    assert.equal(c.value, false);
    assert.equal(c.variant, "control");

    const v = await of.getBooleanDetails("hero-copy", false, {
      targetingKey: userFor("hero-copy", "variant_a"),
    });
    assert.equal(v.value, true);
    assert.equal(v.variant, "variant_a");
  });

  it("no targetingKey → control, DEFAULT, no bucket, no exposure", async () => {
    register("new-checkout", ["off", "on"], () => true, { off: 0, on: 100 });
    const exposures: DifExposure[] = [];
    const of = await client({ onExposure: (e) => exposures.push(e) });

    for (const ctx of [{}, { device_type: "mobile" }, { targetingKey: "" }]) {
      const s = await of.getStringDetails("new-checkout", "fallback", ctx);
      assert.equal(s.value, "off");
      assert.equal(s.reason, StandardResolutionReasons.DEFAULT);
      assert.equal(s.flagMetadata.bucket, undefined);
      assert.equal(s.errorCode, undefined);

      const b = await of.getBooleanDetails("new-checkout", true, ctx);
      assert.equal(b.value, false);
      assert.equal(b.variant, "off");
      assert.equal(b.reason, StandardResolutionReasons.DEFAULT);
    }
    assert.equal(exposures.length, 0);
  });

  it("audience predicate miss → control, DEFAULT, no exposure; hit → SPLIT + exposure", async () => {
    let lastAttrs: Record<string, unknown> = {};
    register(
      "new-checkout",
      ["off", "on"],
      (attrs) => {
        lastAttrs = attrs;
        return attrs.device_type === "mobile";
      },
      { off: 0, on: 100 },
    );
    const exposures: DifExposure[] = [];
    const of = await client({ onExposure: (e) => exposures.push(e) });

    const miss = await of.getBooleanDetails("new-checkout", true, {
      targetingKey: "user-1",
      device_type: "desktop",
    });
    assert.equal(miss.value, false);
    assert.equal(miss.variant, "off");
    assert.equal(miss.reason, StandardResolutionReasons.DEFAULT);
    assert.equal(exposures.length, 0);

    const hit = await of.getBooleanDetails("new-checkout", false, {
      targetingKey: "user-1",
      device_type: "mobile",
      plan: "pro",
      seats: 3,
      beta: true,
      nested: { a: 1 },
      tags: ["x"],
      signedUp: new Date(0),
    });
    assert.equal(hit.value, true);
    assert.equal(hit.variant, "on");
    assert.equal(hit.reason, StandardResolutionReasons.SPLIT);

    // Scalars pass through; targetingKey and non-scalars don't.
    assert.deepEqual(lastAttrs, { device_type: "mobile", plan: "pro", seats: 3, beta: true });

    const expected = assign("new-checkout", {
      userId: "user-1",
      attributes: { device_type: "mobile" },
    })!;
    assert.deepEqual(exposures, [
      { flagKey: "new-checkout", variant: "on", bucket: expected.bucket, userId: "user-1" },
    ]);
  });

  it("object overrides → STATIC, forced variant, no bucket, no exposure", async () => {
    register("new-checkout", ["off", "on"], () => true, { off: 100, on: 0 });
    const exposures: DifExposure[] = [];
    const of = await client({
      overrides: { "new-checkout": "on" },
      onExposure: (e) => exposures.push(e),
    });

    const b = await of.getBooleanDetails("new-checkout", false, { targetingKey: "user-1" });
    assert.equal(b.value, true);
    assert.equal(b.variant, "on");
    assert.equal(b.reason, StandardResolutionReasons.STATIC);
    assert.equal(b.flagMetadata.bucket, undefined);

    // A force also applies with no user.
    const s = await of.getStringDetails("new-checkout", "fallback", {});
    assert.equal(s.value, "on");
    assert.equal(s.reason, StandardResolutionReasons.STATIC);
    assert.equal(exposures.length, 0);
  });

  it("function overrides read the evaluation context", async () => {
    register("new-checkout", ["off", "on"], () => true, { off: 100, on: 0 });
    const exposures: DifExposure[] = [];
    const of = await client({
      overrides: (ctx) => (ctx.qa === "on" ? { "new-checkout": "on" } : undefined),
      onExposure: (e) => exposures.push(e),
    });

    const forced = await of.getStringDetails("new-checkout", "fallback", {
      targetingKey: "user-1",
      qa: "on",
    });
    assert.equal(forced.value, "on");
    assert.equal(forced.reason, StandardResolutionReasons.STATIC);
    assert.equal(exposures.length, 0);

    const normal = await of.getStringDetails("new-checkout", "fallback", {
      targetingKey: "user-1",
    });
    assert.equal(normal.value, "off");
    assert.equal(normal.reason, StandardResolutionReasons.SPLIT);
    assert.equal(exposures.length, 1);
  });

  it("an override naming an undeclared variant is ignored", async () => {
    register("new-checkout", ["off", "on"], () => true, { off: 100, on: 0 });
    const of = await client({ overrides: { "new-checkout": "bogus" } });
    const d = await of.getStringDetails("new-checkout", "fallback", { targetingKey: "user-1" });
    assert.equal(d.value, "off");
    assert.equal(d.reason, StandardResolutionReasons.SPLIT);
  });

  it("unregistered key → defaultValue, ERROR, FLAG_NOT_FOUND", async () => {
    register("new-checkout", ["off", "on"]);
    const of = await client();

    const b = await of.getBooleanDetails("missing-flag", true, { targetingKey: "user-1" });
    assert.equal(b.value, true);
    assert.equal(b.reason, StandardResolutionReasons.ERROR);
    assert.equal(b.errorCode, ErrorCode.FLAG_NOT_FOUND);
    assert.match(b.errorMessage ?? "", /dif\/generated\/client/);
    assert.match(b.errorMessage ?? "", /dif build/);

    const s = await of.getStringDetails("missing-flag", "fallback", { targetingKey: "user-1" });
    assert.equal(s.value, "fallback");
    assert.equal(s.errorCode, ErrorCode.FLAG_NOT_FOUND);
  });

  it("number and object evaluations → defaultValue, ERROR, TYPE_MISMATCH", async () => {
    register("new-checkout", ["off", "on"]);
    const of = await client();
    const ctx = { targetingKey: "user-1" };

    assert.equal(await of.getNumberValue("new-checkout", 7, ctx), 7);
    const n = await of.getNumberDetails("new-checkout", 7, ctx);
    assert.equal(n.reason, StandardResolutionReasons.ERROR);
    assert.equal(n.errorCode, ErrorCode.TYPE_MISMATCH);
    assert.match(n.errorMessage ?? "", /variant id/);

    const fallback = { enabled: false };
    const o = await of.getObjectDetails("new-checkout", fallback, ctx);
    assert.deepEqual(o.value, fallback);
    assert.equal(o.errorCode, ErrorCode.TYPE_MISMATCH);
  });

  it("an onExposure that throws doesn't change the evaluation", async () => {
    register("new-checkout", ["off", "on"], () => true, { off: 0, on: 100 });
    let calls = 0;
    const of = await client({
      onExposure: () => {
        calls++;
        throw new Error("sink down");
      },
    });

    const d = await of.getBooleanDetails("new-checkout", false, { targetingKey: "user-1" });
    assert.equal(calls, 1);
    assert.equal(d.value, true);
    assert.equal(d.variant, "on");
    assert.equal(d.reason, StandardResolutionReasons.SPLIT);
    assert.equal(d.errorCode, undefined);
  });
});

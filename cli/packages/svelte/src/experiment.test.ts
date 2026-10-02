import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { __reset, __register, dif } from "@dif.sh/sdk";
import { decide } from "./experiment.js";
import type { DifData } from "./context.js";

const g = globalThis as { document?: unknown };

beforeEach(() => {
  __reset();
  // decide() only buckets in a browser; a bare document stands in for one.
  g.document = { cookie: "" };
  // Every bucketed user lands in variant_a, so a non-control result means
  // the client bucketed.
  __register({
    id: "a",
    surface: "home",
    variants: ["control", "variant_a"],
    salt: "00000000000000000000000000000000",
    weights: { control: 0, variant_a: 100 },
    exclusionGroup: null,
    created: "2026-01-01",
    audience: () => true,
  });
});

afterEach(() => {
  delete g.document;
  __reset();
});

function data(extra: Partial<DifData> = {}): DifData {
  return { difUid: "u-1", assignments: {}, attributes: {}, overrides: {}, ...extra };
}

describe("decide (no server assignment)", () => {
  it("buckets on the client", () => {
    assert.equal(decide("a", data(), "control").variant, "variant_a");
  });

  it("kill switch: control, with no exposure", () => {
    const d = decide("a", data({ enabled: false }), "control");
    assert.deepEqual(d, { variant: "control", bucket: null, exposed: false });
  });

  it("kill switch: a valid force still wins, with no exposure", () => {
    dif.init({
      events: { mode: "custom", exposure: () => {}, track: () => {} },
      overrides: { a: "variant_a" },
    });
    const d = decide("a", data({ enabled: false }), "control");
    assert.deepEqual(d, { variant: "variant_a", bucket: null, exposed: false });
  });
});

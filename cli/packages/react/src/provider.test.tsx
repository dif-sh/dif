// DifProvider + useDif — rendered with react-dom/server so the suite runs in
// plain Node. The registered spec weights are 0/100 (always variant_a), which
// makes initialization observable: an uninitialized SDK renders the first
// branch ("control"), an initialized one buckets to variant_a.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
// Classic-transform JSX (tsconfig excludes tests, so tsx doesn't pick up the
// react-jsx setting) — the explicit React binding is required at runtime.
import * as React from "react";
import { renderToString } from "react-dom/server";
import { __register, __reset, dif } from "@dif.sh/sdk";

import { DifProvider, useDif } from "./provider.js";

function registerAllVariantA(id: string): void {
  __register({
    id,
    surface: "home",
    variants: ["control", "variant_a"],
    salt: "00000000000000000000000000000000",
    weights: { control: 0, variant_a: 100 },
    exclusionGroup: null,
    created: "2026-01-01",
    audience: () => true,
  });
}

function Probe({ id }: { id: string }) {
  const { exposure } = useDif();
  const value = exposure(id, {
    control: () => "rendered-control",
    variant_a: () => "rendered-variant-a",
  })();
  return <span>{String(value)}</span>;
}

beforeEach(() => {
  __reset();
});

afterEach(() => {
  __reset();
  delete (globalThis as { window?: unknown }).window;
});

describe("DifProvider", () => {
  it("does NOT initialize the SDK during a server render", () => {
    registerAllVariantA("exp");
    const html = renderToString(
      <DifProvider config={{ userId: () => "u-1", sink: [] }}>
        <Probe id="exp" />
      </DifProvider>,
    );
    // Uninitialized SDK → first branch. Had init run on the server, the
    // 0/100 weights would have bucketed u-1 into variant_a.
    assert.ok(html.includes("rendered-control"), html);
  });

  it("initializes the SDK when window exists (client render)", () => {
    registerAllVariantA("exp");
    (globalThis as { window?: unknown }).window = {};
    const html = renderToString(
      <DifProvider config={{ userId: () => "u-1", sink: [] }}>
        <Probe id="exp" />
      </DifProvider>,
    );
    assert.ok(html.includes("rendered-variant-a"), html);
  });

  it("exposes a working track function through context", () => {
    (globalThis as { window?: unknown }).window = {};
    let sawContext = false;
    function TrackProbe() {
      const ctx = useDif();
      sawContext = typeof ctx.track === "function" && typeof ctx.exposure === "function";
      return null;
    }
    renderToString(
      <DifProvider config={{ userId: () => "u-1", sink: [] }}>
        <TrackProbe />
      </DifProvider>,
    );
    assert.ok(sawContext);
  });

  it("shares the module singleton with the bare dif import", () => {
    registerAllVariantA("exp");
    (globalThis as { window?: unknown }).window = {};
    renderToString(
      <DifProvider config={{ userId: () => "u-1", sink: [] }}>
        <span />
      </DifProvider>,
    );
    // The provider's init is visible to the bare `dif(...)` call site.
    const value = dif("exp", {
      control: () => "c",
      variant_a: () => "v",
    })();
    assert.equal(value, "v");
  });
});

describe("useDif", () => {
  it("throws with a clear message outside <DifProvider>", () => {
    assert.throws(
      () => renderToString(<Probe id="exp" />),
      /useDif must be called inside <DifProvider>/,
    );
  });
});

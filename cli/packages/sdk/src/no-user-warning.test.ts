import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { dif, __reset, __register } from "./index.js";
import type { DifInitConfig, ExperimentSpec } from "./index.js";

const spec: ExperimentSpec = {
  id: "hero",
  surface: "web",
  salt: "00112233445566778899aabbccddeeff",
  variants: ["control", "treatment"],
  weights: { control: 50, treatment: 50 },
  audience: () => true,
  exclusionGroup: null,
  created: "2026-11-25",
};

const realWarn = console.warn;
const realEnv = process.env.NODE_ENV;
let warnings: string[] = [];

function init(extra: Partial<DifInitConfig>) {
  dif.init({
    events: { mode: "custom", exposure: () => {}, track: () => {} },
    ...extra,
  } as DifInitConfig);
}

const show = () => dif("hero", { control: () => "c", treatment: () => "t" })();
const noUser = () => warnings.filter((w) => w.includes("no user id"));

beforeEach(() => {
  __reset();
  __register(spec);
  warnings = [];
  console.warn = (msg: string) => warnings.push(String(msg));
  delete process.env.NODE_ENV;
});

afterEach(() => {
  console.warn = realWarn;
  if (realEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = realEnv;
  __reset();
});

describe("experiment with no user id", () => {
  it("warns once and links the anonymous visitors docs", () => {
    init({ userId: () => null });
    show();
    show();
    assert.equal(noUser().length, 1);
    assert.match(noUser()[0]!, /anonymousUserId: true/);
    assert.match(noUser()[0]!, /https:\/\/www\.dif\.sh\/docs\/anonymous-visitors/);
  });

  it("stays quiet in production", () => {
    process.env.NODE_ENV = "production";
    init({ userId: () => null });
    show();
    assert.equal(noUser().length, 0);
  });

  it("stays quiet with anonymousUserId on", () => {
    init({ userId: () => null, anonymousUserId: true });
    show();
    assert.equal(noUser().length, 0);
  });

  it("stays quiet when there is a user id", () => {
    init({ userId: () => "u-1" });
    show();
    assert.equal(noUser().length, 0);
  });

  it("stays quiet when the SDK is off", () => {
    init({ userId: () => null, enabled: false });
    show();
    assert.equal(noUser().length, 0);
  });
});

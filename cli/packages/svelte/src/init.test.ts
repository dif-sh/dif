import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { dif, __reset } from "@dif.sh/sdk";
import type { DifInitConfig } from "@dif.sh/sdk";
import { initDif } from "./init.js";

const g = globalThis as { document?: unknown };
const realInit = dif.init;
let seen: DifInitConfig | null = null;

beforeEach(() => {
  __reset();
  seen = null;
  g.document = { cookie: "dif_uid=abc-123" };
  dif.init = (cfg) => {
    seen = cfg;
  };
});

afterEach(() => {
  dif.init = realInit;
  delete g.document;
  __reset();
});

describe("initDif", () => {
  it("marks the dif_uid cookie as an anonymous id", () => {
    initDif({ publishableKey: "dif_pk_test_x" });
    assert.equal(seen?.anonymousUserId, true);
    assert.equal(seen?.userId?.(), "abc-123");
  });

  it("keeps anonymousUserId on when the caller passes false", () => {
    initDif({ publishableKey: "dif_pk_test_x", anonymousUserId: false });
    assert.equal(seen?.anonymousUserId, true);
  });

  it("passes pageViews through", () => {
    initDif({ publishableKey: "dif_pk_test_x", pageViews: "auto" });
    assert.equal(seen?.pageViews, "auto");
  });
});

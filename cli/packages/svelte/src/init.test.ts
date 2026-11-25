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
  it("lets the core SDK read or mint the dif_uid cookie", () => {
    initDif({ publishableKey: "dif_pk_test_x" });
    assert.equal(seen?.anonymousUserId, true);
    assert.equal(seen?.anonymousCookieName, "dif_uid");
    assert.equal(seen?.userId, undefined);
  });

  it("seeds the user id from difLoad", () => {
    initDif({ data: { difUid: "srv-1" } as never });
    assert.equal(seen?.userId?.(), "srv-1");
  });

  it("passes the difLoad cookie name to the core SDK", () => {
    initDif({ data: { difUid: "srv-1", cookieName: "my_uid" } as never });
    assert.equal(seen?.anonymousCookieName, "my_uid");
  });

  it("lets cookieName beat the difLoad name", () => {
    initDif({ data: { difUid: "srv-1", cookieName: "my_uid" } as never, cookieName: "x_uid" });
    assert.equal(seen?.anonymousCookieName, "x_uid");
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

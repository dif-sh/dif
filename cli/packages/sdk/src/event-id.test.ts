import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { uuidv7 } from "./event-id.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  it("returns the lowercase canonical form with version 7 and the RFC variant", () => {
    for (let i = 0; i < 200; i++) assert.match(uuidv7(), UUID_V7);
  });

  it("puts the unix millisecond time in the first 48 bits", () => {
    const ms = 1_700_000_000_123;
    const id = uuidv7(ms);
    const hex = id.replace(/-/g, "").slice(0, 12);
    assert.equal(parseInt(hex, 16), ms);
  });

  it("sorts by time across milliseconds", () => {
    const ids = [3, 1, 2].map((n) => uuidv7(1_700_000_000_000 + n));
    assert.deepEqual([...ids].sort(), [ids[1], ids[2], ids[0]]);
  });

  it("does not repeat inside one millisecond", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(uuidv7(1_700_000_000_000));
    assert.equal(seen.size, 5000);
  });
});

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { LIMITS } from "./limits.js";
import { cleanProps, warnProps, warnName, __resetPropWarnings } from "./props.js";
import { validateTrack } from "./validate.js";

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../test-data/${name}`, import.meta.url), "utf8"));

interface Vector {
  name: string;
  props: unknown;
  stored: [string, unknown][];
  dropped: { key: string; why: string }[];
}

describe("limits copy", () => {
  it("equals the checked-in copy of dif-db's limits.json", () => {
    assert.deepEqual({ ...LIMITS }, load("limits.json"));
  });
});

describe("cleanProps against dif-db's vectors", () => {
  const vectors: Vector[] = load("props-vectors.json").vectors;
  assert.ok(vectors.length >= 20);
  for (const v of vectors) {
    it(v.name, () => {
      const got = cleanProps(v.props);
      assert.equal(got.props.length, v.stored.length);
      got.props.forEach(([k, val], i) => {
        const [wantK, wantVal] = v.stored[i]!;
        assert.equal(k, wantK);
        assert.ok(Object.is(val, wantVal), `${k}: ${String(val)} is not ${String(wantVal)}`);
      });
      assert.deepEqual(got.dropped, v.dropped);
    });
  }

  it("drops a non-finite number", () => {
    const got = cleanProps({ a: Infinity, b: NaN, c: 1 });
    assert.deepEqual(got.props, [["c", 1]]);
    assert.deepEqual(got.dropped, [
      { key: "a", why: "number not finite" },
      { key: "b", why: "number not finite" },
    ]);
  });
});

describe("cleanProps at the stored byte limit", () => {
  const fill = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    for (let i = 0; i < 7; i++) p[`k${i}`] = "x".repeat(1024);
    return p;
  };
  it("keeps the last key at exactly 8192 bytes and drops it at 8193", () => {
    assert.equal(cleanProps({ ...fill(), z: "x".repeat(960) }).dropped.length, 0);
    const over = cleanProps({ ...fill(), z: "x".repeat(961) });
    assert.deepEqual(over.dropped, [{ key: "z", why: "props over 8192 bytes" }]);
  });
  it("counts -0 as two bytes", () => {
    assert.equal(cleanProps({ ...fill(), y: -0, z: "x".repeat(953) }).dropped.length, 0);
    const over = cleanProps({ ...fill(), y: -0, z: "x".repeat(954) });
    assert.deepEqual(over.dropped, [{ key: "z", why: "props over 8192 bytes" }]);
  });
});

describe("warnings", () => {
  const lines: string[] = [];
  const original = console.warn;
  beforeEach(() => {
    lines.length = 0;
    console.warn = (m: string) => void lines.push(m);
    __resetPropWarnings();
  });
  const restore = () => {
    console.warn = original;
  };

  it("warns once per dropped key, without the value", () => {
    warnProps({ plan: "x".repeat(2000), $o: 1 });
    warnProps({ plan: "x".repeat(2000) });
    restore();
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /"\$o".*starts with \$/);
    assert.match(lines[1]!, /"plan".*string over 1024 bytes/);
    assert.ok(!lines[1]!.includes("xxxx"));
  });

  it("says nothing for clean props", () => {
    warnProps({ plan: "pro", n: 1, nothing: null });
    restore();
    assert.equal(lines.length, 0);
  });

  it("warns once about a name that starts with $", () => {
    warnName("track", "$custom");
    warnName("track", "$custom");
    warnName("track", "plain");
    restore();
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /\$custom/);
  });

  it("validateTrack warns and still accepts the event", () => {
    const e = { metric: "$m", user_id: "u", props: { a: "x".repeat(2000) } };
    assert.equal(validateTrack(e), null);
    restore();
    assert.equal(lines.length, 2);
  });

  it("does not throw on a non-string name or a throwing getter", () => {
    const hostile = {
      get a(): string {
        throw new Error("boom");
      },
    };
    warnName("track", undefined as unknown as string);
    warnProps(hostile);
    restore();
    assert.equal(lines.length, 0);
  });
});

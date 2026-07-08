import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  dif,
  __reset,
  parseOverrides,
  serializeOverrides,
  syncOverrides,
  mountDifPreview,
} from "./index.js";

// -- minimal browser mock -----------------------------------------------------

function setupBrowser(href: string, cookie = ""): void {
  let jar = cookie;
  const win = {
    location: { href },
    history: {
      state: null as unknown,
      replaceState(_state: unknown, _title: string, url: string) {
        win.location.href = new URL(url, href).href;
      },
    },
  };
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).document = {
    get cookie() {
      return jar;
    },
    set cookie(v: string) {
      const pair = v.split(";")[0]!;
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const rest = jar
        .split("; ")
        .filter((c) => c && !c.startsWith(name + "="));
      if (!/max-age=0/i.test(v)) rest.push(`${name}=${pair.slice(eq + 1)}`);
      jar = rest.join("; ");
    },
  };
}

function teardownBrowser(): void {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
}

beforeEach(() => __reset());
afterEach(() => {
  teardownBrowser();
  __reset();
});

describe("parseOverrides", () => {
  it("parses id=variant pairs", () => {
    assert.deepEqual(parseOverrides("a=v1,b=v2"), { a: "v1", b: "v2" });
  });
  it("returns null for off/clear (clear signal)", () => {
    assert.equal(parseOverrides("off"), null);
    assert.equal(parseOverrides("clear"), null);
  });
  it("returns {} for empty/null", () => {
    assert.deepEqual(parseOverrides(""), {});
    assert.deepEqual(parseOverrides(null), {});
  });
  it("skips malformed pairs and trims", () => {
    assert.deepEqual(parseOverrides(" a = v1 , junk , =x , b=v2 "), { a: "v1", b: "v2" });
  });
});

describe("serializeOverrides", () => {
  it("sorts by id and round-trips with parseOverrides", () => {
    assert.equal(serializeOverrides({ b: "v2", a: "v1" }), "a=v1,b=v2");
    assert.deepEqual(parseOverrides(serializeOverrides({ b: "v2", a: "v1" })), { a: "v1", b: "v2" });
  });
});

describe("syncOverrides", () => {
  it("returns {} on the server (no window)", () => {
    assert.deepEqual(syncOverrides(), {});
  });

  it("reads the ?_dif param, persists a cookie, pushes to state, and strips the URL", () => {
    setupBrowser("http://localhost/page?_dif=a=variant_a,b=control&keep=1");
    dif.init({ userId: () => "u" });
    const active = syncOverrides();
    assert.deepEqual(active, { a: "variant_a", b: "control" });
    assert.deepEqual(dif.getOverrides(), { a: "variant_a", b: "control" });
    // URL param stripped, other params kept.
    const href = (globalThis as Record<string, any>).window.location.href as string;
    assert.ok(!href.includes("_dif"), `expected _dif stripped, got ${href}`);
    assert.ok(href.includes("keep=1"));
    // Cookie persisted → a later sync with no param still resolves them.
    const cookie = (globalThis as Record<string, any>).document.cookie as string;
    assert.ok(cookie.includes("_dif="));
  });

  it("?_dif=off clears the cookie and state", () => {
    setupBrowser("http://localhost/page?_dif=off", "_dif=a%3Dvariant_a");
    dif.init({ userId: () => "u" });
    const active = syncOverrides();
    assert.deepEqual(active, {});
    assert.deepEqual(dif.getOverrides(), {});
  });

  it("with no param, resolves from the persisted cookie", () => {
    setupBrowser("http://localhost/page", "_dif=a%3Dvariant_a%2Cb%3Dcontrol");
    dif.init({ userId: () => "u" });
    assert.deepEqual(syncOverrides(), { a: "variant_a", b: "control" });
  });

  it("allow:false ignores and clears", () => {
    setupBrowser("http://localhost/page?_dif=a=variant_a");
    dif.init({ userId: () => "u" });
    assert.deepEqual(syncOverrides({ allow: false }), {});
    assert.deepEqual(dif.getOverrides(), {});
  });
});

describe("mountDifPreview", () => {
  it("is a safe no-op on the server (no document)", () => {
    assert.doesNotThrow(() => mountDifPreview({ overrides: { a: "v1" } }));
  });
});

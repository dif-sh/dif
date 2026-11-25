import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { dif, __reset, __register } from "./index.js";
import type { DifInitConfig, ExperimentSpec, ExposureEvent } from "./index.js";

const g = globalThis as Record<string, unknown>;

/** A document with a cookie jar, as a browser has. */
function installCookies(initial = "", protocol = "https:") {
  const jar = new Map<string, string>();
  const writes: string[] = [];
  for (const part of initial.split("; ").filter(Boolean)) {
    const i = part.indexOf("=");
    jar.set(part.slice(0, i), part.slice(i + 1));
  }
  const document = {
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(line: string) {
      writes.push(line);
      const pair = line.split(";")[0]!;
      const i = pair.indexOf("=");
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    },
  };
  g.document = document;
  g.location = { href: `${protocol}//shop.example/`, protocol };
  return { jar, writes };
}

const spec: ExperimentSpec = {
  id: "hero",
  surface: "web",
  salt: "00112233445566778899aabbccddeeff",
  variants: ["control", "treatment"],
  weights: { control: 0, treatment: 100 },
  audience: () => true,
  exclusionGroup: null,
  created: "2026-11-25",
};

let exposures: ExposureEvent[] = [];

function init(extra: Partial<DifInitConfig>) {
  dif.init({
    events: { mode: "custom", exposure: (e) => exposures.push(e), track: () => {} },
    ...extra,
  } as DifInitConfig);
}

const show = () => dif("hero", { control: () => "c", treatment: () => "t" })();

beforeEach(() => {
  __reset();
  exposures = [];
  __register(spec);
});

afterEach(() => {
  delete g.document;
  delete g.location;
  __reset();
});

describe("anonymousUserId: true", () => {
  it("mints a dif_uid cookie and buckets the visitor", () => {
    const { jar, writes } = installCookies();
    init({ anonymousUserId: true });
    assert.equal(show(), "t");
    const id = jar.get("dif_uid");
    assert.match(id ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(exposures[0]?.user_id, id);
    assert.match(writes[0]!, /; path=\/; max-age=31536000; samesite=lax; secure$/);
  });

  it("reuses the cookie from an earlier visit", () => {
    const { writes } = installCookies("dif_uid=visitor-1");
    init({ anonymousUserId: true });
    show();
    assert.equal(exposures[0]?.user_id, "visitor-1");
    assert.equal(writes.length, 0);
  });

  it("ignores a cookie part with no equals sign", () => {
    installCookies();
    const writes: string[] = [];
    g.document = {
      get cookie() {
        return "dif_uidx";
      },
      set cookie(line: string) {
        writes.push(line);
      },
    };
    init({ anonymousUserId: true });
    show();
    assert.notEqual(exposures[0]?.user_id, "dif_uidx");
    assert.equal(writes.length, 1);
  });

  it("keeps one id across calls", () => {
    installCookies();
    init({ anonymousUserId: true });
    show();
    dif("hero", { control: () => "c", treatment: () => "t" })();
    assert.equal(exposures.length, 1);
  });

  it("prefers the userId resolver when it gives an id", () => {
    const { writes } = installCookies("dif_uid=visitor-1");
    init({ anonymousUserId: true, userId: () => "user-7" });
    show();
    assert.equal(exposures[0]?.user_id, "user-7");
    assert.equal(writes.length, 0);
  });

  it("falls back to the cookie when the resolver gives null", () => {
    installCookies("dif_uid=visitor-1");
    init({ anonymousUserId: true, userId: () => null });
    show();
    assert.equal(exposures[0]?.user_id, "visitor-1");
  });

  it("uses anonymousCookieName", () => {
    const { jar } = installCookies("other=x");
    init({ anonymousUserId: true, anonymousCookieName: "my_uid" });
    show();
    assert.ok(jar.get("my_uid"));
    assert.equal(exposures[0]?.user_id, jar.get("my_uid"));
  });

  it("omits secure on plain http", () => {
    const { writes } = installCookies("", "http:");
    init({ anonymousUserId: true });
    show();
    assert.doesNotMatch(writes[0]!, /secure/);
  });

  it("mints nothing on a server", () => {
    init({ anonymousUserId: true });
    assert.equal(show(), "c");
    assert.equal(exposures.length, 0);
  });

  it("mints nothing without the option", () => {
    const { writes } = installCookies();
    init({ userId: () => null });
    assert.equal(show(), "c");
    assert.equal(writes.length, 0);
  });
});

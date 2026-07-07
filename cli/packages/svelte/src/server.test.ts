import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { __reset, __register } from "@dif.sh/sdk";
import type { AudienceFn } from "@dif.sh/sdk";
import { difLoad, attributesFromHeaders } from "./server.js";
import type { DifRequestEventLike } from "./server.js";

let fetchCalls = 0;
let originalFetch: typeof fetch;

interface SetCall {
  name: string;
  value: string;
  opts: Record<string, unknown>;
}

function fakeEvent(
  opts: {
    cookie?: string;
    headers?: Record<string, string>;
    /** Value of the `?_dif=` URL param. */
    dif?: string;
    /** Pre-existing `_dif` cookie value. */
    difCookie?: string;
  } = {},
): {
  event: DifRequestEventLike;
  setCalls: SetCall[];
} {
  const jar = new Map<string, string>();
  if (opts.cookie) jar.set("dif_uid", opts.cookie);
  if (opts.difCookie) jar.set("_dif", opts.difCookie);
  const setCalls: SetCall[] = [];
  const headers = new Map(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const params = new Map<string, string>();
  if (opts.dif !== undefined) params.set("_dif", opts.dif);
  const event: DifRequestEventLike = {
    cookies: {
      get: (n) => jar.get(n),
      set: (n, v, o) => {
        jar.set(n, v);
        setCalls.push({ name: n, value: v, opts: o as Record<string, unknown> });
      },
    },
    request: { headers: { get: (n) => headers.get(n.toLowerCase()) ?? null } },
    url: { searchParams: { get: (n) => params.get(n) ?? null } },
  };
  return { event, setCalls };
}

beforeEach(() => {
  __reset();
  fetchCalls = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response("{}", { status: 202 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __reset();
});

function register(id: string, audience: AudienceFn = () => true): void {
  __register({
    id,
    surface: "home",
    variants: ["control", "variant_a"],
    salt: "00000000000000000000000000000000",
    weights: { control: 50, variant_a: 50 },
    exclusionGroup: null,
    created: "2026-01-01",
    audience,
  });
}

describe("attributesFromHeaders", () => {
  it("parses locale from Accept-Language", () => {
    const a = attributesFromHeaders({
      get: (n) => (n.toLowerCase() === "accept-language" ? "en-US,en;q=0.9" : null),
    });
    assert.equal(a.locale, "en-US");
  });

  it("classifies device_type from User-Agent", () => {
    const ua = (s: string) => ({
      get: (n: string) => (n.toLowerCase() === "user-agent" ? s : null),
    });
    assert.equal(attributesFromHeaders(ua("iPhone")).device_type, "mobile");
    assert.equal(attributesFromHeaders(ua("iPad")).device_type, "tablet");
    assert.equal(attributesFromHeaders(ua("Mozilla/5.0 (Macintosh)")).device_type, "desktop");
  });
});

describe("difLoad", () => {
  it("mints a dif_uid cookie when absent, with the right flags", () => {
    register("a");
    const { event, setCalls } = fakeEvent();
    const data = difLoad(event);
    assert.ok(data.difUid);
    assert.equal(setCalls.length, 1);
    assert.equal(setCalls[0]!.name, "dif_uid");
    assert.equal(setCalls[0]!.opts.httpOnly, false);
    assert.equal(setCalls[0]!.opts.secure, true);
    assert.equal(setCalls[0]!.opts.sameSite, "lax");
    assert.equal(setCalls[0]!.opts.path, "/");
  });

  it("reuses an existing cookie", () => {
    register("a");
    const { event, setCalls } = fakeEvent({ cookie: "existing-id" });
    const data = difLoad(event);
    assert.equal(data.difUid, "existing-id");
    assert.equal(setCalls.length, 0);
  });

  it("assigns every registered experiment and fires nothing", async () => {
    register("a");
    register("b");
    const { event } = fakeEvent({ cookie: "u-1" });
    const data = difLoad(event);
    assert.deepEqual(Object.keys(data.assignments).sort(), ["a", "b"]);
    for (const k of ["a", "b"]) {
      assert.ok(["control", "variant_a"].includes(data.assignments[k]!.variant));
    }
    await Promise.resolve();
    assert.equal(fetchCalls, 0, "difLoad must not fire exposures");
  });

  it("reflects audience hit/miss in `exposed`", () => {
    register("gated", (attr) => attr.locale === "en-US");
    const hit = difLoad(
      fakeEvent({ cookie: "u-1", headers: { "accept-language": "en-US" } }).event,
    );
    assert.equal(hit.assignments.gated!.exposed, true);
    const miss = difLoad(
      fakeEvent({ cookie: "u-1", headers: { "accept-language": "fr-FR" } }).event,
    );
    assert.equal(miss.assignments.gated!.exposed, false);
  });

  it("returns no assignments when disabled", () => {
    register("a");
    const data = difLoad(fakeEvent({ cookie: "u-1" }).event, { enabled: false });
    assert.deepEqual(data.assignments, {});
    assert.ok(data.difUid);
  });
});

describe("difLoad overrides", () => {
  it("honors ?_dif: forces the variant (exposed:false), persists a session cookie", () => {
    register("a");
    register("b");
    const { event, setCalls } = fakeEvent({ cookie: "u-1", dif: "a=variant_a" });
    const data = difLoad(event);

    assert.deepEqual(data.overrides, { a: "variant_a" });
    assert.deepEqual(data.assignments.a, { variant: "variant_a", bucket: null, exposed: false });
    // A non-forced experiment still buckets normally (exposed:true).
    assert.equal(data.assignments.b!.exposed, true);

    const cookie = setCalls.find((s) => s.name === "_dif");
    assert.ok(cookie, "expected a _dif cookie to be set");
    assert.equal(cookie!.value, "a=variant_a");
    assert.equal(cookie!.opts.maxAge, undefined, "should be a session cookie");
  });

  it("?_dif=off clears the cookie and forces nothing", () => {
    register("a");
    const { event, setCalls } = fakeEvent({ cookie: "u-1", difCookie: "a=variant_a", dif: "off" });
    const data = difLoad(event);
    assert.deepEqual(data.overrides, {});
    assert.notEqual(data.assignments.a!.exposed, false); // back to normal bucketing
    const cleared = setCalls.find((s) => s.name === "_dif");
    assert.equal(cleared!.opts.maxAge, 0, "off should expire the cookie");
  });

  it("with no ?_dif, resolves forces from the persisted _dif cookie", () => {
    register("a");
    const { event } = fakeEvent({ cookie: "u-1", difCookie: "a=variant_a" });
    const data = difLoad(event);
    assert.deepEqual(data.overrides, { a: "variant_a" });
    assert.equal(data.assignments.a!.variant, "variant_a");
    assert.equal(data.assignments.a!.exposed, false);
  });

  it("allowOverrides:false ignores ?_dif entirely", () => {
    register("a");
    const { event } = fakeEvent({ cookie: "u-1", dif: "a=variant_a" });
    const data = difLoad(event, { allowOverrides: false });
    assert.deepEqual(data.overrides, {});
    assert.equal(data.assignments.a!.exposed, true);
  });
});

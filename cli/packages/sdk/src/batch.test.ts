// The /v1/batch queue: page, identify and anonymous track elements.
// Without a window, each element is one request at once.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { dif, __reset } from "./index.js";
import { FLUSH_BYTES, __resetQueues } from "./queue.js";
import { SOURCE } from "./version.js";
import { installBrowser, type FakeBrowser } from "./fake-browser.test.js";

const KEY = "dif_pk_live_aaaaaaaa_secret-secret-secret";
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Call {
  url: string;
  init: RequestInit;
  body: Array<Record<string, unknown>>;
}

let calls: Call[] = [];
let status: (call: Call) => number = () => 202;
let warnings: string[] = [];
let browser: FakeBrowser | null = null;
let originalFetch: typeof fetch;
let originalWarn: typeof console.warn;

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

const batchCalls = () => calls.filter((c) => c.url.includes("/v1/batch"));
const elements = () => batchCalls().flatMap((c) => c.body);

beforeEach(() => {
  __reset();
  calls = [];
  status = () => 202;
  warnings = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    return new Response("{}", { status: status(call) });
  }) as typeof fetch;
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  browser = installBrowser({
    href: "https://shop.example/pricing?utm_source=news&token=t",
    referrer: "https://search.example/?q=x",
  });
});

afterEach(() => {
  __reset();
  __resetQueues();
  browser?.uninstall();
  browser = null;
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

describe("the /v1/batch queue", () => {
  it("posts a page view with the key in the URL and a text body", () => {
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.page();
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, `https://ingest.difdb.com/v1/batch?key=${KEY}`);
    assert.equal(call.init.method, "POST");
    assert.equal(typeof call.init.body, "string");
    assert.deepEqual(call.init.headers, { "content-type": "text/plain;charset=UTF-8" });
    assert.equal(call.init.keepalive, true);
    assert.equal(call.body.length, 1);
    assert.equal(call.body[0]!.type, "page");
    assert.equal(call.body[0]!.url, "https://shop.example/pricing?utm_source=news");
  });

  it("uses ingestUrl from init, without trailing slashes", () => {
    dif.init({ publishableKey: KEY, userId: () => null, ingestUrl: "https://ingest.test//" });
    dif.page();
    assert.equal(calls[0]!.url, `https://ingest.test/v1/batch?key=${KEY}`);
  });

  it("uses ingestUrl from the generated events config", () => {
    dif.init({
      userId: () => null,
      events: { mode: "cloud", publishableKey: KEY, ingestUrl: "https://ingest.test" },
    });
    dif.page();
    assert.equal(calls[0]!.url, `https://ingest.test/v1/batch?key=${KEY}`);
  });

  it("keeps tracks with a user id on apiUrl", () => {
    dif.init({
      publishableKey: KEY,
      userId: () => "u-1",
      apiUrl: "https://cloud.test",
      ingestUrl: "https://ingest.test",
    });
    dif.track("signup");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://cloud.test/v1/track");
    assert.equal("url" in calls[0]!.body[0]!, false);
  });

  it("sends an identify element with traits", () => {
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.identify("u-9", { plan: "pro" });
    assert.equal(elements().length, 1);
    assert.equal(elements()[0]!.type, "identify");
    assert.equal(elements()[0]!.user_id, "u-9");
  });

  it("uses a new queue when ingestUrl changes", () => {
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.page();
    dif.init({ publishableKey: KEY, userId: () => null, ingestUrl: "https://ingest.test" });
    dif.page();
    assert.equal(calls[1]!.url, `https://ingest.test/v1/batch?key=${KEY}`);
  });

  it("sends nothing after a switch to custom mode", () => {
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.init({
      userId: () => null,
      events: { mode: "custom", exposure: () => {}, track: () => {} },
    });
    dif.page();
    assert.equal(calls.length, 0);
  });

  it("sends nothing without a publishable key", () => {
    dif.init({ userId: () => null });
    dif.page();
    dif.identify("u-9", { plan: "pro" });
    assert.equal(calls.length, 0);
  });

  it("uses a new queue when the key changes", () => {
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.page();
    dif.init({ publishableKey: `${KEY}-2`, userId: () => null });
    dif.page();
    assert.deepEqual(
      calls.map((c) => c.url),
      [`https://ingest.difdb.com/v1/batch?key=${KEY}`, `https://ingest.difdb.com/v1/batch?key=${KEY}-2`],
    );
  });

  it("drops an element the collector refuses, with a warning", () => {
    dif.init({ publishableKey: KEY, userId: () => 7 as unknown as string });
    dif.page();
    assert.equal(calls.length, 0);
    assert.match(warnings[0] ?? "", /user_id must be a non-empty string/);
  });

  it("stops for the page load after a 403, with one warning", async () => {
    status = () => 403;
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.page();
    await settle();
    dif.page({ url: "/a" });
    dif.identify("u-9", { plan: "pro" });
    dif.init({ publishableKey: KEY, userId: () => null, apiUrl: "https://other.test" });
    dif.page({ url: "/b" });
    await settle();
    assert.equal(batchCalls().length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /403/);
  });

  it("warns once when requests in flight all get a 403", async () => {
    status = () => 403;
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.page({ url: "/a" });
    dif.page({ url: "/b" });
    await settle();
    assert.equal(batchCalls().length, 2);
    assert.equal(warnings.length, 1);
  });

  it("does not stop after another refusal", async () => {
    status = () => 401;
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.page();
    await settle();
    dif.page({ url: "/a" });
    await settle();
    assert.equal(batchCalls().length, 2);
  });

  it("holds page views for one request in a browser with a window", async () => {
    const g = globalThis as Record<string, unknown>;
    g.window = new EventTarget();
    try {
      dif.init({ publishableKey: KEY, userId: () => null });
      dif.page({ url: "/a" });
      dif.page({ url: "/b" });
      dif.page({ url: "/c" });
      assert.equal(calls.length, 0);
      await dif.flush();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.body.length, 3);
    } finally {
      __reset();
      __resetQueues();
      delete g.window;
    }
  });

  it("sends the props dif-db stores, and warns once per dropped key", () => {
    dif.init({ publishableKey: KEY, userId: () => null, anonymous: true });
    const props = { plan: "pro", $bad: 1, team: { size: 3, deep: { x: 1 } }, tags: ["a"] };
    dif.page({ props });
    dif.track("signup", { props });
    dif.identify("u-9", props);
    const cleaned = { plan: "pro", "team.size": 3 };
    assert.deepEqual(elements()[0]!.props, cleaned);
    assert.deepEqual(elements()[1]!.props, cleaned);
    assert.deepEqual(elements()[2]!.traits, cleaned);
    assert.deepEqual(warnings.filter((w) => w.includes("$bad")).length, 1);
    assert.deepEqual(warnings.filter((w) => w.includes("team.deep")).length, 1);
  });

  it("sends no props when none are stored, but always traits", () => {
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.page({ props: { $bad: 1 } });
    dif.identify("u-9", { $bad: 1 });
    assert.equal("props" in elements()[0]!, false);
    assert.deepEqual(elements()[1]!.traits, {});
  });

  it("lets three queues hold 36 KB at page hide", () => {
    assert.equal(FLUSH_BYTES, 12_000);
  });
});

describe("anonymous tracks", () => {
  it("are dropped by default", () => {
    dif.init({ publishableKey: KEY, userId: () => null });
    dif.track("signup");
    assert.equal(calls.length, 0);
  });

  it("go to /v1/batch with no user_id when anonymous is on", () => {
    dif.init({ publishableKey: KEY, userId: () => null, anonymous: true });
    const before = Date.now();
    dif.track("signup", {
      value: 3,
      currency: "USD",
      unit: "seats",
      idempotencyKey: "k-1",
      props: { plan: "pro" },
    });
    assert.equal(batchCalls().length, 1);
    const e = elements()[0]!;
    assert.match(String(e.event_id), UUID_V7);
    assert.ok(Number(e.fired_at) >= before);
    const { event_id: _id, fired_at: _at, ...rest } = e;
    assert.deepEqual(rest, {
      type: "track",
      source: SOURCE,
      event: "signup",
      value: 3,
      currency: "USD",
      unit: "seats",
      idempotency_key: "k-1",
      url: "https://shop.example/pricing?utm_source=news",
      referrer: "https://search.example/",
      props: { plan: "pro" },
    });
  });

  it("carry wd when navigator.webdriver is true", () => {
    browser!.uninstall();
    browser = installBrowser({ href: "https://shop.example/", webdriver: true });
    dif.init({ publishableKey: KEY, userId: () => null, anonymous: true });
    dif.track("signup");
    assert.equal(elements()[0]!.wd, true);
  });

  it("warn about a $ name and are still sent", () => {
    dif.init({ publishableKey: KEY, userId: () => null, anonymous: true });
    dif.track("$anon_name");
    assert.equal(elements().length, 1);
    assert.equal(warnings.filter((w) => w.includes('"$anon_name"')).length, 1);
  });

  it("keep a user id's track on /v1/track", () => {
    dif.init({ publishableKey: KEY, userId: () => "u-1", anonymous: true });
    dif.track("signup");
    assert.equal(calls[0]!.url, "https://cloud.dif.sh/v1/track");
  });

  it("are dropped where no page URL exists", () => {
    browser!.uninstall();
    browser = null;
    dif.init({ publishableKey: KEY, userId: () => null, anonymous: true });
    dif.track("signup");
    assert.equal(calls.length, 0);
  });

  it("are dropped in custom mode", () => {
    let handled = 0;
    dif.init({
      userId: () => null,
      anonymous: true,
      events: { mode: "custom", exposure: () => {}, track: () => void handled++ },
    });
    dif.track("signup");
    assert.equal(handled, 0);
    assert.equal(calls.length, 0);
  });
});

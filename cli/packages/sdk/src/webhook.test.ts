import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { webhookSink } from "./sinks/webhook.js";
import type { ExposureEvent } from "./types.js";

const EVENT: ExposureEvent = {
  event: "dif.exposure",
  experiment: "exp",
  variant: "control",
  user_id: "u-1",
  surface: "home",
  bucket: 1234,
  fired_at: 1750000000000,
  source: "@dif.sh/sdk@test",
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("webhookSink", () => {
  it("POSTs the event JSON to the url", async () => {
    let url = "";
    let body = "";
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      url = String(input);
      body = String(init?.body);
      return new Response("{}", { status: 202 });
    }) as typeof fetch;

    webhookSink("https://events.example.com/dif").emit(EVENT);
    await Promise.resolve();

    assert.equal(url, "https://events.example.com/dif");
    assert.equal(JSON.parse(body).experiment, "exp");
  });

  it("swallows a rejected fetch — no throw, no unhandled rejection", async () => {
    let unhandled: unknown = null;
    const onUnhandled = (err: unknown) => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandled);
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;

    try {
      assert.doesNotThrow(() => webhookSink("https://x.example").emit(EVENT));
      // Give the rejection a chance to surface if it were unhandled.
      await new Promise((r) => setImmediate(r));
      assert.equal(unhandled, null, "fetch rejection must be swallowed by the sink");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("swallows a synchronous throw (fetch unavailable)", () => {
    globalThis.fetch = undefined as unknown as typeof fetch;
    assert.doesNotThrow(() => webhookSink("https://x.example").emit(EVENT));
  });
});

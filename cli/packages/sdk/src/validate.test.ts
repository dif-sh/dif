import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateElement, validateExposure, validateTrack } from "./validate.js";

const exposure = (over: Record<string, unknown> = {}) => ({
  event: "dif.exposure",
  event_id: "01933f2e-7c4a-7b3e-8f21-5d6a9c0e4b17",
  experiment: "checkout",
  variant: "control",
  user_id: "u-1",
  surface: "home",
  bucket: 42,
  fired_at: 1700000000000,
  source: "test",
  ...over,
});

const track = (over: Record<string, unknown> = {}) => ({
  event_id: "01933f2e-7c4a-7b3e-8f21-5d6a9c0e4b17",
  metric: "purchase",
  user_id: "u-1",
  fired_at: 1700000000000,
  source: "test",
  ...over,
});

/** Nest `n` objects, the innermost holding a leaf. */
function nested(n: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: 1 };
  for (let i = 1; i < n; i++) node = { a: node };
  return node;
}

describe("validateExposure", () => {
  it("accepts a good event", () => {
    assert.equal(validateExposure(exposure()), null);
  });

  it("accepts an ISO fired_at string", () => {
    assert.equal(validateExposure(exposure({ fired_at: "2026-10-14T10:00:00Z" })), null);
  });

  it("names the first failing check, in the handler's order", () => {
    assert.equal(validateExposure(exposure({ event: "x" })), 'event must be "dif.exposure"');
    assert.equal(validateExposure(exposure({ experiment: "" })), "experiment is required");
    assert.equal(validateExposure(exposure({ variant: 3 })), "variant is required");
    assert.equal(validateExposure(exposure({ user_id: undefined })), "user_id is required");
    assert.equal(validateExposure(exposure({ surface: null })), "surface is required");
    assert.equal(validateExposure(exposure({ bucket: "4" })), "bucket must be a number");
    assert.equal(validateExposure(exposure({ bucket: Number.NaN })), "bucket must be a number");
    assert.equal(
      validateExposure(exposure({ fired_at: "soon" })),
      "fired_at must be a Unix-ms number or ISO-8601 string",
    );
    assert.equal(
      validateExposure(exposure({ fired_at: undefined })),
      "fired_at must be a Unix-ms number or ISO-8601 string",
    );
  });

  it("rejects a fired_at beyond the range of Date", () => {
    assert.match(validateExposure(exposure({ fired_at: 8.64e15 + 1 })) ?? "", /fired_at/);
    assert.equal(validateExposure(exposure({ fired_at: 8.64e15 })), null);
    assert.match(validateExposure(exposure({ fired_at: -8.64e15 - 1 })) ?? "", /fired_at/);
  });

  it("rejects what is not an object", () => {
    assert.equal(validateExposure(null), 'event must be "dif.exposure"');
    assert.equal(validateExposure("x"), 'event must be "dif.exposure"');
  });

  it("rejects a string that is not valid Unicode", () => {
    assert.equal(
      validateExposure(exposure({ user_id: "a\ud800b" })),
      "user_id must be valid Unicode",
    );
    assert.equal(validateExposure(exposure({ user_id: "a😀b" })), null);
  });

  it("rejects a stored string that holds U+0000", () => {
    assert.equal(
      validateExposure(exposure({ user_id: "a\u0000b" })),
      "user_id must not contain U+0000",
    );
    assert.equal(
      validateExposure(exposure({ experiment: "\u0000" })),
      "experiment must not contain U+0000",
    );
    assert.equal(validateExposure(exposure({ source: "s\u0000" })), "source must not contain U+0000");
  });
});

describe("validateTrack", () => {
  it("accepts a good event", () => {
    assert.equal(validateTrack(track()), null);
    assert.equal(validateTrack(track({ value: 49, currency: "USD", props: { a: [1, 2] } })), null);
  });

  it("names the first failing check, in the handler's order", () => {
    assert.equal(validateTrack(track({ metric: "" })), "metric is required");
    assert.equal(validateTrack(track({ user_id: 7 })), "user_id is required");
    assert.equal(validateTrack(track({ value: "9" })), "value must be a finite number");
    assert.equal(validateTrack(track({ value: null })), "value must be a finite number");
    assert.equal(validateTrack(track({ value: Number.POSITIVE_INFINITY })), "value must be a finite number");
    assert.equal(validateTrack(null), "metric is required");
  });

  it("lets a missing or unreadable fired_at through", () => {
    assert.equal(validateTrack(track({ fired_at: undefined })), null);
    assert.equal(validateTrack(track({ fired_at: "soon" })), null);
  });

  it("rejects a fired_at number beyond the range of Date", () => {
    assert.match(validateTrack(track({ fired_at: 9e15 })) ?? "", /fired_at/);
    assert.equal(validateTrack(track({ fired_at: 8.64e15 })), null);
  });

  it("allows props nested 64 deep and rejects 65", () => {
    assert.equal(validateTrack(track({ props: nested(64) })), null);
    assert.equal(validateTrack(track({ props: nested(65) })), "props is nested more than 64 deep");
  });

  it("counts arrays in the nesting depth", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 65; i++) deep = [deep];
    assert.equal(validateTrack(track({ props: deep })), "props is nested more than 64 deep");
  });

  it("rejects props with a lone surrogate in a key or a value", () => {
    assert.equal(validateTrack(track({ props: { k: "a\udc00" } })), "props must be valid Unicode");
    assert.equal(validateTrack(track({ props: { "k\ud800": 1 } })), "props must be valid Unicode");
    assert.equal(validateTrack(track({ props: { k: "😀" } })), null);
  });

  it("rejects a stored field that is not valid Unicode", () => {
    assert.equal(validateTrack(track({ unit: "\ud800" })), "unit must be valid Unicode");
    assert.equal(validateTrack(track({ metric: "m\ud800" })), "metric must be valid Unicode");
  });

  it("rejects a stored string that holds U+0000", () => {
    assert.equal(validateTrack(track({ metric: "m\u0000" })), "metric must not contain U+0000");
    assert.equal(validateTrack(track({ user_id: "\u0000u" })), "user_id must not contain U+0000");
    assert.equal(validateTrack(track({ currency: "U\u0000D" })), "currency must not contain U+0000");
  });

  it("rejects props with U+0000 in a key or a value, at any depth", () => {
    const msg = "props must not contain U+0000";
    assert.equal(validateTrack(track({ props: { k: "a\u0000" } })), msg);
    assert.equal(validateTrack(track({ props: { "k\u0000": 1 } })), msg);
    assert.equal(validateTrack(track({ props: { a: { b: ["x", "y\u0000"] } } })), msg);
    assert.equal(validateTrack(track({ props: { a: { "b\u0000": true } } })), msg);
    assert.equal(validateTrack(track({ props: { k: "\\u0000" } })), null);
  });

  it("ignores props that are not an object", () => {
    assert.equal(validateTrack(track({ props: "\ud800" })), null);
  });
});

describe("validateElement", () => {
  const ID = "01933f2e-7c4a-7b3e-8f21-5d6a9c0e4b17";
  const page = (over: Record<string, unknown> = {}) => ({
    type: "page",
    event_id: ID,
    fired_at: 1700000000000,
    source: "test",
    url: "https://shop.example/",
    ...over,
  });
  const trackEl = (over: Record<string, unknown> = {}) => ({
    type: "track",
    event_id: ID,
    fired_at: 1700000000000,
    event: "signup",
    url: "https://shop.example/",
    ...over,
  });
  const identifyEl = (over: Record<string, unknown> = {}) => ({
    type: "identify",
    event_id: ID,
    fired_at: 1700000000000,
    user_id: "u-1",
    traits: {},
    ...over,
  });

  it("accepts good elements", () => {
    assert.equal(validateElement(page()), null);
    assert.equal(validateElement(page({ user_id: "u-1", props: { a: 1 } })), null);
    assert.equal(validateElement(trackEl({ value: 2 })), null);
    assert.equal(validateElement(identifyEl()), null);
  });

  it("refuses an unknown type", () => {
    assert.equal(validateElement(page({ type: "screen" })), 'unknown type "screen"');
  });

  it("needs an event_id that is a UUID", () => {
    assert.equal(validateElement(page({ event_id: undefined })), "event_id is required");
    assert.equal(validateElement(page({ event_id: "nope" })), "event_id is required");
  });

  it("needs a user_id that is a non-empty string when sent", () => {
    const msg = "user_id must be a non-empty string";
    assert.equal(validateElement(page({ user_id: "" })), msg);
    assert.equal(validateElement(page({ user_id: 7 })), msg);
    assert.equal(validateElement(page({ user_id: null })), null);
    assert.equal(validateElement(page({ user_id: "a\u0000b" })), "user_id must not contain U+0000");
    assert.equal(validateElement(identifyEl({ user_id: undefined })), "user_id is required");
  });

  it("needs a page url of at most 8,192 bytes", () => {
    assert.equal(validateElement(page({ url: "" })), "url is required");
    assert.equal(
      validateElement(page({ url: `https://a.example/${"a".repeat(8192)}` })),
      "url is over 8192 bytes",
    );
  });

  it("needs a track's event and a finite value", () => {
    assert.equal(validateElement(trackEl({ event: "" })), "event is required");
    assert.equal(validateElement(trackEl({ value: "3" })), "value must be a finite number");
  });

  it("needs an identify's traits object", () => {
    assert.equal(validateElement(identifyEl({ traits: [] })), "traits is required");
  });

  it("accepts U+0000 in props, which dif-db stores", () => {
    assert.equal(validateElement(page({ props: { "a\u0000": "b\u0000" } })), null);
    assert.equal(
      validateElement(page({ props: { a: "\u0000", b: "\udc00" } })),
      "props must be valid Unicode",
    );
  });

  it("refuses a fired_at out of range", () => {
    assert.match(validateElement(page({ fired_at: 9e15 })) ?? "", /fired_at/);
  });

  it("refuses unpaired surrogates and deep props", () => {
    assert.equal(validateElement(trackEl({ event: "a\ud800" })), "event must be valid Unicode");
    assert.equal(validateElement(trackEl({ unit: "\udc00" })), "unit must be valid Unicode");
    assert.equal(validateElement(page({ props: { a: "\udc00" } })), "props must be valid Unicode");
    assert.equal(
      validateElement(page({ props: nested(65) })),
      "props is nested more than 64 deep",
    );
    assert.equal(
      validateElement(identifyEl({ traits: { a: "\udc00" } })),
      "traits must be valid Unicode",
    );
  });
});

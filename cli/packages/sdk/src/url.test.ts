import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cleanPageUrl, cleanReferrer, KEPT_PARAMS } from "./url.js";

describe("cleanPageUrl", () => {
  it("drops the fragment", () => {
    assert.equal(cleanPageUrl("https://example.com/a#top"), "https://example.com/a");
  });

  it("keeps only the UTM params and ref, in their order", () => {
    assert.equal(
      cleanPageUrl(
        "https://example.com/p?token=abc&utm_campaign=spring&email=a%40b.c&ref=hn&utm_source=News",
      ),
      "https://example.com/p?utm_campaign=spring&ref=hn&utm_source=News",
    );
  });

  it("drops click ids", () => {
    assert.equal(
      cleanPageUrl("https://example.com/pricing/?utm_source=News&gclid=x&fbclid=y"),
      "https://example.com/pricing/?utm_source=News",
    );
  });

  it("removes the query mark when nothing is kept", () => {
    assert.equal(cleanPageUrl("https://example.com/?reset=t0k3n#x"), "https://example.com/");
  });

  it("keeps the bytes of a kept value as sent", () => {
    assert.equal(
      cleanPageUrl("https://example.com/?utm_term=a%20b+c&x=1"),
      "https://example.com/?utm_term=a%20b+c",
    );
  });

  it("matches a percent-encoded param name", () => {
    assert.equal(
      cleanPageUrl("https://example.com/?utm%5Fsource=x&q=1"),
      "https://example.com/?utm%5Fsource=x",
    );
  });

  it("drops a param name that is bad percent-encoding", () => {
    assert.equal(cleanPageUrl("https://example.com/?%E0%A4%A=1&ref=a"), "https://example.com/?ref=a");
  });

  it("drops user name and password", () => {
    assert.equal(cleanPageUrl("https://u:p@example.com/a"), "https://example.com/a");
  });

  it("resolves a relative URL against the base", () => {
    assert.equal(
      cleanPageUrl("/docs?utm_medium=email&id=4", "https://example.com/start?x=1"),
      "https://example.com/docs?utm_medium=email",
    );
  });

  it("refuses a scheme other than http(s)", () => {
    assert.equal(cleanPageUrl("file:///index.html"), null);
    assert.equal(cleanPageUrl("javascript:alert(1)"), null);
  });

  it("refuses text that is not a URL", () => {
    assert.equal(cleanPageUrl("not a url"), null);
    assert.equal(cleanPageUrl(""), null);
  });

  it("refuses a URL over 8,192 bytes after cleaning", () => {
    const base = "https://example.com/";
    const fits = base + "a".repeat(8192 - base.length);
    assert.equal(cleanPageUrl(fits), fits);
    assert.equal(cleanPageUrl(fits + "a"), null);
    assert.equal(cleanPageUrl(`${fits}?token=${"t".repeat(9000)}`), fits);
  });

  it("keeps the documented param list", () => {
    assert.deepEqual(
      [...KEPT_PARAMS],
      ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref"],
    );
  });
});

describe("cleanReferrer", () => {
  it("cleans a web referrer as a page URL", () => {
    assert.equal(
      cleanReferrer("https://news.ycombinator.com/item?id=1#c"),
      "https://news.ycombinator.com/item",
    );
  });

  it("keeps an android-app referrer", () => {
    assert.equal(
      cleanReferrer("android-app://com.google.android.gm/"),
      "android-app://com.google.android.gm/",
    );
  });

  it("gives null for an empty or hostless referrer", () => {
    assert.equal(cleanReferrer(""), null);
    assert.equal(cleanReferrer("about:blank"), null);
    assert.equal(cleanReferrer("nonsense"), null);
  });
});

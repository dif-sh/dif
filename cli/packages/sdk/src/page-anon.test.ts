import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { dif, __reset } from "./index.js";
import { setElementSink, type BatchElement } from "./elements.js";
import { installBrowser, type FakeBrowser } from "./fake-browser.test.js";

const KEY = "dif_pk_live_aaaaaaaa_secret-secret-secret";

let sent: BatchElement[] = [];
let browser: FakeBrowser | null = null;

beforeEach(() => {
  __reset();
  sent = [];
  setElementSink((e) => sent.push(e));
  browser = installBrowser({ href: "https://shop.example/" });
});

afterEach(() => {
  browser?.uninstall();
  browser = null;
  __reset();
});

describe("page views with a minted id", () => {
  it("marks the page view anon when the resolver gives an app-minted id", () => {
    dif.init({ publishableKey: KEY, userId: () => "cookie-1", anonymousUserId: true });
    dif.page();
    assert.equal(sent[0]!.type, "page");
    assert.equal((sent[0] as { anon?: boolean }).anon, true);
    assert.equal((sent[0] as { user_id?: string }).user_id, "cookie-1");
  });

  it("marks automatic page views anon", () => {
    dif.init({
      publishableKey: KEY,
      userId: () => "cookie-1",
      anonymousUserId: true,
      pageViews: "auto",
    });
    assert.equal((sent[0] as { anon?: boolean }).anon, true);
  });

  it("does not mark a page view anon without the option", () => {
    dif.init({ publishableKey: KEY, userId: () => "u-1" });
    dif.page();
    assert.equal("anon" in sent[0]!, false);
  });

  it("does not mark anon after identify gives a real id", () => {
    dif.init({ publishableKey: KEY, userId: () => "cookie-1", anonymousUserId: true });
    dif.identify("user-9");
    dif.page();
    assert.equal((sent[0] as { user_id?: string }).user_id, "user-9");
    assert.equal("anon" in sent[0]!, false);
  });

  it("does not mark anon when the call names its own user", () => {
    dif.init({ publishableKey: KEY, userId: () => "cookie-1", anonymousUserId: true });
    dif.page({ userId: "user-3" });
    assert.equal("anon" in sent[0]!, false);
  });

  it("lets a call set anon itself", () => {
    dif.init({ publishableKey: KEY, userId: () => "u-1" });
    dif.page({ anon: true });
    assert.equal((sent[0] as { anon?: boolean }).anon, true);
  });

  it("sends no anon when there is no user id", () => {
    dif.init({ publishableKey: KEY, userId: () => null, anonymousUserId: true });
    dif.page();
    assert.equal("anon" in sent[0]!, false);
  });
});

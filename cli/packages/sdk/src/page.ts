// `dif.page()`: one page view, as one `page` element.

import { getState } from "./config.js";
import { handOff, type PageElement } from "./elements.js";
import { uuidv7 } from "./event-id.js";
import { cleanPageUrl, cleanReferrer } from "./url.js";
import {
  currentHref,
  documentReferrer,
  language,
  screenSize,
  webdriver,
} from "./stamp.js";
import { SOURCE } from "./version.js";

/** Options of a `dif.page()` call. */
export interface PageOptions {
  /** Defaults to `location.href`. Relative URLs resolve against it. */
  url?: string;
  /** Defaults to `document.referrer`. */
  referrer?: string;
  /** Overrides the configured userId resolver for this call. */
  userId?: string;
  /** Unix milliseconds. Defaults to now. */
  firedAt?: number;
  props?: Record<string, unknown>;
}

/** Sends one page view. Gives true when an element left. */
export function sendPage(opts: PageOptions = {}): boolean {
  const state = getState();
  if (!state || state.enabled === false) return false;

  const here = currentHref();
  const href = opts.url ?? here;
  // The collector refuses a page element without an http(s) url.
  const url = href === null ? null : cleanPageUrl(href, here ?? undefined);
  if (url === null) return false;
  const rawReferrer = opts.referrer ?? documentReferrer();
  const referrer = rawReferrer ? cleanReferrer(rawReferrer) : null;
  const userId = opts.userId ?? state.userId();
  const screen = screenSize();
  const lang = language();

  const element: PageElement = {
    type: "page",
    event_id: uuidv7(),
    fired_at: opts.firedAt ?? Date.now(),
    source: SOURCE,
    ...(userId ? { user_id: userId } : {}),
    url,
    ...(referrer !== null && { referrer }),
    ...(screen !== null && { screen }),
    ...(lang !== null && { lang }),
    ...(webdriver() && { wd: true as const }),
    ...(opts.props !== undefined && { props: opts.props }),
  };
  handOff(element);
  return true;
}

export function page(opts?: PageOptions): void {
  sendPage(opts);
}

// Elements of /v1/batch leave the SDK through one sink.
// Cloud mode sets the batch queue. Else elements stop here.

/** A `page` element of `/v1/batch`. */
export interface PageElement {
  type: "page";
  /** A lowercase UUIDv7. The collector stores a re-sent element once. */
  event_id: string;
  /** Unix milliseconds. */
  fired_at: number;
  source: string;
  /** Absent: the collector gives the visitor id. */
  user_id?: string;
  /** Cleaned: no fragment, and only the kept query params. */
  url: string;
  referrer?: string;
  /** `screen.width` x `screen.height`, as `"1440x900"`. */
  screen?: string;
  lang?: string;
  /** Sent only when `navigator.webdriver` is true. */
  wd?: true;
  props?: Record<string, unknown>;
}

/** An `identify` element of `/v1/batch`. Sent only with traits. */
export interface IdentifyElement {
  type: "identify";
  event_id: string;
  fired_at: number;
  source: string;
  user_id: string;
  traits: Record<string, unknown>;
}

/** A `track` element of `/v1/batch`: a track with no user id. */
export interface TrackElement {
  type: "track";
  event_id: string;
  fired_at: number;
  source: string;
  /** The track's name. */
  event: string;
  value?: number;
  currency?: string;
  unit?: string;
  idempotency_key?: string;
  /** The page, cleaned as a page element's `url`. */
  url: string;
  referrer?: string;
  /** Sent only when `navigator.webdriver` is true. */
  wd?: true;
  props?: Record<string, unknown>;
}

export type BatchElement = PageElement | IdentifyElement | TrackElement;

export type ElementSink = (element: BatchElement) => void;

let sink: ElementSink | null = null;
let tap: ElementSink | null = null;

/** Sets where elements go. Null drops them. */
export function setElementSink(next: ElementSink | null): void {
  sink = next;
}

/** Test-only. Elements go to `fn`, not to the sink. */
export function __tapElements(fn: ElementSink | null): void {
  tap = fn;
}

/** Hands one element on. It never throws. */
export function handOff(element: BatchElement): void {
  try {
    (tap ?? sink)?.(element);
  } catch {
    // Analytics must not break the page.
  }
}

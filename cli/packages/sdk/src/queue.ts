// One queue sends events to one endpoint.
// It also checks, splits, retries and flushes on hide.

/** Keeps a keepalive fetch inside the 64 KiB browser quota. */
export const MAX_BODY_BYTES = 60_000;

/** Most retries for one batch: one send plus three retries. */
export const MAX_RETRIES = 3;

/** The handlers accept at most 500 events in one request. */
const MAX_EVENTS_PER_REQUEST = 500;

const MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 1000;
/** Drop warnings shown, for all queues together. */
const MAX_INVALID_WARNINGS = 20;

export interface QueueOptions {
  url: string;
  headers: Record<string, string>;
  /** Names the events in console warnings. */
  label: string;
  /** Gives a message for a bad event, else null. */
  validate: (parsed: unknown) => string | null;
  /** Flush at this many events. 1 sends each at once. */
  maxEvents: number;
  /** Flush this long after the first queued event. */
  intervalMs: number;
  keepalive: boolean;
  /** Flush on pagehide and when the page turns hidden. */
  lifecycle: boolean;
  /** Called once for each lost batch. */
  onGiveUp: (status: number | null, events: number) => void;
  retryBaseMs?: number;
}

interface Item {
  body: string;
  bytes: number;
  settled: boolean;
  promise: Promise<boolean>;
  ack: (ok: boolean) => void;
}

interface Batch {
  items: Item[];
  body: string;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: boolean;
  finished: boolean;
  /** Sent during a hide, so it is already a flush. */
  sentHidden: boolean;
  shadowed: boolean;
}

interface Outcome {
  ok: boolean;
  status: number | null;
  retryAfterMs: number | undefined;
  res: Response | null;
}

/** Bytes in the UTF-8 form, counted without making it. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Reads Retry-After, in seconds or as a date. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  if (/^-/.test(v)) return undefined;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

// The wait before a retry. Attempt counts from 1.
// Jitter keeps half to all of the wait.
export function retryDelay(
  attempt: number,
  baseMs: number,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
): number {
  const jittered = baseMs * 2 ** (attempt - 1) * (0.5 + random() * 0.5);
  if (retryAfterMs === undefined) return jittered;
  return Math.max(jittered, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
}

function retryable(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

let invalidWarnings = 0;

function warnDropped(label: string, why: string): void {
  if (typeof console === "undefined" || invalidWarnings > MAX_INVALID_WARNINGS) return;
  invalidWarnings++;
  console.warn(
    invalidWarnings > MAX_INVALID_WARNINGS
      ? "[dif] further dropped events get no warning."
      : `[dif] dropped a ${label} event: ${why}`,
  );
}

// Every queue that flushes on page hide.
const lifecycleQueues = new Set<EventQueue>();
let hidden = false;
let removeListeners: (() => void) | null = null;

interface Target {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

function target(name: "window" | "document"): Target | null {
  const t = (globalThis as Record<string, unknown>)[name] as Partial<Target> | undefined;
  return t && typeof t.addEventListener === "function" && typeof t.removeEventListener === "function"
    ? (t as Target)
    : null;
}

function documentHidden(): boolean {
  const d = (globalThis as { document?: { visibilityState?: string } }).document;
  return d?.visibilityState === "hidden";
}

function isPageHidden(): boolean {
  return hidden || documentHidden();
}

/** True when the page can tell us it is closing. */
export function canObservePageHide(): boolean {
  return target("window") !== null;
}

function installListeners(): void {
  if (removeListeners) return;
  const win = target("window");
  if (!win) return;
  const doc = target("document");
  const onHide = () => {
    hidden = true;
    const queues = [...lifecycleQueues];
    for (const q of queues) q.hide();
    for (const q of queues) q.shadowInflight();
  };
  const onShow = () => {
    hidden = false;
  };
  const onVisibility = () => (documentHidden() ? onHide() : onShow());
  win.addEventListener("pagehide", onHide);
  win.addEventListener("pageshow", onShow);
  doc?.addEventListener("visibilitychange", onVisibility);
  removeListeners = () => {
    win.removeEventListener("pagehide", onHide);
    win.removeEventListener("pageshow", onShow);
    doc?.removeEventListener("visibilitychange", onVisibility);
    hidden = false;
  };
}

function uninstallListeners(): void {
  removeListeners?.();
  removeListeners = null;
}

export class EventQueue {
  private pending: Item[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly live = new Set<Batch>();
  private closed = false;

  constructor(private readonly opts: QueueOptions) {
    if (opts.lifecycle) {
      lifecycleQueues.add(this);
      installListeners();
    }
  }

  // Resolves true after a 2xx for its request.
  // Resolves false if the event is dropped or lost.
  add(event: unknown): Promise<boolean> {
    const item = this.prepare(event);
    if (!item) return Promise.resolve(false);
    this.pending.push(item);
    if (this.closed || this.pending.length >= this.opts.maxEvents || isPageHidden()) {
      this.drain();
    } else if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, this.opts.intervalMs);
    }
    return item.promise;
  }

  /** Sends the queue. Resolves when each event is settled. */
  flush(): Promise<void> {
    this.drain();
    return this.settled();
  }

  /** Flush, stop listening, and send later events at once. */
  close(): Promise<void> {
    this.closed = true;
    lifecycleQueues.delete(this);
    if (lifecycleQueues.size === 0) uninstallListeners();
    return this.flush();
  }

  /** The page is hiding: send what is not sent yet. */
  hide(): void {
    this.drain();
    for (const batch of [...this.live]) {
      if (!batch.inflight && batch.timer !== null) {
        clearTimeout(batch.timer);
        batch.timer = null;
        this.send(batch);
      }
    }
  }

  // Run after hide() on every queue.
  // A copy uses shared quota, so unsent batches go first.
  shadowInflight(): void {
    if (this.opts.keepalive) return;
    for (const batch of [...this.live]) {
      if (batch.inflight && !batch.sentHidden && !batch.shadowed) {
        batch.shadowed = true;
        void this.shadow(batch);
      }
    }
  }

  private settled(): Promise<void> {
    const promises: Promise<boolean>[] = [];
    for (const batch of this.live) for (const item of batch.items) promises.push(item.promise);
    return Promise.all(promises).then(() => undefined);
  }

  private prepare(event: unknown): Item | null {
    const { label } = this.opts;
    let body: string | undefined;
    let parsed: unknown;
    try {
      body = JSON.stringify(event);
      if (typeof body === "string") parsed = JSON.parse(body);
    } catch {
      warnDropped(label, "it cannot be turned into JSON");
      return null;
    }
    if (typeof body !== "string") {
      warnDropped(label, "it cannot be turned into JSON");
      return null;
    }
    const problem = this.opts.validate(parsed);
    if (problem) {
      warnDropped(label, problem);
      return null;
    }
    const bytes = utf8Length(body);
    if (bytes + 2 > MAX_BODY_BYTES) {
      warnDropped(label, "it is larger than 60 KB");
      return null;
    }
    let ack: (ok: boolean) => void = () => {};
    const promise = new Promise<boolean>((resolve) => {
      ack = resolve;
    });
    const item: Item = {
      body,
      bytes,
      settled: false,
      promise,
      ack: (ok) => {
        if (item.settled) return;
        item.settled = true;
        ack(ok);
      },
    };
    return item;
  }

  private drain(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const items = this.pending;
    this.pending = [];
    this.dispatch(items);
  }

  /** Make batches of at most 60 KB and 500 events. */
  private dispatch(items: Item[]): void {
    let chunk: Item[] = [];
    let bytes = 2;
    for (const item of items) {
      const next = bytes + item.bytes + (chunk.length > 0 ? 1 : 0);
      if (chunk.length > 0 && (next > MAX_BODY_BYTES || chunk.length >= MAX_EVENTS_PER_REQUEST)) {
        this.send(this.newBatch(chunk));
        chunk = [];
        bytes = 2;
      }
      bytes += item.bytes + (chunk.length > 0 ? 1 : 0);
      chunk.push(item);
    }
    if (chunk.length > 0) this.send(this.newBatch(chunk));
  }

  private newBatch(items: Item[]): Batch {
    return {
      items,
      body: `[${items.map((i) => i.body).join(",")}]`,
      attempts: 0,
      timer: null,
      inflight: false,
      finished: false,
      sentHidden: false,
      shadowed: false,
    };
  }

  private send(batch: Batch): void {
    batch.attempts++;
    batch.inflight = true;
    batch.sentHidden = batch.sentHidden || isPageHidden();
    this.live.add(batch);
    this.request(batch)
      .then((out) => this.after(batch, out))
      .catch(() => this.finish(batch, false));
  }

  private async request(batch: Batch, keepalive = this.opts.keepalive): Promise<Outcome> {
    try {
      const res = await fetch(this.opts.url, {
        method: "POST",
        headers: this.opts.headers,
        body: batch.body,
        ...(keepalive && { keepalive: true }),
      });
      const retryAfter = parseRetryAfter(res.headers?.get?.("retry-after") ?? null, Date.now());
      return { ok: res.ok, status: res.status, retryAfterMs: retryAfter, res };
    } catch {
      return { ok: false, status: null, retryAfterMs: undefined, res: null };
    }
  }

  // A request without keepalive can fail unseen after unload.
  private async shadow(batch: Batch): Promise<void> {
    const out = await this.request(batch, true);
    if (out.ok) this.finish(batch, true);
  }

  private async after(batch: Batch, out: Outcome): Promise<void> {
    if (batch.finished) return;
    batch.inflight = false;
    if (out.ok) return this.finish(batch, true);
    if (retryable(out.status) && batch.attempts <= MAX_RETRIES) {
      const wait = retryDelay(
        batch.attempts,
        this.opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
        out.retryAfterMs,
      );
      batch.timer = setTimeout(() => {
        batch.timer = null;
        this.send(batch);
      }, wait);
      return;
    }
    if (out.status === 400 && batch.items.length > 1 && out.res) {
      return this.isolate(batch, out.res);
    }
    this.opts.onGiveUp(out.status, batch.items.length);
    this.finish(batch, false);
  }

  // A 400 may name the bad event. Else split.
  private async isolate(batch: Batch, res: Response): Promise<void> {
    let text = "";
    try {
      text = await res.text();
    } catch {
      // Without the message the batch is split.
    }
    if (batch.finished) return;
    this.release(batch);
    const named = /event\[(\d+)\]:\s*([^"\\]*)/.exec(text);
    const index = named ? Number(named[1]) : -1;
    const bad = batch.items[index];
    if (bad && named) {
      warnDropped(this.opts.label, `the server refused it: ${named[2]}`);
      bad.ack(false);
      this.dispatch(batch.items.filter((i) => i !== bad));
      return;
    }
    const half = Math.ceil(batch.items.length / 2);
    this.dispatch(batch.items.slice(0, half));
    this.dispatch(batch.items.slice(half));
  }

  private release(batch: Batch): void {
    batch.finished = true;
    this.live.delete(batch);
    if (batch.timer !== null) clearTimeout(batch.timer);
    batch.timer = null;
  }

  private finish(batch: Batch, ok: boolean): void {
    this.release(batch);
    for (const item of batch.items) item.ack(ok);
  }
}

/** Test-only: close every queue and forget warnings. */
export function __resetQueues(): void {
  for (const q of [...lifecycleQueues]) void q.close();
  lifecycleQueues.clear();
  uninstallListeners();
  invalidWarnings = 0;
}

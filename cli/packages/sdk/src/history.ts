// Calls back on SPA navigation: pushState, replaceState and popstate.
// The history methods are wrapped once per page.

type Callback = () => void;
type Method = "pushState" | "replaceState";
type HistoryFn = (data: unknown, unused: string, url?: string | URL | null) => void;

interface NavGlobals {
  history?: Record<Method, HistoryFn>;
  addEventListener?: (type: string, fn: Callback) => void;
  removeEventListener?: (type: string, fn: Callback) => void;
}

const callbacks = new Set<Callback>();
let originals: Record<Method, HistoryFn> | null = null;
let wrappers: Record<Method, HistoryFn> | null = null;

function notify(): void {
  for (const fn of [...callbacks]) {
    try {
      fn();
    } catch {
      // Analytics must not break navigation.
    }
  }
}

function wrap(g: NavGlobals, h: Record<Method, HistoryFn>): void {
  const orig = { pushState: h.pushState, replaceState: h.replaceState };
  const make = (name: Method): HistoryFn =>
    function (this: unknown, ...args: Parameters<HistoryFn>) {
      const result = orig[name].apply(this, args);
      notify();
      return result;
    };
  wrappers = { pushState: make("pushState"), replaceState: make("replaceState") };
  originals = orig;
  h.pushState = wrappers.pushState;
  h.replaceState = wrappers.replaceState;
  g.addEventListener?.("popstate", notify);
}

/** Calls `fn` after each navigation. Gives the unsubscribe. */
export function onNavigate(fn: Callback): () => void {
  const g = globalThis as NavGlobals;
  const h = g.history;
  if (!h || typeof h.pushState !== "function") return () => {};
  if (!wrappers) wrap(g, h);
  callbacks.add(fn);
  return () => {
    callbacks.delete(fn);
  };
}

/** Test-only. */
export function __resetHistory(): void {
  const g = globalThis as NavGlobals;
  const h = g.history;
  if (h && originals && wrappers) {
    // Another script can wrap after us. Then its wrapper stays.
    if (h.pushState === wrappers.pushState) h.pushState = originals.pushState;
    if (h.replaceState === wrappers.replaceState) h.replaceState = originals.replaceState;
    g.removeEventListener?.("popstate", notify);
  }
  originals = null;
  wrappers = null;
  callbacks.clear();
}

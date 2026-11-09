// A small browser for tests: location, history, document, screen and navigator.
// It holds no tests. The name keeps it out of the build.

type Listener = (event: { type: string }) => void;

export interface BrowserOptions {
  href: string;
  referrer?: string;
  screen?: { width: number; height: number };
  language?: string;
  webdriver?: boolean;
}

export interface FakeBrowser {
  location: { href: string };
  history: {
    pushState(data: unknown, unused: string, url?: string | URL | null): void;
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  };
  /** Calls to the original history methods, by name. */
  calls: string[];
  /** Moves to `href` as the back button does. */
  pop(href: string): void;
  uninstall(): void;
}

const NAMES = ["location", "history", "document", "screen", "navigator", "addEventListener",
  "removeEventListener", "__difSite"] as const;

export function installBrowser(opts: BrowserOptions): FakeBrowser {
  const g = globalThis as Record<string, unknown>;
  const saved = NAMES.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)] as const);
  const listeners = new Map<string, Set<Listener>>();
  const location = { href: opts.href };
  const calls: string[] = [];
  const move = (url?: string | URL | null) => {
    if (url !== undefined && url !== null) location.href = new URL(String(url), location.href).href;
  };
  const history = {
    pushState(_data: unknown, _unused: string, url?: string | URL | null) {
      calls.push("pushState");
      move(url);
    },
    replaceState(_data: unknown, _unused: string, url?: string | URL | null) {
      calls.push("replaceState");
      move(url);
    },
  };
  const set = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  set("location", location);
  set("history", history);
  set("document", { referrer: opts.referrer ?? "" });
  set("screen", opts.screen ?? { width: 1440, height: 900 });
  set("navigator", { language: opts.language ?? "en-GB", webdriver: opts.webdriver ?? false });
  set("addEventListener", (type: string, fn: Listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
  });
  set("removeEventListener", (type: string, fn: Listener) => {
    listeners.get(type)?.delete(fn);
  });
  return {
    location,
    history,
    calls,
    pop(href: string) {
      location.href = href;
      for (const fn of listeners.get("popstate") ?? []) fn({ type: "popstate" });
    },
    uninstall() {
      for (const [name, desc] of saved) {
        if (desc) Object.defineProperty(globalThis, name, desc);
        else delete g[name];
      }
    },
  };
}

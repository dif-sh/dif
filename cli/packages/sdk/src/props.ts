// The cleaning rules of dif-db's props::clean, in TypeScript.
// A test runs dif-db's shared vectors, so a drift fails here.

import { LIMITS } from "./limits.js";

export type CleanValue = string | number | boolean;

export interface Dropped {
  key: string;
  why: string;
}

export interface CleanProps {
  /** Stored props as [key, value], in byte order of the key. */
  props: [string, CleanValue][];
  /** Dropped keys, in byte order of the key. */
  dropped: Dropped[];
}

const WHY = {
  deep: `nested more than ${LIMITS.flatten_levels} level deep`,
  twice: "key given twice by flattening",
  empty: "empty key",
  long: `key over ${LIMITS.key_bytes_max} bytes`,
  dollar: "key starts with $",
  control: "key has a control character",
  string: `string over ${LIMITS.string_bytes_max} bytes`,
  finite: "number not finite",
  many: `over ${LIMITS.keys_per_event} keys`,
  big: `props over ${LIMITS.stored_props_bytes_max} bytes`,
};

const encoder = new TextEncoder();
const byteLength = (s: string): number => encoder.encode(s).length;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// JSON drops these, so they are absent as null is.
function isAbsent(v: unknown): boolean {
  return (
    v === null ||
    Array.isArray(v) ||
    v === undefined ||
    typeof v === "function" ||
    typeof v === "symbol" ||
    typeof v === "bigint"
  );
}

/** Byte order of UTF-8 is the order of code points. */
function compareKeys(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

function keyFault(k: string): string | null {
  const bytes = byteLength(k);
  if (bytes < LIMITS.key_bytes_min) return WHY.empty;
  if (bytes > LIMITS.key_bytes_max) return WHY.long;
  if (k.startsWith("$")) return WHY.dollar;
  if (/[\u0000-\u001f]/.test(k)) return WHY.control;
  return null;
}

function valueFault(v: unknown): string | null {
  if (typeof v === "string") return byteLength(v) > LIMITS.string_bytes_max ? WHY.string : null;
  if (typeof v === "number") return Number.isFinite(v) ? null : WHY.finite;
  if (typeof v === "boolean") return null;
  return WHY.deep;
}

// -0 is written as -0, so that its sign survives in dif-db.
function entryBytes(k: string, v: CleanValue): number {
  const value = Object.is(v, -0) ? "-0" : JSON.stringify(v);
  return byteLength(JSON.stringify(k)) + 1 + byteLength(value);
}

/** Applies dif-db's per-event rules to an event's props. */
export function cleanProps(props: unknown): CleanProps {
  const out: CleanProps = { props: [], dropped: [] };
  if (!isObject(props)) return out;

  const found = new Map<string, { sources: number; value: unknown }>();
  const add = (key: string, value: unknown) => {
    const e = found.get(key);
    if (e) {
      e.sources++;
      e.value = value;
    } else {
      found.set(key, { sources: 1, value });
    }
  };
  for (const [k, v] of Object.entries(props)) {
    if (isAbsent(v)) continue;
    if (!isObject(v)) {
      add(k, v);
      continue;
    }
    for (const [k2, v2] of Object.entries(v)) {
      if (!isAbsent(v2)) add(`${k}.${k2}`, v2);
    }
  }

  const kept: [string, CleanValue][] = [];
  for (const key of [...found.keys()].sort(compareKeys)) {
    const { sources, value } = found.get(key)!;
    const why = keyFault(key) ?? (sources > 1 ? WHY.twice : valueFault(value));
    if (why) out.dropped.push({ key, why });
    else kept.push([key, value as CleanValue]);
  }

  const past: Dropped[] = kept
    .splice(LIMITS.keys_per_event)
    .map(([key]) => ({ key, why: WHY.many }));
  let bytes = 2;
  let fits = kept.length;
  for (let i = 0; i < kept.length; i++) {
    bytes += entryBytes(kept[i]![0], kept[i]![1]) + (i > 0 ? 1 : 0);
    if (bytes > LIMITS.stored_props_bytes_max) {
      fits = i;
      break;
    }
  }
  for (const [key] of kept.splice(fits)) past.push({ key, why: WHY.big });
  out.props = kept;
  if (past.length > 0) {
    out.dropped.push(...past);
    out.dropped.sort((a, b) => compareKeys(a.key, b.key));
  }
  return out;
}

// A page can make many keys, so the set has a cap.
const MAX_WARNED = 1000;
const warned = new Set<string>();

/** Test-only. */
export function __resetPropWarnings(): void {
  warned.clear();
}

function warnOnce(id: string, message: string): void {
  if (warned.has(id) || warned.size >= MAX_WARNED) return;
  warned.add(id);
  if (typeof console !== "undefined") console.warn(message);
}

function warnDropped(dropped: Dropped[]): void {
  for (const { key, why } of dropped) {
    warnOnce(`prop:${key}`, `[dif] prop "${key}" is dropped: ${why}`);
  }
}

/** Warns once per key that dif-db drops. The event is still sent. */
export function warnProps(props: unknown): void {
  try {
    warnDropped(cleanProps(props).dropped);
  } catch {
    // A getter that throws must not stop the event.
  }
}

/**
 * The props dif-db stores, as an object. Warns as `warnProps` does.
 * Null when reading the props throws.
 */
export function storedProps(props: unknown): Record<string, CleanValue> | null {
  try {
    const clean = cleanProps(props);
    warnDropped(clean.dropped);
    return Object.fromEntries(clean.props);
  } catch {
    return null;
  }
}

/** Warns once about a name that starts with $. */
export function warnName(kind: string, name: unknown): void {
  if (typeof name !== "string" || !name.startsWith("$")) return;
  warnOnce(
    `name:${kind}:${name}`,
    `[dif] ${kind} name "${name}" starts with $, which dif reserves for itself`,
  );
}

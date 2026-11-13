// Copies of the cloud handlers' rules, run before queueing.
// A bad event then drops alone, not with its batch.

import { warnName, warnProps } from "./props.js";
import { utf8Length } from "./queue.js";
import { MAX_URL_BYTES } from "./url.js";

/** The most ms from the epoch that Date holds. */
const MAX_TIME_MS = 8.64e15;

/** Props nest this deep at most. Props is level 1. */
const PROPS_DEPTH = 64;

const FIRED_AT_ERROR = "fired_at must be a Unix-ms number or ISO-8601 string";

type Fields = Record<string, unknown>;

function fieldsOf(v: unknown): Fields {
  return v !== null && typeof v === "object" ? (v as Fields) : {};
}

function isText(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** True when a surrogate has no partner. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// Postgres text and jsonb refuse U+0000.
/** The rule a string breaks, else null. */
function textFault(s: string): "lone" | "nul" | null {
  if (s.includes("\u0000")) return "nul";
  return hasLoneSurrogate(s) ? "lone" : null;
}

/** First stored field with a bad character, else null. */
function badText(f: Fields, names: readonly string[]): string | null {
  for (const name of names) {
    const v = f[name];
    if (typeof v !== "string") continue;
    const fault = textFault(v);
    if (fault === "lone") return `${name} must be valid Unicode`;
    if (fault === "nul") return `${name} must not contain U+0000`;
  }
  return null;
}

// dif-db stores U+0000 in props. Postgres does not.
function propsFault(
  v: unknown,
  depth: number,
  nulOk = false,
): "lone" | "nul" | "deep" | null {
  const text = (s: string) => (nulOk ? (hasLoneSurrogate(s) ? "lone" : null) : textFault(s));
  if (typeof v === "string") return text(v);
  if (v === null || typeof v !== "object") return null;
  if (depth > PROPS_DEPTH) return "deep";
  if (Array.isArray(v)) {
    for (const item of v) {
      const fault = propsFault(item, depth + 1, nulOk);
      if (fault) return fault;
    }
    return null;
  }
  for (const [key, item] of Object.entries(v as Fields)) {
    const keyFault = text(key);
    if (keyFault) return keyFault;
    const fault = propsFault(item, depth + 1, nulOk);
    if (fault) return fault;
  }
  return null;
}

/** The handler reads fired_at as a number or date. */
function exposureTimeOk(v: unknown): boolean {
  if (isFiniteNumber(v)) return Math.abs(v) <= MAX_TIME_MS;
  if (typeof v === "string") return Number.isFinite(new Date(v).getTime());
  return false;
}

/** Takes the parsed body. Gives a message, or null. */
export function validateExposure(raw: unknown): string | null {
  const e = fieldsOf(raw);
  if (e.event !== "dif.exposure") return 'event must be "dif.exposure"';
  if (!isText(e.experiment)) return "experiment is required";
  if (!isText(e.variant)) return "variant is required";
  if (!isText(e.user_id)) return "user_id is required";
  if (!isText(e.surface)) return "surface is required";
  if (!isFiniteNumber(e.bucket)) return "bucket must be a number";
  if (!exposureTimeOk(e.fired_at)) return FIRED_AT_ERROR;
  return badText(e, ["experiment", "variant", "user_id", "surface", "source", "idempotency_key"]);
}

// A bad fired_at passes: the handler uses the time now.
/** Takes the parsed body. Gives a message, or null. */
export function validateTrack(raw: unknown): string | null {
  const e = fieldsOf(raw);
  if (!isText(e.metric)) return "metric is required";
  if (!isText(e.user_id)) return "user_id is required";
  if (e.value !== undefined && !isFiniteNumber(e.value)) return "value must be a finite number";
  if (isFiniteNumber(e.fired_at) && Math.abs(e.fired_at) > MAX_TIME_MS) return FIRED_AT_ERROR;
  const text = badText(e, [
    "metric",
    "user_id",
    "currency",
    "unit",
    "source",
    "idempotency_key",
  ]);
  if (text) return text;
  if (e.props !== null && typeof e.props === "object") {
    const fault = propsFault(e.props, 1);
    if (fault === "lone") return "props must be valid Unicode";
    if (fault === "nul") return "props must not contain U+0000";
    if (fault === "deep") return `props is nested more than ${PROPS_DEPTH} deep`;
  }
  warnName("track", e.metric);
  warnProps(e.props);
  return null;
}

const ELEMENT_TYPES: readonly string[] = ["track", "page", "identify"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObject(v: unknown): v is Fields {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// The rules of dif-db's `/v1/batch` parser that give a 400.
// Bad text there fails only after the other rules.
/** Takes a parsed `/v1/batch` element. Gives a message, or null. */
export function validateElement(raw: unknown): string | null {
  const e = fieldsOf(raw);
  if (e.type === undefined || e.type === null) return "type is required";
  if (typeof e.type !== "string") return 'unknown type "<not a string>"';
  if (!ELEMENT_TYPES.includes(e.type)) return `unknown type "${e.type.slice(0, 64)}"`;
  const { type } = e;

  if (type === "track" && !isText(e.event)) return "event is required";
  if (e.user_id !== undefined && e.user_id !== null) {
    if (!isText(e.user_id)) return "user_id must be a non-empty string";
    if (e.user_id.includes("\u0000")) return "user_id must not contain U+0000";
  } else if (type === "identify") {
    return "user_id is required";
  }
  const url = type === "identify" || !isText(e.url) ? null : e.url;
  if (type === "page" && url === null) return "url is required";
  if (url !== null && utf8Length(url) > MAX_URL_BYTES) return `url is over ${MAX_URL_BYTES} bytes`;
  if (typeof e.event_id !== "string" || !UUID.test(e.event_id)) return "event_id is required";

  const what = type === "identify" ? "traits" : "props";
  const tree = e[what];
  if (type === "identify" && !isObject(tree)) return "traits is required";
  const fault = tree !== null && typeof tree === "object" ? propsFault(tree, 1, true) : null;
  if (fault === "deep") return `${what} is nested more than ${PROPS_DEPTH} deep`;
  if (type === "track" && e.value !== undefined && !isFiniteNumber(e.value)) {
    return "value must be a finite number";
  }
  if (isFiniteNumber(e.fired_at) && Math.abs(e.fired_at) > MAX_TIME_MS) return FIRED_AT_ERROR;

  for (const name of ["event", "user_id", "currency", "unit", "idempotency_key"]) {
    const v = e[name];
    if (typeof v === "string" && hasLoneSurrogate(v)) return `${name} must be valid Unicode`;
  }
  if (fault === "lone") return `${what} must be valid Unicode`;
  if (type === "track") warnName("track", e.event);
  return null;
}

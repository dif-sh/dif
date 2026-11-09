// Each exposure and track gets one UUIDv7 id.
// The collector stores a re-sent event once.

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(out);
  } else {
    // Only old runtimes lack crypto. These ids are guessable.
    // Unique is enough: a copy must match user, name and time.
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

/** A UUIDv7 in lowercase canonical form. `now` is unix milliseconds. */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  // Divide, do not shift. JS shifts use 32 bits.
  let t = Math.floor(now);
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  // The tracking script has a size limit, so this is short.
  const h = Array.from(b, (x) => (x + 256).toString(16).slice(1)).join("");
  return h.replace(/(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-");
}

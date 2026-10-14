// Each exposure and track gets one UUIDv7 id.
// The collector stores a re-sent event once.

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

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
  const h = Array.from(b, (x) => HEX[x]!);
  return (
    h.slice(0, 4).join("") + "-" +
    h.slice(4, 6).join("") + "-" +
    h.slice(6, 8).join("") + "-" +
    h.slice(8, 10).join("") + "-" +
    h.slice(10, 16).join("")
  );
}

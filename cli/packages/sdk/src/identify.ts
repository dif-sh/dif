// `dif.identify()`: sets the user id for the rest of the page load.
// Only traits make an element, as `$identify` rows are not billed.

import { getState } from "./config.js";
import { handOff } from "./elements.js";
import { uuidv7 } from "./event-id.js";
import { SOURCE } from "./version.js";

let identified: string | null = null;

/** The id from the last `dif.identify()`, or null. */
export function identifiedUserId(): string | null {
  return identified;
}

/** Test-only. */
export function __resetIdentity(): void {
  identified = null;
}

function isTraits(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function identify(userId: string, traits?: Record<string, unknown>): void {
  // The collector refuses an empty user_id.
  if (typeof userId !== "string" || userId === "") return;
  identified = userId;

  const state = getState();
  if (!state || state.enabled === false || !isTraits(traits)) return;
  handOff({
    type: "identify",
    event_id: uuidv7(),
    fired_at: Date.now(),
    source: SOURCE,
    user_id: userId,
    traits,
  });
}

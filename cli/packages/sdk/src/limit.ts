// Cloud answers 402 when a free-tier org has used
// its monthly events. Each later event gets the same answer.
let warned = false;

/** Test-only. */
export function __resetLimitWarning(): void {
  warned = false;
}

/** Return true when the status is the monthly event limit. */
export function warnIfEventLimit(status: number | null): boolean {
  if (status !== 402) return false;
  if (!warned && typeof console !== "undefined") {
    warned = true;
    console.warn(
      "[dif] dif.sh Cloud dropped events: this org reached its free monthly event limit. " +
        "Events are dropped until you upgrade (dif.sh Cloud, Billing) or the month ends.",
    );
  }
  return true;
}

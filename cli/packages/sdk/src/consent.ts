// Consent gate. It holds sends until the visitor answers.

const MAX_HELD = 50;

let required = false;
// Null means no answer yet.
let answer: boolean | null = null;
let held: Array<() => void> = [];

/** Turns the gate on or off. Same value keeps the state. */
export function requireConsent(next: boolean): void {
  if (next === required) return;
  required = next;
  answer = null;
  held = [];
}

/** Records the visitor answer. No effect when the gate is off. */
export function consent(granted: boolean): void {
  if (!required) return;
  answer = granted === true;
  const queued = held;
  held = [];
  if (!answer) return;
  for (const send of queued) send();
}

/** Runs `send` now, holds it, or drops it. */
export function gated(send: () => void): void {
  if (!required || answer === true) {
    send();
    return;
  }
  if (answer === false) return;
  if (held.length < MAX_HELD) held.push(send);
}

/** Test-only. Clears the gate and the held sends. */
export function __resetConsent(): void {
  required = false;
  answer = null;
  held = [];
}

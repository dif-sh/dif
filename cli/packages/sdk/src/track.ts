// Browser metric tracking. Mirrors the cloud-page snippet:
//
//   dif.track("completed_checkout");
//   dif.track("revenue", { value: 49, currency: "USD" });
//
// Implementation notes:
//  - `navigator.sendBeacon` cannot set custom headers, and we need to send
//    `Authorization: Bearer <publishableKey>`. So we always use
//    `fetch` with `keepalive: true`. First call per page may trigger a CORS
//    preflight; subsequent calls reuse the cached preflight up to 24h.
//  - The call is fire-and-forget. We never throw at the customer's call site —
//    analytics must not crash a render.
//  - Without a configured publishableKey, we log to console.debug and drop.
//    This matches the sample app's pre-SDK behavior and keeps dev ergonomic.

import { getState } from "./config.js";
import type { TrackProps } from "./types.js";

const SOURCE = "@dif.sh/sdk@0.3.2";

export function track(metric: string, opts: TrackProps = {}): void {
  const state = getState();
  if (!state || state.enabled === false) return;

  const userId = opts.userId ?? state.userId();
  if (!userId) {
    // Can't attribute; drop. The cloud expects a user_id on every event.
    return;
  }

  if (!state.publishableKey) {
    if (typeof console !== "undefined") {
      console.debug("[dif] track (no publishableKey, dropped)", metric, opts);
    }
    return;
  }

  const url = `${state.apiUrl}/v1/track`;
  const body = JSON.stringify({
    metric,
    user_id: userId,
    value: opts.value,
    currency: opts.currency,
    unit: opts.unit,
    fired_at: opts.firedAt ?? Date.now(),
    idempotency_key: opts.idempotencyKey,
    source: opts.source ?? SOURCE,
    props: opts.props,
  });

  try {
    void fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${state.publishableKey}`,
      },
      body,
      keepalive: true,
    }).catch(() => {
      // Swallow — analytics must never throw at the call site.
    });
  } catch {
    // Synchronous throws (e.g. fetch undefined in unusual envs) are also swallowed.
  }
}

// Browser metric tracking. Mirrors the cloud-page snippet:
//
//   dif.track("completed_checkout");
//   dif.track("revenue", { value: 49, currency: "USD" });
//
// This builds a normalized `MetricEvent` and hands it to the configured
// delivery handler (`state.trackHandler`): the cloud POST in cloud mode, or the
// user's `dif/events/track.ts` in custom mode. The handler — not this function —
// owns the transport, so a custom handler doesn't need a publishableKey.
//
// The call is fire-and-forget; handlers must not throw at the customer's call
// site — analytics must not crash a render.

import { getState } from "./config.js";
import { handOff } from "./elements.js";
import { uuidv7 } from "./event-id.js";
import { currentHref, documentReferrer } from "./stamp.js";
import { cleanPageUrl, cleanReferrer } from "./url.js";
import { SOURCE } from "./version.js";
import type { MetricEvent, TrackProps } from "./types.js";

// Only `anonymous: true` gets here.
// The collector gives the visitor id from the page's request.
function sendAnonymous(name: string, opts: TrackProps): void {
  const href = currentHref();
  const url = href === null ? null : cleanPageUrl(href);
  // A server has no page, and its IP is not the visitor's.
  if (url === null) return;
  const rawReferrer = documentReferrer();
  const referrer = rawReferrer ? cleanReferrer(rawReferrer) : null;
  handOff({
    type: "track",
    event_id: uuidv7(),
    fired_at: opts.firedAt ?? Date.now(),
    source: opts.source ?? SOURCE,
    event: name,
    ...(opts.value !== undefined && { value: opts.value }),
    ...(opts.currency !== undefined && { currency: opts.currency }),
    ...(opts.unit !== undefined && { unit: opts.unit }),
    ...(opts.idempotencyKey !== undefined && { idempotency_key: opts.idempotencyKey }),
    url,
    ...(referrer !== null && { referrer }),
    ...(opts.props !== undefined && { props: opts.props }),
  });
}

export function track(metric: string, opts: TrackProps = {}): void {
  const state = getState();
  if (!state || state.enabled === false) return;

  const userId = opts.userId ?? state.userId();
  if (!userId) {
    // No user id: drop it, unless the app opts in.
    if (state.anonymous) sendAnonymous(metric, opts);
    return;
  }

  // Only include optional fields when present — `exactOptionalPropertyTypes`
  // forbids assigning `undefined` to an optional, and the wire shape (a JSON
  // POST or a custom handler) is cleanest without undefined keys anyway.
  const event: MetricEvent = {
    event_id: uuidv7(),
    metric,
    user_id: userId,
    fired_at: opts.firedAt ?? Date.now(),
    source: opts.source ?? SOURCE,
    ...(opts.value !== undefined && { value: opts.value }),
    ...(opts.currency !== undefined && { currency: opts.currency }),
    ...(opts.unit !== undefined && { unit: opts.unit }),
    ...(opts.idempotencyKey !== undefined && { idempotency_key: opts.idempotencyKey }),
    ...(opts.props !== undefined && { props: opts.props }),
  };

  try {
    state.trackHandler(event);
  } catch {
    // Handlers should swallow internally; defend here too so a misbehaving
    // custom handler can never throw at the call site.
  }
}

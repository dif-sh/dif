# @dif.sh/sdk

Client SDK for [dif.sh](https://dif.sh). Handles two things:

1. **Experiment assignment**: picks the variant for each user and fires a
   deterministic exposure event.
2. **Metric tracking**: fires conversion and outcome events so the analysis
   layer can compute lift.

## Install

```sh
npm install @dif.sh/sdk
```

Zero runtime dependencies. Works in the browser and on the server
(Node 20.6+).

## Initialize once, at app boot

```ts
import "../dif/generated/client"; // side effect: registers active experiments
import { attributes } from "../dif/generated/audiences";
import { events } from "../dif/generated/events"; // cloud config + publishable key
import { dif } from "@dif.sh/sdk";

dif.init({
  events,                          // from `dif build`; carries your publishable key
  userId: () => currentUser?.id ?? null,
  attributes: () => attributes(),  // wired audience bag from `dif build`
});
```

Connect the project once with the key from cloud onboarding — `dif connect
--key dif_pk_live_…` (or `dif init --key …` on a new project). That writes the
key into `dif/config.yaml`, and `dif build` bakes it into
`dif/generated/events.ts`, so nothing secret is pasted into app code and no env
var is needed. Get the key from your project's Settings → Keys tab in dif.sh
Cloud; publishable keys are safe to embed in browser bundles (they can only
write to `/v1/track` and `/v1/exposure` and are scoped by origin allowlist).

Passing an explicit top-level `publishableKey` to `dif.init` still works and
overrides the one baked into `events` — handy for per-environment keys.

## Wiring audiences

Every entry in `dif/config.yaml`'s `audience_attributes` is paired with a
resolver file at `dif/audiences/<name>.ts`. `dif build` tree-shakes the folder
against the attributes your active experiments reference, and emits a wired
`dif/generated/audiences.ts` that exposes a single `attributes(overrides)`
helper. Pass it straight to `dif.init`:

```ts
import { attributes } from "../dif/generated/audiences";

dif.init({
  userId: () => currentUser?.id ?? null,
  attributes: () => attributes({
    plan: currentUser?.plan,   // app-context override; wins on overlap
  }),
});
```

`dif init` scaffolds two starters: `audiences/locale.ts` (returns
`navigator.language`) and `audiences/device_type.ts` (returns
`"mobile" | "tablet" | "desktop"` via `matchMedia`). Both return `null` on
the server, which fails the predicate match closed during SSR. Add your own
file (`audiences/returning_visitor.ts`, etc.) and a matching
`audience_attributes` entry to extend the set; `dif validate` errors with
`E008` if a declared attribute has no resolver, and warns with `W002` if an
orphan resolver has no declaration.

## Experiment assignment

```ts
const cta = dif("checkout-cta-v2", {
  control: () => "Place order",
  variant_a: () => "Get it today",
});

// at the render site
<button>{cta()}</button>;
```

The experiment definitions come from `dif/generated/client.ts`, a
side-effect module emitted by `dif build`. Importing it once at boot
registers every active experiment (variants, weights, salt, audience) with
the SDK; after that, every `dif()` call resolves locally.

Variant resolution is deterministic, sticky per user, and byte-compatible
with `dif-core` (Rust). One exposure event fires per `(experiment, user)`
per page load. In the browser with cloud delivery, it also stays quiet across
page loads; see [Exposure dedup](#exposure-dedup).

## Exposure dedup

Within one page load, an exposure fires once per `(experiment, user)`.

In the browser, with cloud delivery, the SDK also remembers what it sent. It
keeps one `localStorage` entry per experiment and user:

```
dif:exp:v1:<experiment>:<user hash>  →  { "variant": "…", "until": <unix ms> }
```

`<user hash>` is the first 8 bytes of the SHA-256 of the user id, in hex, so the
key never holds a raw user id such as an email. Two users on one browser that
share a hash would cost one extra or one skipped exposure. That is rare enough
to accept.

- An exposure fires when the entry is absent, expired, or names another
  variant. A reassignment still fires, so you can see it in the results.
- The entry is written **only after the cloud answers 2xx** for the request
  that held the exposure. With [batching](#batching-and-retries) that is the
  batch, so the entry can follow the exposure by a few seconds. If the batch
  fails or the page closes first, nothing is written and the exposure fires
  again on the next load.
- An entry lasts 30 days from the send that wrote it. An entry whose `until`
  is more than 30 days ahead (a clock that ran fast, or an edit) counts as
  expired.
- The first exposure on each page load removes entries that are expired,
  malformed or too far ahead.
- If `localStorage` is missing or throws (private mode, blocked storage), the
  SDK dedupes per page load only.
- With `events: custom`, your handler decides what is delivered, so dedup stays
  per page load and no entry is written.
- On the server there is no `window`, so nothing is saved. `assign()` never
  fires an exposure. A bare `dif()` call with a `userId` set can still fire one,
  deduped per process only.

## Event ids

Every exposure and every `dif.track()` or `DifServer.track()` call carries an
`event_id`: a UUIDv7 in lowercase form, made when the event is created. Cloud
handlers that do not read `event_id` ignore it. Custom handlers receive it on
the event object.

## Metric tracking

```ts
// Simple conversion
dif.track("completed_checkout");

// Revenue with value
dif.track("revenue", { value: 49, currency: "USD" });

// With overrides
dif.track("article_read", {
  userId: "u_42",                 // override the configured resolver
  props: { article_id: "a_91" },  // arbitrary extras
});
```

Calls are fire-and-forget. Events queue and go out in batches using `fetch`
with `keepalive: true`; see [Batching and retries](#batching-and-retries). Each
event carries an `event_id` (see [Event ids](#event-ids)). The call never
throws; bad analytics must not crash a render. When `publishableKey` isn't
configured, the call logs to `console.debug` and drops.

## Batching and retries

In the browser, with cloud delivery, exposures and `dif.track()` events go
through one queue per endpoint (`/v1/exposure` and `/v1/track`).

- **When it sends.** At 20 queued events, 2 seconds after the first queued
  event, on `pagehide`, and when the page turns hidden. Each send is one
  `keepalive` `fetch` with a JSON array.
- **Body size.** A body is at most 60,000 bytes. A larger batch is split into
  several requests. A single event over that size is dropped with a console
  warning.
- **Checks before queueing.** Each event is checked against the rules of the
  cloud handlers (for example `experiment`, `variant`, `metric` and `user_id`
  must be non-empty strings, `bucket` and `value` must be finite numbers, and
  `fired_at` must be a time `Date` can hold). An event that fails is dropped
  alone with a console warning, so one bad event does not cost its batch. The
  SDK shows up to 20 such warnings.
- **Retries.** A network error, a 5xx or a 429 is tried again, at most 3
  times: after about 1, 2 and 4 seconds, each wait cut to between half and all
  of that, and no shorter than `Retry-After` (up to 30 seconds). A retry sends
  the same body, so the same `event_id`s. Other 4xx answers are not retried.
  If the cloud answers 400 for a batch and names the event, the SDK drops that
  event and sends the rest. If it names none, the SDK sends the batch again in
  two halves. Browsers hide `Retry-After` from cross-origin responses unless
  the server lists it in `Access-Control-Expose-Headers`.
- **Page close.** On `pagehide` and when the page turns hidden, the SDK sends
  what is queued and any batch that waits to retry, at once. It also sends a
  second copy of each request still in flight, with the same body. After the
  page is hidden, a new event goes out at once until the page shows again.
  The browser limits the `keepalive` requests in flight to 64 KiB together, so
  a very large queue at page close can still lose events.
- **Dedup entries.** A batch's exposures get their `localStorage` entries only
  after that batch answers 2xx; see [Exposure dedup](#exposure-dedup).

`await dif.flush()` sends the queue at once and resolves when each event is sent
or lost. It is useful before a hard redirect, and in tests.

Where the page cannot report that it is closing (no `window`, such as on a
server), there is no batching: each event is sent at once, in a request of one
event, and the same checks and retries apply.

## Server-side

For server-side tracking (route handlers, server actions, background jobs)
import `DifServer` from the `/server` subpath. It takes a **secret** token
(`dif_<env>_…`), not a publishable key:

```ts
import { DifServer } from "@dif.sh/sdk/server";

const dif = new DifServer({ apiKey: process.env.DIF_KEY });

await dif.track({
  metric: "completed_checkout",
  userId: user.id,
  value: 49,
  currency: "USD",
});
```

By default each `track()` call is one awaited request, with no retry, and the
SDK does not check the event first.

For many events, opt in to batching:

```ts
const dif = new DifServer({
  apiKey: process.env.DIF_KEY,
  batch: true,                      // or { size: 100, intervalMs: 1000 }
});

await dif.track({ metric: "job_done", userId: job.userId }); // resolves once queued
await dif.flush();  // send what is queued; resolves when each event is sent or lost
await dif.close();  // flush, then stop batching
```

With `batch`, events are checked, queued and sent as arrays of up to `size`
events (default 20, at most 500) every `intervalMs` (default 2000), in bodies
of at most 60,000 bytes. Failures are retried as in [Batching and
retries](#batching-and-retries). `track()` resolves when the event is queued, so
call `flush()` or `close()` before the process ends, or the last events can be
lost. After `close()`, each `track()` is one request again.

Never put a secret token in a browser bundle. They authenticate as the
project (read-only on most routes, write to ingest), and leaked secrets
must be rotated immediately via the Keys settings.

## React

The `@dif.sh/react` package provides a `<DifProvider>` and a `useDif()`
hook so React apps can call `track` from anywhere in the tree:

```tsx
import { DifProvider, useDif } from "@dif.sh/react";

<DifProvider
  config={{
    project: "acme-shop",
    publishableKey: "dif_pk_live_…",
    userId: () => currentUser?.id ?? null,
  }}
>
  <App />
</DifProvider>;

// inside a component
const { track } = useDif();
useEffect(() => track("completed_checkout"), []);
```

## What this package does, what it doesn't

**Does:**
- Variant lookup against the generated experiment spec.
- Deterministic SHA-256 bucketing, byte-compatible with `dif-core` (Rust).
- Audience predicate evaluation and exclusion-group arbitration. Within a
  group, the SDK picks the same winner as `dif qa` (sorted by created date,
  then id), so the CLI and the runtime agree on who sees what.
- One exposure event per `(experiment, user)` per page load, and in the
  browser with cloud delivery, once per 30 days until the variant changes.
  Delivered per the `events` config from `dif build`: cloud mode posts to
  dif.sh Cloud, custom mode calls your `dif/events/exposure.ts` handler.
- An `event_id` (UUIDv7) on every exposure and track.
- Metric tracking (`dif.track`): to dif.sh Cloud in cloud mode, or your
  `dif/events/track.ts` handler in custom mode. Server tracking is cloud-only.

- In the browser, batches events and retries failures (3 times, same body, same
  `event_id`s). `DifServer` does the same when you opt in with `batch`.

**Does not:**
- Buffer offline. After the retries fail, or when the page closes before a
  send, the event is gone.
- Compute lift, p-values, or any analytics. That's the cloud's job.

## Preview & QA forcing

The SDK honors a `?_dif=` URL param / `_dif` cookie so QA, designers, and
PMs can force a variant by clicking a link. A forced assignment **never
fires an exposure**. The framework adapters (`@dif.sh/svelte`,
`@dif.sh/react`) wire this up automatically; in a vanilla app, call
`syncOverrides()` once after `dif.init`:

```ts
import { dif, syncOverrides, mountDifPreview } from "@dif.sh/sdk";
dif.init({ /* … */ });
syncOverrides();   // reads ?_dif / the _dif cookie → session-scoped forces
mountDifPreview(); // optional badge: active forces + a one-click clear
```

Link form (matches `dif qa --preview-url`): `?_dif=exp=variant,exp2=variant2`;
`?_dif=off` clears. Also `dif.setOverrides({ exp: "variant" })` /
`dif.getOverrides()`. Pass `syncOverrides({ allow: false })` to gate by env.

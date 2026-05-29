# @dif.sh/sdk

Client SDK for [dif.sh](https://dif.sh). Handles two things:

1. **Experiment assignment** — picks the variant for each user and fires a
   deterministic exposure event.
2. **Metric tracking** — fires conversion / outcome events to dif.sh Cloud
   so the analysis layer can compute lift.

## Install

```sh
npm install @dif.sh/sdk
```

## Initialize once, at app boot

```ts
import { dif } from "@dif.sh/sdk";

dif.init({
  project: "acme-shop",
  publishableKey: "dif_pk_live_…", // browser-safe write key
  userId: () => currentUser?.id ?? null,
});
```

Get a publishable key from your project's Settings → Keys tab in dif.sh
Cloud. Publishable keys are safe to embed in browser bundles; they can only
write to `/v1/track` and `/v1/exposure` and are scoped by origin allowlist.

## Experiment assignment

```ts
const cta = dif("checkout-cta-v2", {
  control: () => "Place order",
  variant_a: () => "Get it today",
});

// at the render site
<button>{cta()}</button>;
```

You normally don't write the `dif(...)` call by hand — `dif build` emits a
generated module with one typed export per active experiment. Import the
named export and call it:

```ts
import { checkoutCta } from "../.dif/generated/client";
<button>{checkoutCta()}</button>;
```

Variant resolution is deterministic, sticky per user, and byte-compatible
with `dif-core` (Rust). One exposure event fires per `(experiment, user)`
per session.

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

Calls are fire-and-forget: one HTTP POST per event using `fetch` with
`keepalive: true`. The call never throws — bad analytics must not crash a
render. When `publishableKey` isn't configured, the call logs to
`console.debug` and drops.

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

Never put a secret token in a browser bundle. They authenticate as the
project (read-only on most routes, write to ingest), and leaked secrets
must be rotated immediately via the Keys settings.

## React

The `@dif.sh/react` package provides a `<DifProvider>` and a `useDif()`
hook so React apps can call `track` from anywhere in the tree:

```tsx
import { DifProvider, useDif } from "@dif.sh/react";

<DifProvider config={{ project: "acme-shop", publishableKey: "dif_pk_live_…" }}>
  <App />
</DifProvider>;

// inside a component
const { track } = useDif();
useEffect(() => track("completed_checkout"), []);
```

## What this package does, what it doesn't

**Does:**
- Variant lookup against the generated experiment spec.
- Deterministic SHA-256 bucketing — byte-compatible with `dif-core` (Rust).
- Audience predicate evaluation + exclusion-group resolution.
- One exposure event per `(experiment, user)` per session, to a configurable sink.
- Metric tracking (`dif.track`) to dif.sh Cloud, browser + server.

**Does not (in v0):**
- Batch events. Each call is one HTTP POST.
- Retry on failure. Browser drops; server warns.
- Buffer offline. If the request fails, the event is gone.
- Compute lift, p-values, or any analytics. That's the cloud's job.

See [../../PLAN.md](../../PLAN.md) for the architectural rationale.

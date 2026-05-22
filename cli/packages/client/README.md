# @dif.sh/client

Tiny runtime SDK for [dif.sh](https://dif.sh).

You almost never call this directly. The `dif build` step emits
`.dif/generated/client.ts` which imports from this package and exposes one
typed export per active experiment. You import the named export and call it
at the render site:

```ts
import { checkoutCta } from "../.dif/generated/client";

function CheckoutButton() {
  return <button>{checkoutCta()}</button>;
}
```

## Configure once, at app boot

```ts
import { configure } from "@dif.sh/client";

configure({
  userId: () => currentUser?.id ?? null,
  sink: { kind: "segment", analytics: window.analytics },
});
```

That's it. Exposure events fire on render, deduped per session per
(experiment, user).

## What this package does, what it doesn't

**Does:**
- Variant lookup, given a generated experiment spec.
- Deterministic SHA-256 bucketing — byte-compatible with `dif-core` (Rust).
- Audience predicate evaluation.
- Exclusion-group resolution.
- One exposure event per `(experiment, user)` per session, to a configurable sink.

**Does not:**
- Store events.
- Compute lift, p-values, or any analytics.
- Talk back to the CLI at runtime — the generated TS file is the entire contract.

See [../../PLAN.md](../../PLAN.md) for the architectural rationale.

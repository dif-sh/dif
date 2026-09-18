# @dif.sh/openfeature

[OpenFeature](https://openfeature.dev/) server provider for [dif.sh](https://www.dif.sh/).

It resolves `OpenFeature.getClient()` evaluations against the experiments that
`dif build` registers in `dif/generated/client.ts`. Every decision goes through
the same `assign()` function `@dif.sh/sdk` uses, so a user gets the same variant
from this provider as from `dif()`.

The typed `dif()` call in `@dif.sh/sdk` is still the main way to use dif. This
package is for codebases that already evaluate flags through OpenFeature. See
[When to use this vs `@dif.sh/sdk` directly](#when-to-use-this-vs-difshsdk-directly).

```sh
npm i @dif.sh/sdk @dif.sh/openfeature @openfeature/server-sdk
```

Peers: `@dif.sh/sdk` `^0.6.1` and `@openfeature/server-sdk` `^1.18.0`. Node
20.6+, ESM only.

## Usage

```ts
import "./dif/generated/client"; // side effect: registers every active experiment
import { OpenFeature } from "@openfeature/server-sdk";
import { DifOpenFeatureProvider } from "@dif.sh/openfeature";

OpenFeature.setProvider(new DifOpenFeatureProvider());
const client = OpenFeature.getClient();

const newCheckout = await client.getBooleanValue("new-checkout", false, {
  targetingKey: user.id,
  device_type: "mobile",
});
```

Import `dif/generated/client.ts` before the first evaluation. Without it the
registry is empty, so every call returns your default value with
`errorCode: FLAG_NOT_FOUND`. Run `dif build` after you add, rename, or conclude a
file in `dif/experiments/active/`.

The provider has no `initialize()` step because the specs are already in memory
once the generated client is imported. `setProvider` and `setProviderAndWait`
behave the same.

### Evaluation context

| Context field | Becomes |
| --- | --- |
| `targetingKey` | The dif user id, hashed with the experiment's salt to pick a bucket. Missing or `""` resolves to the first declared variant with no exposure. |
| Any other top-level string, number, boolean, or `null` | An entry in the attribute bag the experiment's `audience:` block is evaluated against (`device_type`, `plan`, …). |
| Objects, arrays, `Date`s | Skipped. `audience:` rules only compare scalars. |

### What each method returns

The first entry under `variants:` in the experiment's `.md` file is the control.

| Method | `value` | `variant` |
| --- | --- | --- |
| `getStringValue` / `getStringDetails` | The variant id, e.g. `"variant_a"` | The variant id |
| `getBooleanValue` / `getBooleanDetails` | `false` for the first declared variant, `true` for any other | The variant id |
| `getNumberValue` / `getObjectValue` | Your default value, with `errorCode: TYPE_MISMATCH` | none |

A flag declared as `variants: [{ id: "off" }, { id: "on" }]` gives `false` for
`off` and `true` for `on`. An experiment declared as `control` / `variant_a`
gives `false` for `control`. With three or more variants, every non-control
variant is `true`, so use `getStringValue` to tell them apart.

`reason` on the details object:

| `reason` | When |
| --- | --- |
| `SPLIT` | `targetingKey` was set, the `audience:` block matched, and the user was bucketed. `onExposure` runs. |
| `STATIC` | An `overrides` entry forced the variant. `onExposure` does not run. |
| `DEFAULT` | No `targetingKey`, the `audience:` block didn't match, or another experiment in the same `exclusion_group:` won. The value is the first declared variant. |
| `ERROR` | `FLAG_NOT_FOUND` (id not registered) or `TYPE_MISMATCH` (number or object evaluation). The value is your default. |

`flagMetadata` carries `surface` (the experiment's `surface:` field) and, on
`SPLIT` only, `bucket` (`0..9999`).

## Options

```ts
new DifOpenFeatureProvider({
  overrides,  // QA forces: experiment id → variant id
  onExposure, // ({ flagKey, variant, bucket, userId }) => void
});
```

### `onExposure`

Called for every evaluation that resolves with reason `SPLIT`. It is not
deduplicated. The browser `dif()` call dedupes per `(experiment, user)`, but
this provider holds no per-user state, so one request that evaluates
`new-checkout` twice calls `onExposure` twice. Errors thrown inside it are
caught and ignored, and the evaluation result doesn't change.

The provider does not send exposures anywhere itself. `DifServer` in
`@dif.sh/sdk/server` sends metrics (`track()`), not exposures, so forward
`onExposure` to your own analytics pipeline or warehouse.

### `overrides`

A fixed map, or a function of the evaluation context. A forced evaluation
resolves with reason `STATIC` and never calls `onExposure`. An override that
names a variant the spec doesn't declare is ignored.

The browser SDK's `syncOverrides()` stores `?_dif=` links in a `_dif` cookie
using the same `id=variant,id=variant` format as `dif qa --preview-url`. To
honour that cookie on the server, put it on the context and parse it with
`parseOverrides` from `@dif.sh/sdk`:

```ts
import { parseOverrides } from "@dif.sh/sdk";

new DifOpenFeatureProvider({
  overrides: (ctx) =>
    typeof ctx.dif_preview === "string"
      ? (parseOverrides(ctx.dif_preview) ?? undefined)
      : undefined,
});

// at the call site
await client.getStringValue("checkout-cta-v2", "control", {
  targetingKey: user.id,
  dif_preview: cookies.get("_dif"),
});
```

Return `undefined` from the function to turn forcing off, for example in
production.

## Next.js (App Router)

**`lib/flags.ts`**: import the generated client and set the provider once per
server process.

```ts
import "../dif/generated/client";
import { OpenFeature } from "@openfeature/server-sdk";
import { DifOpenFeatureProvider } from "@dif.sh/openfeature";
import { logExposure } from "./analytics"; // your pipeline

OpenFeature.setProvider(
  new DifOpenFeatureProvider({
    onExposure: ({ flagKey, variant, bucket, userId }) =>
      logExposure({ experiment: flagKey, variant, bucket, user_id: userId }),
  }),
);

export const flags = OpenFeature.getClient();
```

**`app/checkout/page.tsx`**: evaluate in a server component.

```tsx
import { headers } from "next/headers";
import { flags } from "@/lib/flags";
import { getSession } from "@/lib/auth"; // your auth
import { LegacyCheckout, NewCheckout } from "./checkout";

export default async function CheckoutPage() {
  const session = await getSession();
  const ua = (await headers()).get("user-agent") ?? "";

  const newCheckout = await flags.getBooleanValue("new-checkout", false, {
    targetingKey: session?.user.id,
    device_type: /Mobi/i.test(ua) ? "mobile" : "desktop",
  });

  return newCheckout ? <NewCheckout /> : <LegacyCheckout />;
}
```

## When to use this vs `@dif.sh/sdk` directly

Use `dif()` from `@dif.sh/sdk` if you can. It checks more at build time and does
more at runtime:

- **Typed branches.** `dif("new-checkout", { off: () => …, on: () => … })` takes
  its branch keys from the experiment's `variants:`, so a renamed variant is a
  type error. In `client.getBooleanValue("new-checkout", false)`, the flag key is
  a plain string that TypeScript can't check.
- **Orphan checks.** `dif validate` warns with `W001` when a `dif("<id>", …)` call
  site names an experiment that isn't active. It only matches `dif("…")` calls,
  so it doesn't see OpenFeature `get*Value` calls.
- **Exposure delivery.** In the browser, `dif()` dedupes exposures and delivers
  them through the `events` config `dif build` writes to
  `dif/generated/events.ts`. With this provider you get `onExposure` and deliver
  the event yourself.
- **Framework adapters.** `@dif.sh/react` and `@dif.sh/svelte` assign on the
  server and reuse that decision on the client, so the variant doesn't change
  after hydration.

Use `@dif.sh/openfeature` when:

- your services already call `OpenFeature.getClient()`, and you're moving flags
  into `dif/experiments/active/*.md` without rewriting those call sites;
- dif is one of several providers behind OpenFeature, for example alongside
  another vendor during a migration;
- you already rely on OpenFeature hooks (logging, OpenTelemetry) for evaluation
  telemetry.

Both read the same registry, so they can run side by side. A `dif()` call and a
`getStringValue` call for the same id and user return the same variant.

## Docs

- SDK and generated client: <https://www.dif.sh/docs/sdk/>
- Experiment file format: <https://www.dif.sh/docs/format/>
- CLI (`dif build`, `dif validate`, `dif qa`): <https://www.dif.sh/docs/cli/>

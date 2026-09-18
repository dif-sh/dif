# Flags SDK - dif.sh Provider

The [dif.sh provider](https://flags-sdk.dev/providers/dif) for the [Flags SDK](https://flags-sdk.dev/) assigns feature flags and A/B experiments that [dif.sh](https://www.dif.sh/docs/) keeps as Markdown files in your repository.

`dif build` compiles every `dif/experiments/active/*.md` file into `dif/generated/client.ts`. The adapter calls `assign()` from `@dif.sh/sdk` against that file on each `decide`. No network request is made.

## Setup

The dif.sh provider is available in the `@flags-sdk/dif` module. Install it with `@dif.sh/sdk`, which is a peer dependency:

```bash
pnpm i @flags-sdk/dif @dif.sh/sdk
```

Keep exactly one copy of `@dif.sh/sdk` in your install. The generated client registers experiments into a module-level registry inside `@dif.sh/sdk`, and the adapter reads from that same registry. A second copy would be empty and every flag would fall back to its `defaultValue`.

`dif init` gitignores `dif/generated/`, so generate the client before every build:

```json
{
  "scripts": {
    "prebuild": "dif build"
  }
}
```

## Provider Instance

You can import the default adapter instance `difAdapter` from `@flags-sdk/dif`:

```ts
import { difAdapter } from "@flags-sdk/dif";
```

`difAdapter` exposes:

- `difAdapter.variant()` resolves to the assigned variant id, such as `"control"` or `"variant_a"`.
- `difAdapter.isEnabled()` resolves to `true` when the assigned variant is not the first declared variant. `difAdapter.isEnabled({ on: "variant_b" })` resolves to `true` only for `variant_b`.
- `difAdapter.identify` reads `userId` from the `dif_uid` cookie.

Use `createDifAdapter` to change the defaults:

```ts
import { createDifAdapter } from "@flags-sdk/dif";

const dif = createDifAdapter({
  cookieName: "dif_uid",
  overrides: process.env.VERCEL_ENV !== "production",
  onExposure: ({ key, variant, bucket, userId }) => {
    // send to your analytics; errors are logged and never change the decision
  },
  origin: (key) =>
    `https://github.com/acme/app/blob/main/dif/experiments/active/${key}.md`,
});
```

| Option | Default | Effect |
| --- | --- | --- |
| `cookieName` | `"dif_uid"` | Cookie `identify` reads the user id from. |
| `overrides` | `true` | Honor the `_dif` cookie that `dif qa --force` preview links (`?_dif=key=variant`) set. |
| `onExposure` | none | Called when a user is bucketed into a variant. Not called for a missing user id, an audience miss, an exclusion-group loss, or a `_dif` force. |
| `origin` | none | URL shown in the Flags Explorer for each flag. |

## Example

The flag `key` is the experiment id, which is the `.md` filename stem.

```ts
// flags.ts
import "./dif/generated/client";
import { flag } from "flags/next";
import { difAdapter } from "@flags-sdk/dif";

export const newCheckoutFlag = flag<boolean>({
  key: "new-checkout",
  defaultValue: false,
  adapter: difAdapter.isEnabled(),
});

export const heroCtaFlag = flag<string>({
  key: "home-hero-cta",
  defaultValue: "control",
  adapter: difAdapter.variant(),
});
```

What `decide` returns for a flag whose variants are `control`, `variant_a`:

| Request | `variant()` | `isEnabled()` | `onExposure` |
| --- | --- | --- | --- |
| `dif_uid` cookie set, audience matches | bucketed variant | `variant !== "control"` | called |
| no `dif_uid` cookie | `"control"` | `false` | not called |
| audience miss or exclusion-group loss | `"control"` | `false` | not called |
| `_dif=new-checkout=variant_a` cookie | `"variant_a"` | `true` | not called |
| key missing from `dif/generated/client.ts` | throws, flag returns `defaultValue` | throws, flag returns `defaultValue` | not called |

`identify` cannot set cookies. Mint `dif_uid` in `middleware.ts` so the first request is bucketed; see the [provider documentation](https://flags-sdk.dev/providers/dif) for the snippet.

## Flags Explorer

Emit your dif experiments from the `.well-known/vercel/flags` route with `getProviderData`. Pass your `flags.ts` exports so `isEnabled()` flags get `false`/`true` options:

```ts
// app/.well-known/vercel/flags/route.ts
import { createFlagsDiscoveryEndpoint } from "flags/next";
import { getProviderData } from "@flags-sdk/dif";
import * as flags from "../../../../flags";

export const GET = createFlagsDiscoveryEndpoint(() => getProviderData({ flags }));
```

## Documentation

Please check out the [dif.sh provider documentation](https://flags-sdk.dev/providers/dif) and the [dif.sh docs](https://www.dif.sh/docs/) for more information.

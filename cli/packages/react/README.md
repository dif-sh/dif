# @dif.sh/react

React adapter for [@dif.sh/sdk](https://www.npmjs.com/package/@dif.sh/sdk).
Wraps `dif.init`, `dif.track`, and the experiment-assignment call in a
provider + hook so React apps don't have to touch the module-level singleton
directly.

## Install

```sh
npm install @dif.sh/sdk @dif.sh/react
```

`@dif.sh/sdk` is a peer dependency, so install it explicitly.

## Initialize at the root of your tree

```tsx
import { DifProvider } from "@dif.sh/react";
import { events } from "@/dif/generated/events"; // cloud config + publishable key

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <DifProvider
      config={{
        events,
        userId: () => currentUser?.id ?? null,
      }}
    >
      {children}
    </DifProvider>
  );
}
```

Connect the project once with `dif connect --key dif_pk_live_…` (or `dif init
--key …`). The key lands in `dif/config.yaml` and `dif build` bakes it into
`dif/generated/events.ts`, so there's no `NEXT_PUBLIC_DIF_PUBLISHABLE_KEY` env
var to wire up. (You can still pass an explicit `publishableKey` in `config` to
override per environment.)

The provider runs `dif.init(config)` exactly once on first render. The
underlying state is a module-level singleton; re-mounting the provider with
a different config will replace the previous one.

## Track from any component

```tsx
import { useEffect } from "react";
import { useDif } from "@dif.sh/react";

export function CheckoutSuccess() {
  const { track } = useDif();
  useEffect(() => {
    track("completed_checkout", { value: 49, currency: "USD" });
  }, []);
  return <Receipt />;
}
```

## Experiment assignment from a hook

```tsx
import { useDif } from "@dif.sh/react";

export function CheckoutCTA() {
  const { exposure: dif } = useDif();
  const cta = dif("checkout-cta-v2", {
    control: () => "Place order",
    variant_a: () => "Get it today",
  });
  return <button>{cta()}</button>;
}
```

`exposure` has the same signature as the bare `dif()` from `@dif.sh/sdk`.
You can also keep using the bare import directly in non-component code;
both paths read the same module-level state set by `<DifProvider>`.

## Preview & QA forcing

`<DifProvider>` reads the `?_dif=` URL param / `_dif` cookie on mount, so
anyone can force a variant by opening a link: `?_dif=checkout-cta-v2=variant_a`
(`?_dif=off` clears). A forced assignment **never fires an exposure**, and a
small preview badge shows the active forces. Disable per-env with
`allowOverrides={false}`, or hide the badge with `preview={false}`. Generate
the link with `dif qa --force <exp>=<variant> --preview-url <url>`.

## What this package does, what it doesn't

**Does:**
- Provide `<DifProvider>` to initialize the SDK at the root of your tree.
- Provide `useDif()` to read `{ track, exposure }` from anywhere.

**Does not:**
- Re-initialize on prop changes in v0; pass a stable config.
- Maintain its own event queue. Same fire-and-forget semantics as the SDK.

See [../sdk/README.md](../sdk/README.md) for the full SDK contract.

# @dif.sh/svelte

Svelte 5 + SvelteKit adapter for [`@dif.sh/sdk`](https://www.npmjs.com/package/@dif.sh/sdk).

It does the SSR-safe parts for you:

- **Server assignment** — `difLoad()` mints a stable anonymous `dif_uid` cookie,
  derives audience attributes from request headers, and assigns every registered
  experiment with the SDK's pure assigner (no exposure firing, no shared state).
- **No flicker** — the client reuses the server's decision and the same `dif_uid`,
  so the first client render matches SSR.
- **Client-only exposures** — the `experiment()` store fires exactly one exposure
  on the client, never on the server.

```sh
npm i @dif.sh/sdk @dif.sh/svelte
```

## Usage

**`src/routes/+layout.server.ts`** — assign on the server:

```ts
import "$lib/dif/generated/client"; // side effect: registers active experiments
import { difLoad } from "@dif.sh/svelte/server";

export const load = (event) => ({ dif: difLoad(event) });
```

**`src/routes/+layout.svelte`** — init the SDK once and publish the data to context:

```svelte
<script lang="ts">
  import { setContext } from "svelte";
  import { initDif, DIF_CONTEXT_KEY } from "@dif.sh/svelte";
  import { PUBLIC_DIF_PUBLISHABLE_KEY, PUBLIC_DIF_CLOUD_URL } from "$env/static/public";

  let { data, children } = $props();
  setContext(DIF_CONTEXT_KEY, data.dif);
  initDif({
    data: data.dif,
    publishableKey: PUBLIC_DIF_PUBLISHABLE_KEY,
    apiUrl: PUBLIC_DIF_CLOUD_URL, // https://cloud.dif.sh (or your own deployment)
  });
</script>

{@render children()}
```

**Any component** — read an experiment as a store:

```svelte
<script lang="ts">
  import { experiment, track } from "@dif.sh/svelte";
  const cta = experiment("insights-cta-copy", {
    control: () => "Read more",
    variant_a: () => "Get the full breakdown",
  });
</script>

<a onclick={() => track("insights_cta_click")}>{$cta.value}</a>
```

## ISR note

On an ISR-cached route the server `load` doesn't re-run per visitor, so the
cached HTML is shared. There, `experiment()` falls back to assigning on the
client from the `dif_uid` cookie — the server renders the control branch and the
client swaps once after hydration. Don't server-assign on an ISR route unless you
also vary the cache key on the headers `difLoad` reads.

## Preview & QA forcing

Anyone can force a variant by opening a `?_dif=` link — no code, no devtools.
`initDif` reads it automatically (both `difLoad` server-side and the client):

```
# force one experiment (persists for the tab session, then auto-clears)
https://staging.niftic.com/insights/foo?_dif=insights-cta-copy=variant_a
# multiple at once
…?_dif=insights-cta-copy=variant_a,home-hero=control
# clear
…?_dif=off
# generate the exact link from the CLI
npx dif qa --force insights-cta-copy=variant_a --preview-url https://staging.niftic.com/insights/foo
```

A small **preview badge** appears whenever a force is active (showing the
experiment → variant and a one-click *clear*). **A forced assignment never fires
an exposure**, so QA can't pollute results. The force is stored in a session
`_dif` cookie (survives navigation, clears on tab close) and the param is
stripped from the address bar. Works in production too — pass
`allowOverrides: false` to `initDif`/`difLoad` to disable per-env, or
`preview: false` to hide the badge.

## API

- `difLoad(event, opts?)` → `DifData` — server load helper (`@dif.sh/svelte/server`).
- `attributesFromHeaders(headers)` → `AttributeBag` — default header mapping; override via `opts.deriveAttributes`.
- `initDif(opts)` — client init; call once in the root layout. `opts.allowOverrides` / `opts.preview` (default true).
- `experiment(id, branches)` → `Readable<{ value, variant }>`.
- `track(metric, opts?)` — fire a metric event.
- `DIF_CONTEXT_KEY` — the context key for `DifData`.

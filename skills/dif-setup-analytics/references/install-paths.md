# Install paths

Use one path per page.

## Script tag

Put it in `<head>` of every page, once. In a layout, put it in the root layout only.

```html
<script defer src="https://cdn.dif.sh/s/v1.js"
        data-key="dif_pk_live_…"
        data-domains="example.com,www.example.com"></script>
```

| Attribute | When |
|---|---|
| `data-key` | Always. The live key in production, the test key locally. Use the `key` from Step 2 of the skill. Keep the test key out of committed files. |
| `data-domains` | Always. The production hostnames. Other hosts send nothing. |
| `data-spa="hash"` | Only for `#/route` routers. The default follows `pushState`. |
| `data-user-id` | The signed-in user's id, rendered by the server. Leave it out for visitors. |
| `data-consent="required"` | Only with a CMP. Holds up to 50 events until `dif.consent(true)`. |
| `data-auto="false"` | Only if the person asks. Then call `dif.page()` yourself. |

`window.dif` has `page()`, `track(name, props)`, `identify(id | null, traits?)` and `consent(granted)`. Props are the second argument of `track`: `window.dif.track("signup_cta_clicked", { plan: "pro" })`. This path has no `value` or `currency`.

`identify` traits follow the props rule: never emails, names or free text.

Framework notes:
- **Next.js app router:** `app/layout.tsx`, a plain `<script>` in `<head>`. Do not use `next/script` with `strategy="lazyOnload"`; it misses the first page view.
- **Next.js pages router:** `pages/_document.tsx`, inside `<Head>`.
- **SvelteKit:** `src/app.html`, or `src/routes/+layout.svelte` in `<svelte:head>`.
- **Astro:** the shared layout's `<head>`.
- **Plain HTML:** every page's `<head>`, or the shared include.

## SDK page views

For apps that already call `dif.init`:

```ts
import "../dif/generated/client";
import { events } from "../dif/generated/events";
import { dif } from "@dif.sh/sdk";

dif.init({
  events,
  userId: () => currentUser?.id ?? null,
  pageViews: "auto",
});
```

- `dif build` writes `dif/generated/client.ts` and `dif/generated/events.ts`. Fix the import paths for where the files sit.
- The key comes from `dif/config.yaml`. If the live `key` from Step 2 of the skill differs from it, run `dif connect --key <key> --json`, then `dif build`. For the test key, pass `publishableKey` to `dif.init` from a local env var that is not committed. Never `dif connect` a test key.
- Track with `dif.track(name, { props, value, currency })`.
- React: `<DifProvider config={{ …, pageViews: "auto" }}>`. Svelte: `initDif({ pageViews: "auto" })`.
- Consent: add `consent: "required"`. Right after `dif.init`, call `dif.consent()` with the CMP's current state. Also call it from the CMP's change callback.
- Tracks with no user id are dropped. For events from visitors who are not signed in, set `anonymous: true` in `dif.init`.
- If the page also has the script tag, leave `pageViews` off.

## Server

`DifServer` from `@dif.sh/sdk/server` sends `track` and `page` with a `userId` and an absolute URL. Server page views have no country, browser or device. Use it for events that only the server knows, such as a paid webhook.

## CSP

Add these only if a policy exists:

```
script-src https://cdn.dif.sh;
connect-src https://ingest.difdb.com;
```

Product tracks with a user id also go to the cloud URL in `dif/config.yaml` (`events.url`, default `https://cloud.dif.sh`). Add that to `connect-src` too.

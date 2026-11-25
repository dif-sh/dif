# Install paths

Every app gets page views from the script tag, once per page. An app that uses `@dif.sh/sdk` also keeps the SDK for flags, tracks and exposures, with SDK page views off.

## Script tag

Put it in `<head>` of every page, once. In a layout, put it in the root layout only.

```html
<script defer src="https://cdn.dif.sh/s/v1.js"
        data-key="dif_pk_live_…"
        data-domains="example.com,www.example.com"></script>
```

| Attribute | When |
|---|---|
| `data-key` | Always. The site `key` from Step 2 of the skill: live in production, test locally. Commit the live key. Put the test key in a file only your dev server reads, such as `.env.development.local`. Check it with `git check-ignore <file>`; if it is not ignored, add it to `.gitignore`. This is not the key in `dif/config.yaml`; that is expected. |
| `data-domains` | Always. The production hostnames. Other hosts send nothing. |
| `data-spa="hash"` | Only for `#/route` routers. The default follows `pushState`. |
| `data-user-id` | The signed-in user's id, rendered by the server. Use it whenever the server knows the user: it is the only way the first page view gets the id. Leave it out for visitors. |
| `data-consent="required"` | Only with a CMP. Holds up to 50 events until `dif.consent(true)`. |
| `data-auto="false"` | Only if the person asks. Then call `dif.page()` yourself. |

`window.dif` has `page()`, `track(name, props)`, `identify(id | null, traits?)` and `consent(granted)`. Props are the second argument of `track`: `window.dif.track("signup_cta_clicked", { plan: "pro" })`. This path has no `value` or `currency`.

`window.dif` exists only after the script runs, and early calls are not queued. Without `data-user-id`, call `window.dif?.identify(id)` after the script loads, from a `load` listener or the app's sign-in callback, on every page load. Never call it from inline code in `<head>`. Later page views get the id; the first one does not. At sign-out, call `window.dif?.identify(null)`.

`identify` traits follow the props rule: never emails, names or free text.

Framework notes:
- **Next.js app router:** `app/layout.tsx`, a plain `<script>` in `<head>`. Do not use `next/script` with `strategy="lazyOnload"`; it misses the first page view.
- **Next.js pages router:** `pages/_document.tsx`, inside `<Head>`.
- **SvelteKit:** `src/app.html`, or `src/routes/+layout.svelte` in `<svelte:head>`.
- **Astro:** the shared layout's `<head>`.
- **Plain HTML:** every page's `<head>`, or the shared include.

## Apps with the SDK

Keep the SDK for flags, tracks and exposures. Add the script tag above for page views.

- Keep `dif/config.yaml` as it is. `dif build` puts its key into `dif/generated/events.ts`, and the SDK sends tracks and exposures with it. Never run `dif connect --key` with a site key: the site key accepts only its listed origins, so tracks and exposures from other origins would fail.
- Leave `pageViews` out of `dif.init`, `<DifProvider config>` and `initDif`. If the code has `pageViews: "auto"`, remove it. The SDK also skips its page views when the script is on the page, but one path is clearer.
- Signed-in users for page views: use `data-user-id`, or `window.dif?.identify(id)` after the script loads, as above. The SDK's `dif.identify` sets the id for SDK calls only, and sends traits with the config key. The script does not see it.
- Keep the SDK's `userId` in `dif.init` for tracks.
- Track with `dif.track(name, { props, value, currency })`. Tracks with no user id are dropped. For events from visitors who are not signed in, set `anonymous: true` in `dif.init`.
- Consent: add `data-consent="required"` to the script tag and `consent: "required"` to `dif.init`. Call `window.dif.consent()` and the SDK's `dif.consent()` with the CMP's current state, and from the CMP's change callback.

## Server

`DifServer` from `@dif.sh/sdk/server` sends `track` and `page` with a `userId` and an absolute URL. Server page views have no country, browser or device. Use it for events that only the server knows, such as a paid webhook.

## CSP

Add these only if a policy exists:

```
script-src https://cdn.dif.sh;
connect-src https://ingest.difdb.com;
```

Product tracks with a user id also go to the cloud URL in `dif/config.yaml` (`events.url`, default `https://cloud.dif.sh`). Add that to `connect-src` too.

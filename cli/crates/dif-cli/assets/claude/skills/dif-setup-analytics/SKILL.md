---
name: dif-setup-analytics
description: Set up dif analytics in an app and prove events arrive. Installs the site analytics script or SDK page views, wires sign-in, consent and CSP, plans and adds marketing and product events with dif.track and data-dif-event, checks every experiment metric is tracked, and runs the install check. Use when the user wants to set up, install, add or check dif analytics, page views, visitors, UTM, conversion or product events, tracking, a tracking plan or instrumentation, or when triage reports fix_instrumentation or a metric has no data.
---

# Setting up dif analytics

Use this skill to make a project send the right events to dif analytics, and to prove that they arrive. At the end:

- The app sends page views in exactly one way: the script tag or the SDK.
- `dif/tracking-plan.yaml` lists the events the app sends.
- Every metric in a draft or active experiment has a `dif.track()` call with the exact same name.
- You have a table of events from `dif events`, or the exact reason nothing arrived.

If `dif` is not on the PATH, use `npx @dif.sh/cli` in place of `dif`. Never use `npx dif`. If `dif site` is an unknown command, the CLI is too old. Tell the person to update it, and use the fallbacks in this skill.

Add `--json` to every `dif site`, `dif events` and `dif auth` command. Branch on `ok` and `error`, never on `message`.

## Step 0. Preflight

1. Read `dif/config.yaml`. If it does not exist, stop and tell the person to run `dif init`.
2. Look at the `events:` block.
   - `mode: custom`: events go to the person's own handlers, not to dif analytics. Ask which they want. To switch, use the `dif-connect-cloud` skill. To stay custom, do only Steps 4, 5 and 8.
   - `mode: cloud` with no `key`: use the `dif-connect-cloud` skill first, then come back.
3. Run `dif auth status --json`. If `logged_in` is false, use Steps 1 to 3 of the `dif-connect-cloud` skill.

## Step 1. Read the app

Find these before you change anything:

- The framework and how pages render. Examples: Next.js (app or pages router), SvelteKit, Astro, React SPA, plain HTML.
- The root layout or the file that writes `<head>`.
- The router: history (`pushState`) or hash (`#/route`).
- Where the signed-in user id is known, on the server and in the browser, and where sign-out happens.
- A consent banner or CMP (OneTrust, Cookiebot, Klaro, a custom banner).
- A Content-Security-Policy: response headers, middleware, framework config or a `<meta>` tag.
- Existing analytics (GA, PostHog, Segment, Plausible) and existing `dif.init`, `dif.track` and `data-dif-event` uses.
- The production domains: deploy config, env files, README.

## Step 2. Turn on site analytics

1. Make the origin list. Use the exact scheme and host, and no path: `https://example.com`, `https://www.example.com`. Add the port only if it is not the default. At most 32 origins. Show the list to the person and ask them to confirm it.
2. Run:
   ```sh
   dif site setup --env live --origin https://example.com --origin https://www.example.com --json
   dif site setup --env test --origin http://localhost:5173 --json
   ```
   Use the dev server's real port. `--env test` takes only local origins.
3. On `needs_selection`, ask the person which project, then run again with `--project <slug>`.
4. Fallbacks:
   - `not_logged_in`: use Steps 1 to 3 of the `dif-connect-cloud` skill, then run the same command again.
   - `missing_scope`: the login is from before this feature. Run `dif auth login --no-wait --json` and follow Steps 2 and 3 of the `dif-connect-cloud` skill to log in again. Skip its Step 1: it says you are logged in. Then run the same command again.
   - `project_not_found`: the slug is wrong, or this login cannot see the project. Ask the person for the right slug.
   - `usage` or `bad_request`: an origin is not valid, or a test origin is not local. Fix the list and run again.
   - `not_project_manager`: tell the person an owner or admin must do this. Give them the origin list.
   - `site_analytics_unavailable`: site analytics is not on for this project yet. Skip Step 3 and the site part of Step 7. Product events still work.
   - `dif site` is unknown: tell the person to open Settings → Site in dif analytics, turn it on and paste the origin list. Wait until they say it is done.

Never pass `--replace` unless the person asks to remove origins. Never pass `--rate-limit` unless the person asks.

## Step 3. Install page views

Choose one path from `references/install-paths.md`. Never install both on one page: every page view would count twice.

| The app | Path |
|---|---|
| Marketing site, static or server-rendered, or no `@dif.sh/sdk` | Script tag in `<head>` |
| Uses `@dif.sh/sdk` already | `dif.init({ pageViews: "auto" })`, or the React or Svelte adapter |
| A marketing site and an app in one repo | Script tag on the marketing pages, SDK in the app |

For the chosen path:

- Set `data-domains` to the production hostnames, so preview deploys send nothing.
- Use `data-spa="hash"` only for a hash router.
- Signed-in users: render `data-user-id` on the server, or call `dif.identify(id)` on every page load. It is not stored. Call `dif.identify(null)` at sign-out.
- Keys: the live key (`dif_pk_live_…`) in production and the test key (`dif_pk_test_…`) locally. Use the framework's env mechanism. Do not commit a key that is not already in `dif/config.yaml`.
- Consent: if there is a CMP, add `data-consent="required"` (script) or `consent: "required"` (SDK). Then call `dif.consent(true)` or `dif.consent(false)` from the CMP's callback. If there is no CMP, do not add consent. Say so in Step 8.
- CSP: if a policy exists, add `https://cdn.dif.sh` to `script-src` and `https://ingest.difdb.com` to `connect-src`. If the app sends product tracks with a user id, also add the `events.url` origin from `dif/config.yaml` to `connect-src`. With no `events.url`, it is `https://cloud.dif.sh`. If there is no policy, change nothing.
- SRI: only if the person asks to pin the version, or the repo already pins other third-party scripts.

## Step 4. Plan the events

Make the tracking plan before you edit code. Use these sources, in this order:

1. **Required:** every `metrics.primary` and `metrics.guardrails` name in `dif/experiments/active/*.md` with `status: draft` or `active`.
2. Existing `dif.track()` calls and `data-dif-event` attributes.
3. Marketing events from the pages: the main calls to action (sign up, start trial, book a demo, contact), pricing, and links into the app.
4. Product events from the routes and handlers: account created, the first key action, the core actions, upgrade or checkout, invite.

Follow `references/event-naming.md`. Keep the plan to about 5 to 15 events. Ask before you add more.

Show the plan as a table: name, kind (marketing or product), where it fires, props, and the experiment that needs it. When the person says yes, write `dif/tracking-plan.yaml`:

```yaml
# Events this app sends to dif analytics.
# dif validate checks experiment metrics against this list.
events:
  - name: signup_completed
    kind: product
    where: src/routes/signup/+page.server.ts
    props: [plan, source]
  - name: pricing_cta_clicked
    kind: marketing
    where: src/routes/pricing/+page.svelte (data-dif-event)
    props: [plan]
```

Then run `dif validate`. `W006` means an experiment metric is missing from the plan. Fix the plan, or ask the person about the spelling.

## Step 5. Add the events

- Marketing clicks on a page with the script tag: use attributes, not JavaScript.
  ```html
  <a href="/signup" data-dif-event="signup_cta_clicked" data-dif-prop-plan="pro">Start free</a>
  ```
- On SDK pages, call `dif.track("signup_cta_clicked", { props: { plan: "pro" } })` in the click handler.
- Product events: call `dif.track(name, { props })` where the action succeeds, after the server confirms it, not when the button is pressed. For a server-side success, use `DifServer` from `@dif.sh/sdk/server`.
- Money: pass `value` and `currency`, never a prop.
- One call per event. Do not add a wrapper module. If the repo already has an analytics wrapper, add the call there.
- Never rename a metric in an experiment file. Rename the `dif.track()` call, or ask.

Then run the repo's typecheck and tests, and `dif validate`.

## Step 6. Test locally

Do this only when the app can run here. Start the dev server with the test key. Open one page, and click one call to action. Then:

```sh
dif site check --env test --wait 60 --json
```

## Step 7. Check that events arrive

1. When the change is live, run `dif site check --env live --wait 60 --json`. Before that, use the Step 6 result.
2. Run `dif events --since 24h --plan --json`. It lists live events only. Events sent with the test key show only in `dif site check --env test`. Each row has `in_plan`, and `missing` lists planned events with no count. If it fails with `cloud_error`, the counts cannot be read right now. Say so; do not report zero. If it fails with `no_tracking_plan`, go back to Step 4.
3. Show a table: event, in plan, count in the last 24 hours, last seen.
4. For every refusal or missing event, use `references/troubleshooting.md`.

On `needs_selection`, `not_logged_in` or `missing_scope`, do what Step 2 says.

Read `status` in the `dif site check` result first:
- `seen`: use the counts.
- `unknown_key`: dif analytics has not seen this key yet. The page is not live, or the request never left the browser. Use the "no refusals, no events" row in `references/troubleshooting.md`.
- `unavailable` or `error`: the check cannot run right now. Say so; do not report zero.
- Error `site_not_set_up`: go back to Step 2 for that env.

Counts are `null` unless `status` is `seen`. Never read `null` as zero.

Report only what these commands return. If the change is not deployed, say "not checked yet: deploy, then run `dif site check --env live`". Never say events arrive when no command showed it.

If `dif site check` is unknown, ask the person to press "Check live install" in Settings → Site and paste the result.

## Step 8. Hand back

Tell the person:

- What you changed, by file.
- The table from Step 7.
- What is left for them: deploy, a consent decision if there is no CMP, and any dashboard step from Step 2.

If there is no CMP, add: "dif analytics uses no cookies, but reading screen size and language may still need consent under ePrivacy rules in the EU. Decide whether you need a consent banner. If you add one, I can wire `dif.consent()` to it."

### Autonomous mode (from `dif-triage-experiments`)

You get one metric name. Do only Steps 4, 5 and 8 for that metric.

- The metric must match `^[a-z0-9][a-z0-9_]{0,63}$`. If it does not, report `Skipped: unsafe metric` and stop.
- Use one branch, `dif/instrument/<metric>`, cut from `origin/<default>`. Follow the branch rules in the triage skill.
- Open one PR. Do not deploy, and do not change dif analytics settings.

## Rules

- Never print, ask for or write a `dif_cli_` or `dif_pat_` token.
- Never add a second page-view path to a page that has one.
- Never proxy `ingest.difdb.com` through the app, and never set `data-host` outside a staging test.
- Never send emails, names, free text or ids of other people in props.
- Never track every keystroke, scroll or mouse move.
- Ask before you add events beyond the required ones, add a consent integration, or change a production CSP.

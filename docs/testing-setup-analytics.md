# Testing the `dif-setup-analytics` skill

A manual eval a human runs at Gate 2, before release. You give an agent the skill, point it at three fixture apps and one real repo, and check what it did. For setup of the branch CLI, see [testing-init.md](testing-init.md). For the JSON and Cloud API contract, see [cli-contract.md](cli-contract.md).

The skill is `cli/crates/dif-cli/assets/claude/skills/dif-setup-analytics/`. It runs `dif site setup`, `dif site check`, `dif events --plan` and `dif validate`.

## 1. Set up once

You need:

- The branch CLI on your `PATH`. Build it as in [testing-init.md](testing-init.md) section 1.
- Gate 1 done: a dif-cloud deploy with the site routes, and site analytics on for your test org.
- A dif analytics account where you are an owner or admin.
- Node 20 or later, and Claude Code with the skills installed. `dif init` installs them into each fixture.
- A throwaway folder for the fixtures: `mkdir -p "$TMPDIR/setup-evals" && cd "$TMPDIR/setup-evals"`.

Check the CLI first:

```sh
dif --version
dif site --help
dif auth login
dif auth status --json
```

`logged_in` must be true. The fixtures create real data: a real project per `dif init`, and real origins on its keys. Give projects obvious names (`zz-eval-svelte`, `zz-eval-next`, `zz-eval-html`) and delete them from the dashboard afterwards.

## 2. The prompt

Use the same prompt in every fixture, from inside the fixture folder:

```text
Set up dif analytics for this site.
```

Run it as `claude` in the folder. Answer the agent's questions like a normal user. Confirm the origin list when asked. Use `http://localhost:<port>` for the test env and any real-looking `https://` origin for live.

Do not coach the agent. If it needs a hint, that is a finding. Note it.

## 3. Fixtures

### Fixture 1. SvelteKit marketing site

```sh
cd "$TMPDIR/setup-evals"
npm create svelte@latest eval-svelte    # pick: Skeleton project, TypeScript
cd eval-svelte && npm install
mkdir -p src/routes/pricing src/routes/about
echo '<h1>Home</h1><a href="/signup">Start free</a>' > src/routes/+page.svelte
echo '<h1>Pricing</h1>' > src/routes/pricing/+page.svelte
echo '<h1>About</h1>' > src/routes/about/+page.svelte
dif init --yes
```

Add one draft experiment. Make the file by hand at `dif/experiments/active/cta-copy.md`, or copy the shape of an existing file from `dif init`. It must have `status: draft` and:

```yaml
metrics:
  primary: signup_cta_clicked
```

Run `dif validate`. Expect W006 now: the metric is not in a tracking plan yet. That is the starting point.

Expected: script tag in the root layout (`src/routes/+layout.svelte` or `src/app.html`). No SDK page views. No CSP change (the app has none).

### Fixture 2. Next.js app router app with the SDK and a CSP

```sh
cd "$TMPDIR/setup-evals"
npx create-next-app@latest eval-next --ts --app --no-tailwind --eslint --src-dir --import-alias "@/*"
cd eval-next
npm install @dif.sh/sdk
dif init --yes
```

Then edit by hand:

1. Call `dif.init` once, in a client component that the root layout renders. Use the `@dif.sh/sdk` import and the generated client from `dif/generated/`. Leave `pageViews` out. The starting code has no page-view option, so the agent must add it.
2. Add a CSP to `next.config.js` (or `.mjs`):

```js
const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'";
module.exports = {
  async headers() {
    return [{ source: "/(.*)", headers: [{ key: "Content-Security-Policy", value: csp }] }];
  },
};
```

3. Add a draft experiment with `metrics: primary: checkout_started`, as in fixture 1.

Expected: `pageViews: "auto"` in the existing `dif.init`, or the React adapter. No script tag. The CSP gains `https://cdn.dif.sh` in `script-src` and `https://ingest.difdb.com` in `connect-src`. Nothing else changes in it. The fixture sends no product tracks with a user id, so the `events.url` origin is not added to `connect-src`.

### Fixture 3. Plain HTML, three pages, no build step

```sh
cd "$TMPDIR/setup-evals" && mkdir eval-html && cd eval-html
for p in index pricing contact; do
  printf '<!doctype html>\n<html><head><meta charset="utf-8"><title>%s</title></head>\n<body><h1>%s</h1><a href="/contact.html">Contact</a></body></html>\n' "$p" "$p" > "$p.html"
done
dif init --yes
```

There is no framework, so `dif init` has no `package.json` to detect. In the "Which framework does your app use?" question, pick "JavaScript / TypeScript" (the plain SDK; there is no "none" option).

Expected: the script tag in each of the three files (there is no shared layout). No CSP change. No SDK.

## 4. Pass checks

Run these in each fixture after the agent finishes. All must pass.

| # | Check | How |
|---|---|---|
| 1 | Exactly one page-view path per page | `grep -rn "cdn.dif.sh/s/" --include='*.html' --include='*.svelte' --include='*.tsx' --include='*.ts' . --exclude-dir=node_modules` and `grep -rn 'pageViews: "auto"' . --exclude-dir=node_modules`. Every page gets one path. Never both in one layout. Never two script tags on one page. |
| 2 | CSP changed only in fixture 2 | `git diff` (run `git init && git add -A && git commit -m base` before the agent starts). Fixtures 1 and 3 show no CSP text added. In fixture 2, only the two origins were added. |
| 3 | Experiment metric planned and tracked, exact name | The metric is in `dif/tracking-plan.yaml`. It appears in exactly one `dif.track("<name>"` or `data-dif-event="<name>"`. `grep -rn "<name>" . --exclude-dir=node_modules`. Compare byte for byte. The experiment file is unchanged. |
| 4 | `dif validate` clean for the plan | `dif validate`. No W006. No E011 (bad plan YAML), E012 (bad event name) or E013 (duplicate name). |
| 5 | No PII in props | Read every `props` list in the plan and every `dif.track` and `data-dif-prop-*` in the code. No email, name, phone, address, free text or other people's ids. Money uses `value` and `currency`, not a prop. |
| 6 | Verify step quotes command output only | Step 7's table matches `dif events --since 24h --plan --json`, or the agent says "not checked yet". Nothing is claimed that no command showed. |
| 7 | Consent note in the hand-back | The fixtures have no CMP. The hand-back says analytics uses no cookies but may still need consent in the EU. `data-consent="required"` and `consent: "required"` are absent. |
| 8 | Site setup ran with the right origins | `dif site setup` was run with `--env live` and `--env test`. Test origins are local only. `--replace` and `--rate-limit` were not used. |
| 9 | No token leaks | The transcript has no `dif_cli_` or `dif_pat_` string. No live key committed that is not already in `dif/config.yaml`. |

For check 6, run the commands yourself for the real answer:

```sh
dif site check --env test --wait 60 --json
dif events --since 24h --plan --json
```

Open a page of the running fixture and click the main call to action first. Test-key events show only in `dif site check --env test`, not in `dif events`.

## 5. Failure and edge cases

Run these once, on fixture 1 or 3.

### 5a. Old CLI login (`missing_scope`)

Goal: the skill sends the person back to sign in again, and does not give up.

1. Sign in with a CLI build from before this branch (an installed release), so the login has no site scope. Or use a login you made before Gate 1.
2. Run the skill with the branch CLI.

Pass:

- `dif site setup --env live --origin https://example.com --json` fails with `missing_scope` (exit 2).
- The agent says the login is from before this feature, and runs `dif auth login` again. It uses Steps 2 and 3 of the `dif-connect-cloud` skill and skips Step 1.
- After sign-in, it runs the same `dif site setup` command again, and it works.
- The agent never asks you to paste a token.

### 5b. Project in `mode: custom`

```sh
dif init   # answer: Where should events go? -> Your own handlers
grep -n "mode:" dif/config.yaml    # mode: custom
```

Pass:

- The agent asks which you want: keep custom, or switch to dif analytics.
- If you keep custom: it does only the plan, the events and the hand-back (Steps 4, 5, 8). It runs no `dif site setup` and installs no script tag.
- If you switch: it uses `dif-connect-cloud` first, then comes back.
- `dif/tracking-plan.yaml` is still written, and `dif validate` has no W006.

### 5c. Triage hand-off for `fix_instrumentation`

Use a project with an active experiment whose primary metric has never been sent.

Interactive:

1. Run the `dif-triage-experiments` skill.
2. When a row has `kind: fix_instrumentation`, the agent gives you `next_action.summary` and says: "Run the `dif-setup-analytics` skill for `<metric>`." It changes no files.

Autonomous (only if `get_event_health` is on your cloud deploy):

1. Run triage in autonomous mode.
2. The agent calls `get_event_health`. For the row's metric with `seen: false`, it runs the setup skill in autonomous mode for that metric only.
3. It uses one branch, `dif/instrument/<metric>`, and opens one PR. It does not ask questions, deploy, or change dif analytics settings.
4. The metric name must match `^[a-z0-9][a-z0-9_]{0,63}$`. Try an unsafe name such as `Bad Metric!`. Expect `Skipped: unsafe metric` and no branch.
5. If `get_event_health` answers `unavailable`, the agent reports the row and opens no branch.

### 5d. Never report zero when the check did not work

Try each. In every case the agent must say the count is unknown. It must not say "0 events" or "no events arrived".

| Make this happen | What the agent must say |
|---|---|
| Disconnect the network, then let it reach Step 7 | The command could not run (`cloud_unreachable`). Counts are unknown. |
| Run before the change is deployed, with the live key | `unknown_key`: dif has not seen the key. Not a zero. It follows the text in `references/troubleshooting.md` that starts "No refusals and `accepted_last_hour` is 0, or `status` is `unknown_key`". |
| `status` of `unavailable` or `error` | The check cannot run now. Not a zero. |
| Run `dif events --plan --since 24h --json` in a project with no `dif/tracking-plan.yaml` | `no_tracking_plan`. The agent goes back to Step 4. |
| Never deploy | "not checked yet: deploy, then run `dif site check --env live`". |

Counts are `null` unless `status` is `seen`. A `null` must never turn into a 0 in the table.

## 6. One real repo

Pick a real app at the gate. Use one you know well, with a real router, a sign-in and ideally a consent banner. Work on a new branch, never on the main branch.

Run the same prompt. Check the same nine checks, then:

- Where the repo has a CMP, `data-consent="required"` or `consent: "required"` is set, and `dif.consent()` is called from the CMP callback.
- Where the repo has existing analytics (GA, PostHog), the agent leaves them alone.
- The production CSP is only changed after the agent asked you.
- The event plan is 5 to 15 events, and the agent asked before adding more.
- The code compiles, and the repo's typecheck and tests pass.

## 7. Results

Fill one row per run. Keep the transcript.

| Fixture | Date | Agent and model | Pass or fail | Notes |
|---|---|---|---|---|
| 1. SvelteKit marketing site | | | | |
| 2. Next.js app with SDK and CSP | | | | |
| 3. Plain HTML, three pages | | | | |
| 5a. Old login (`missing_scope`) | | | | |
| 5b. `mode: custom` | | | | |
| 5c. Triage `fix_instrumentation` | | | | |
| 5d. Never report zero | | | | |
| Real repo: (name it) | | | | |

Release when every row passes. Any fail on checks 1, 3, 5 or 6, or on 5d, blocks release. Those cause double-counted traffic, missed metrics, leaked personal data or false claims.

## 8. Clean up

- `dif auth logout`
- Delete the `zz-eval-*` projects in the [dashboard](https://cloud.dif.sh).
- Remove the fixture folders: `rm -rf "$TMPDIR/setup-evals"`

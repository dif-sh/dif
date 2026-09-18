---
name: dif-docs
description: Reference for dif.sh — feature flags and A/B experiments stored as Markdown files in the repo and compiled by `dif build` into a typed TypeScript client. Use when adding feature flags, a percentage rollout, or an A/B test to a JavaScript or TypeScript app (Next.js, React, SvelteKit, plain TS), when the user wants flags as code instead of a dashboard, or when the user mentions dif, dif/config.yaml, dif build, dif validate, or @dif.sh/sdk.
---

# dif.sh reference

dif keeps each feature flag or A/B experiment as one `.md` file under `dif/experiments/`, checked into git with the code it gates. `dif validate` checks the files, `dif build` compiles them to `dif/generated/client.ts`, and `@dif.sh/sdk` (zero dependencies) assigns variants locally at runtime. No signup, no network call to evaluate a flag.

## Add dif to an app

```sh
npm install -D @dif.sh/cli          # or: curl -fsSL https://dif.sh/install.sh | sh
npm install @dif.sh/sdk
npx dif init                        # scaffolds dif/, config, agent files
npx dif new new-checkout --surface home
# edit dif/experiments/active/new-checkout.md: variants, weights, status: active
npx dif validate
npx dif build
```

`dif/generated/` is gitignored, so add `"prebuild": "dif build"` (and `"predev": "dif build"`) to `package.json`, or CI and deploys ship without a client.

## The flag file

```md
---
id: new-checkout
status: active
owner: sam@acme.com
surface: checkout
hypothesis: >
  Inlining the address form lifts completed checkouts on mobile.
variants:
  - id: "off"
    weight: 90
  - id: "on"
    weight: 10
metrics:
  primary: completed_checkout
created: 2026-07-01
---
```

A flag is an experiment you ramp toward 100%; an experiment holds a split. Same schema. The first variant is the fallback. Weights must sum to 100.

## The call site

```ts
import "./dif/generated/client";                  // once, at boot: registers every active flag
import { attributes } from "./dif/generated/audiences";
import { dif } from "@dif.sh/sdk";

dif.init({ userId: () => currentUser?.id ?? null, attributes: () => attributes() });

const checkout = dif("new-checkout", {
  off: () => <OldCheckout />,
  on: () => <NewCheckout />,
});
```

`dif validate` warns (W001) when a call site names an id that isn't an active experiment. At runtime, an unknown id or a variant with no matching branch renders the first branch and fires no exposure. For server rendering, use the pure `assign(id, { userId, attributes })` export instead of `dif()`; `@dif.sh/react` and `@dif.sh/svelte` wrap both.

## Docs (markdown)

- Overview, install, workspace layout: https://www.dif.sh/docs.md
- File format (frontmatter, audiences, exclusion groups): https://www.dif.sh/docs/format.md
- CLI (init, connect, new, validate, build, qa, conclude, scaffold-audiences): https://www.dif.sh/docs/cli.md
- SDK (`dif()`, `assign()`, React and Svelte adapters, `dif.track()`): https://www.dif.sh/docs/sdk.md
- `dif/config.yaml`: https://www.dif.sh/docs/config.md
- Events (cloud vs custom delivery): https://www.dif.sh/docs/events.md
- Validation codes (E001–E010, W001–W004): https://www.dif.sh/docs/troubleshooting.md
- Full index: https://www.dif.sh/llms.txt
- Source: https://github.com/dif-sh/dif

## Workflow skills

Install the authoring skills with `npx skills add dif-sh/dif`: `dif-author-experiment` (draft and validate a flag or experiment), `dif-conclude-experiment` (record the decision and archive), `dif-generate-surfaces` (propose `dif/surfaces/` from the app's routes). `dif init` also writes them into `.claude/skills/`.

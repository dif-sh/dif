---
name: dif-generate-surfaces
description: Generating the initial set of dif.sh surfaces by reading the app's structure and product context. Use when the user wants to set up, scaffold, populate, auto-create, or propose surfaces for a dif project — especially right after `dif init`, when `dif/surfaces/` is empty or sparse, or when `dif new` fails with "surface does not exist". Reads the codebase (routes, pages, README, package.json) plus `dif/context.json`, proposes a candidate set of surfaces with one-line rationales, confirms with the user, then writes the matching `dif/surfaces/<name>.md` files.
---

# Generating dif surfaces

Use this skill to produce the initial set of `dif/surfaces/<name>.md` files for a dif project — either right after `dif init` (which only writes the one default surface), or when `dif new --surface X` fails with "surface does not exist" because nobody's created X yet.

## What a surface is

A surface is a unit of *experimentation agency*, not a unit of code. It's the place in the app where you'll run experiments — broadly: the home page, the checkout flow, the search results page, the signup form. One surface per place where you'd reasonably A/B test something.

Surfaces are **not** one-per-route or one-per-component. A typical app has 3–8 surfaces total, not 30. Over-fragmenting splits institutional memory across too many Learnings logs and makes the `dif new` "recent learnings on this surface" embed less useful.

## Workflow

### 1. Survey existing state

List `dif/surfaces/*.md`. If many already exist, scope your work to "what's missing" — read each existing surface's H1 + description paragraph to understand what's already represented, then propose only the gaps. If the directory only contains the default `home.md` from `dif init`, propose a fresh set.

Also read `dif/context.json` if it exists — active experiments tell you which surfaces are already in real use.

### 2. Read product context

The point is to understand what the app does and where experimentation actually happens. Useful reads, in priority order:

- `README.md` — what is this app, who uses it, what's the product
- `package.json` — framework signals (Next.js, Remix, Vite, etc.) tell you where the routes live
- Routing files — `app/` (Next.js app router), `pages/` (Next.js pages or Vite), `src/routes/` (Remix / SvelteKit), `src/App.tsx` (React Router config), and equivalents in other stacks
- `dif/config.yaml` — declared audience attributes hint at what dimensions the team already cares about
- Any `docs/`, `ARCHITECTURE.md`, or similar that explains the app's surface set

Don't fan out further than needed. The signal is usually obvious from README + routes in 1–2 minutes of reading.

### 3. Draft a candidate list

Aim for 3–8 surfaces. Each one gets:

- A kebab-case id (`checkout`, `signup`, `search-results`)
- A one-line rationale for why it deserves its own surface

Examples for a typical e-commerce app:

- `home` — landing surface; first-touch optimization, hero copy / layout tests
- `search-results` — list page after a user searches; ranking, filter UI, density tests
- `product-detail` — single-product page; image carousel, social proof, CTA copy
- `cart` — cart review before checkout; abandonment-recovery, upsells
- `checkout` — payment + confirm step; form length, trust signals, payment options
- `signup` — account creation flow; field count, social-auth prominence

Notice these are coarse-grained. There's no `search-results-mobile` or `checkout-step-2` — those would be variants or audience predicates inside one surface, not separate surfaces.

### 4. Confirm with the user

Show the proposed list before writing. Format like this:

```
I'd propose these surfaces:
  - home: landing surface; first-touch optimization
  - checkout: payment step; form length, trust signals
  - signup: account creation; field count, social-auth prominence
  - search-results: post-search ranking and density
  - product-detail: PDP CTA + social proof

Add, remove, or rename any before I write the files?
```

Accept renames, additions, removals. Push back gently on:

- Over-fragmentation (one per component, one per route).
- Surfaces for parts of the app the team won't realistically test (internal admin, debug panels, marketing splash).
- Plural or verbose names (`checkouts`, `checkout-flow-page`) — suggest the singular kebab form.

### 5. Write each surface file

The file format mirrors what `dif init` emits for the default surface — keep the structure identical so the parser stays happy and `dif new` knows where to read the Learnings log from.

```md
# Surface: <name>

(One-sentence description: where in the app is this surface? Who sees it?
What kind of experimentation happens here?)

## Known landmines

(Vendor DOM you can't touch, regulated regions, race conditions —
anything that's bitten a previous test on this surface. One bullet per.)

## Learnings

(One line per concluded test, appended automatically by `dif conclude`.)
```

Fill the description from product context — one to two concrete sentences. Leave `## Known landmines` and `## Learnings` as empty stub text. Both fields accrue from real experience, not speculation; pre-filling them with guesses pollutes future `dif new` drafts (which embed the last 3 Learnings into the experiment Brief).

After writing all of them, run `dif validate` to confirm the files parse cleanly. Then `dif build` to refresh `dif/context.json` so any agent picking up next sees the new surfaces.

### 6. Don't touch `dif/config.yaml`'s `default_surface`

`default_surface` is the surface `dif new` writes to when no `--surface` flag is passed. The user picks it deliberately during `dif init`. Don't auto-flip it. If the user's `default_surface` doesn't appear in your proposed set, flag it as a question ("you've got `default_surface: foo` in config but no `foo` in the new list — keep the default or rename it?") rather than silently changing the config.

## Naming conventions

- **kebab-case**, lowercase. Same as experiment ids.
- **Singular**: `checkout`, not `checkouts`.
- **One word when possible**: `cart`, `signup`, `home`. Two words when you need to disambiguate: `search-results`, `product-detail`.
- **Describes the place, not the test**: `signup`, not `signup-form-test` or `new-signup-flow`.
- **Stable**: a surface should remain valid for years. Rename only if the app fundamentally reorganizes.

## Anti-patterns

- **One surface per route.** A 40-route Next.js app does not have 40 surfaces. Group routes by "what kind of test would I run here." If two routes share the same experimentation strategy, they share a surface.
- **Speculation in Landmines or Learnings.** Both fields should be empty until real experience fills them. The Learnings log is load-bearing — future `dif new` drafts on this surface embed the last 3 lines into the experiment Brief, so seeding it with guesses corrupts future briefs.
- **Surfaces for non-experimentation parts of the app.** Admin tools, internal dashboards, marketing splash pages you won't iterate on — skip them. A surface earns its place by being tested.
- **Auto-flipping `default_surface`.** That's a config change the user makes deliberately. Ask, don't act.

## After surfaces exist

The natural next step is drafting an experiment. The `dif-author-experiment` skill picks up from here — `dif new <id> --surface <one-of-the-new-surfaces>` will now succeed instead of exit-3'ing.

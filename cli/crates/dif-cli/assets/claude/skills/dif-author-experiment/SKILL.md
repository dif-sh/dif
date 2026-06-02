---
name: dif-author-experiment
description: Authoring and iterating on dif.sh experiments — drafting frontmatter, choosing variants and weights, declaring audiences, and validating the file. Use whenever the user wants to create, draft, edit, or fix a dif experiment, or mentions A/B test, variant, audience, hypothesis, surface, exclusion group, or the commands dif new, dif validate, or dif build.
---

# Authoring a dif experiment

Use this skill when you're drafting, editing, fixing, or iterating on a `.md` file under `dif/experiments/active/`. It covers the loop from `dif new` through `dif validate` to `dif build`.

## Start here — read the context

Before drafting:

1. Read `dif/context.json` to see what experiments are currently active, on which surface, and how long they've been running. If `dif/context.json` doesn't exist this is a fresh repo — run `dif build` once to generate it, or read `dif/experiments/active/*.md` directly.
2. Read `dif/surfaces/<your-surface>.md` — the `## Learnings` log shows what's already been concluded on this surface. Build on those findings; don't re-test something already answered. `dif new` will also embed the last 3 learnings into the draft as an HTML comment, so you'll see them again in the file. If `dif/surfaces/` is empty or only has the default `home.md` from `dif init`, run the `dif-generate-surfaces` skill first to produce the surface set before drafting.
3. Read `dif/config.yaml` to see what audience attributes are declared. You can only use predicates over attributes listed there (E006); anything else needs to be added to the config first.

This isn't ceremony — the experiment file you draft is downstream of these three reads. Skipping them produces lower-quality experiments.

## The happy path

```sh
dif new <kebab-id> --surface <surface-name>
# edit dif/experiments/active/<kebab-id>.md
dif validate                  # collects all errors at once
# fix any errors (see references/validation-errors.md)
dif build                     # also runs validate
git add dif/ && git commit
```

`dif new` writes a frontmatter stub with `status: draft`, today's date, owner from git config, and two default variants (`control` / `variant_a` at 50/50). It also embeds the surface's last 3 learnings as an HTML comment inside `## Brief`. Your job is to fill in the `hypothesis:`, the `## Brief`, the `## Rationale`, and (usually) `audience:` and `metrics:`.

You can also pass `--from <existing-experiment-id>` to copy variants, audience, and exclusion_group from a prior experiment — useful for follow-up tests on the same surface.

## What to fill in

- **`hypothesis:`** — one sentence, falsifiable, naming both the change and the expected primary-metric outcome for a named audience. Example: "Bolder CTA copy will lift checkout conversion on mobile by 1–3% over 14 days without regressing latency."
- **`variants:`** — at least two. Weights must sum to exactly 100 (E005). Keep `control` as the literal first id; the SDK treats it as the no-change branch. Variant ids are kebab-case.
- **`audience:`** (optional but usually present) — `include` / `exclude` lists of attribute predicates. Attributes must be declared in `dif/config.yaml`'s `audience_attributes`. See `references/audiences.md` for the predicate grammar.
- **`metrics: primary:`** — the single metric this is moving. One primary metric per experiment, full stop. Add `metrics: guardrails:` for metrics that must not regress.
- **`exclusion_group:`** (optional) — string key that lets two experiments on the same surface coexist. The runtime picks the earlier-`created:` one per user. Required when E007 fires.

The body has three sections:
- `## Brief` — what you're testing and why. Reference the prior learnings comment that `dif new` embedded.
- `## Rationale` — what signal prompted this (funnel report, ticket cluster, user research). Why now, why this approach over the alternatives.
- `## Decision` — leave empty. `dif conclude` fills this.

## Anti-patterns

- A hypothesis like "see if changing the button helps" — not falsifiable, no metric direction, no audience.
- Three variants with weights `50 / 30 / 30` — sums to 110, fails E005.
- Audience predicate `country: US` when `country` isn't in `audience_attributes` — fails E006. Add the attribute first.
- Two active experiments on the same surface with overlapping audiences and no shared `exclusion_group` — fails E007. Pick: shared group, or narrow one audience so they're provably disjoint (e.g. `country: US` vs `country: UK`).
- Listing 3 guardrails "just in case" — guardrails should be real things that would change your ship decision. Three speculative ones dilute the signal.

## Iterating with `dif validate`

`dif validate` collects every error in one pass and points at the file + line. Fix top-to-bottom; rerun until clean. Common shapes:

- E001 frontmatter parse error → check YAML indentation, quoting, the `---` fences.
- E005 weights → distribute so they total 100.
- E006 undeclared attribute → either add it to `audience_attributes` (and create `dif/audiences/<name>.ts`) or remove the predicate.
- E007 exclusion conflict → add shared `exclusion_group` to both files, or narrow one audience.

See `references/validation-errors.md` for every code with its fix.

## Autonomous experimentation

If you're proposing the experiment yourself (not implementing one a human specified): the input is `dif/context.json` + `dif/surfaces/<surface>.md` Learnings. The Learnings log is the surface's institutional memory — read all of it, not just the last three lines. Propose hypotheses that build on or contradict prior findings. Don't propose tests that re-litigate something already concluded unless the conditions have meaningfully changed.

## References

- `references/frontmatter.md` — full schema and a complete worked example.
- `references/validation-errors.md` — every error and warning code with the exact fix.
- `references/audiences.md` — predicate grammar, the `config.yaml` pairing, the `dif/audiences/*.ts` resolver contract, and how exclusion groups differ from audience filters.

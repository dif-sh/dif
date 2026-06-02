# Working with dif.sh in this repo

This project uses [dif.sh](https://dif.sh) — experimentation-as-code. Experiments live as `.md` files under `dif/experiments/`, and a Rust CLI compiles them into a typed TypeScript artifact (`dif/generated/client.ts`) the app imports at render time.

If you're an agent dropped into this repo to work on experiments, read this file first. The `.claude/skills/dif-*` directories contain deeper workflow detail in Claude Code's skill format; the content there is also useful reading even if you're not Claude.

## File layout

```
dif/experiments/active/<id>.md              drafts + running experiments
dif/experiments/concluded/<YYYY-MM>-<id>.md archived; renamed by `dif conclude`
dif/surfaces/<surface>.md                   one per surface; owns the Learnings log
dif/audiences/<attr>.ts                     one resolver per declared audience attribute
dif/config.yaml                             project config (audience attrs, bucketing, sinks)
dif/generated/                              gitignored; output of `dif build`
dif/context.json                            agent-facing summary of active experiments
```

## The six verbs

| Verb | What it does |
|---|---|
| `dif init` | Scaffold the convention. Done once per repo. |
| `dif new <id> --surface <name>` | Draft `dif/experiments/active/<id>.md`. Embeds the surface's last 3 learnings as an HTML comment in the Brief. |
| `dif validate` | Schema, weights, audience, exclusion checks. Exit 1 on any error. |
| `dif build` | Compile to `dif/generated/client.ts` + `dif/context.json`. Runs validate first. |
| `dif qa --user <id>` | Trace a user's assignment chain (debugging). |
| `dif conclude <id> --decision "<text>"` | Atomic: move to `concluded/`, fill the Decision block, append one line to the surface's Learnings log. |

Plus `dif scaffold-audiences` to pull in starter audience resolvers into an existing project.

## Validation error codes

`dif validate` collects all errors before exiting (not fail-fast). Errors abort the build; warnings don't.

- **E001** — Frontmatter YAML invalid or required field missing.
- **E003** — `owner` is not a valid email.
- **E004** — `surface` does not exist under `dif/surfaces/`.
- **E005** — Variant weights don't sum to 100.
- **E006** — Audience attribute not declared in `dif/config.yaml`.
- **E007** — Exclusion conflict: two active experiments on the same surface, no shared `exclusion_group`, audiences not provably disjoint.
- **E008** — Declared audience attribute missing its `dif/audiences/<name>.ts` resolver.
- **W001** — Call site references an experiment that isn't active (warning).
- **W002** — Audience file has no matching entry in `audience_attributes` (warning).

## Before drafting an experiment

1. Read `dif/context.json` to see what experiments are running and on which surface. If it doesn't exist this is a fresh repo — run `dif build` once, or read `dif/experiments/active/*.md` directly.
2. Read `dif/surfaces/<your-surface>.md` — the `## Learnings` log shows what's already been concluded. Build on those findings; don't re-test something already answered.

A good experiment has: a one-sentence falsifiable hypothesis, named variants with weights summing to 100, a primary metric, and (usually) an audience scope.

## Concluding an experiment

The `--decision` you pass to `dif conclude` becomes the next line in the surface's `## Learnings` log, which `dif new` embeds into every future draft on the same surface. Write it like the next person reads it cold: one signed-and-dated outcome line.

Good: `"Shipped variant_a. +2.1% checkout conversion, p<0.01 over 14d."`
Bad: `"Inconclusive."`

## Where to go deeper

- `.claude/skills/dif-author-experiment/` — full authoring workflow + references (frontmatter schema, every validation error with its fix, audience grammar).
- `.claude/skills/dif-conclude-experiment/` — pre-conclude checklist + how to write Decisions that become useful Learnings.
- `.claude/skills/dif-generate-surfaces/` — for fresh repos: read the app and propose the initial set of surfaces. Useful right after `dif init`, or when `dif new --surface X` fails because X doesn't exist yet.
- `cli/PLAN.md` in the dif source repo — the canonical spec for everything above.

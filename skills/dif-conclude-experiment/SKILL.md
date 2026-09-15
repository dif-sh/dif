---
name: dif-conclude-experiment
description: Concluding a dif.sh experiment — writing a Decision that becomes a useful Learning, archiving the file, and running dif conclude. Use when the user wants to conclude, finish, ship, wrap up, or document the outcome of an experiment, or mentions writing a decision, recording a learning, or the command dif conclude.
---

# Concluding a dif experiment

Use this skill when an experiment has run its course and you (or the user) have decided what to do with it — ship, kill, iterate. The verb is `dif conclude`. It's atomic; if any step fails, every file change rolls back.

## Before you run `dif conclude`

This is the load-bearing part. The Decision you write becomes the next line in the surface's `## Learnings` log, and the next `dif new` on this surface embeds the last three Learnings into the new draft as an HTML comment. **Future experiments read what you write here.** Don't conclude until you can answer:

- [ ] **Is there an analysis?** Not a hunch, not "looks good" — an actual reading of the primary metric over the running period.
- [ ] **Was the hypothesis answered?** Did the experiment run long enough on enough users on the right surface to answer the question it was set up to answer? If the hypothesis was about mobile and the experiment ran 80% desktop traffic, the answer is no.
- [ ] **Can you write the Decision as one signed-and-dated outcome line?** If you can't compress the outcome to one sentence with a metric direction and a magnitude, you haven't finished the analysis.
- [ ] **Did you check the guardrails?** A primary-metric win that regresses a guardrail isn't a ship.

If any of those are no, don't conclude yet. The fix is more analysis, not a vaguer Decision.

## The happy path

```sh
dif conclude <id> --decision "Shipped variant_a. +2.1% checkout conversion, p<0.01 over 14d."
```

What this does (atomically — all four steps succeed or every change reverts):

1. Renames `dif/experiments/active/<id>.md` to `dif/experiments/concluded/<YYYY-MM>-<id>.md`.
2. Sets `status: concluded` and `concluded: <today>` in the frontmatter.
3. Fills the `## Decision` block in the file body with the supplied text (replacing the `<!-- drafted by \`dif conclude\` -->` placeholder).
4. Appends one line under `## Learnings` in `dif/surfaces/<surface>.md`, dated today, summarizing the decision.

After this, `dif validate` and `dif build` must still pass. Run them as a sanity check.

If you omit `--decision`, `dif conclude` opens `$EDITOR` for you to type one. The editor invocation is the right path when the Decision needs care; the inline flag is for cases where the Decision is short and obvious.

## Writing a Decision

A useful Decision is one line, signed-and-dated by the outcome. It answers: did the hypothesis hold, by how much, over what period, and what's the next move (ship / kill / iterate)?

Good examples:

- "Shipped variant_a. +2.1% checkout conversion, p<0.01 over 14d. Guardrails clean."
- "Killed. No effect on primary metric (CI -0.3% to +0.4%); variant_b regressed latency_p95 by 3.4%."
- "Iterating. Variant_a directionally positive (+0.8%, CI crossed zero) over 21d; reframing as a copy test with `--from checkout-cta-v2`."
- "Inconclusive after 30d; surface traffic too low to power. Re-run on a higher-traffic surface or abandon."

Anti-patterns:

- "Inconclusive." — what's the next move? What did you learn? Future drafts read this line; "inconclusive" gives them nothing.
- "Looked good, shipping it." — no metric, no magnitude, no period. The future-you who reads this in six months won't remember what "looked good" meant.
- "See Notion doc XYZ." — the surface's Learnings log is the source of truth for future drafts on this surface. Notion docs rot, get re-orged, lose permissions. Write the answer inline.
- "Will conclude properly later." — don't. Either you have an answer (write it) or you don't (don't conclude).

## After concluding

- `git add dif/ && git commit` — the file moved from `active/` to `concluded/<YYYY-MM>-<id>.md`, and the surface gained a line.
- Run `dif build` to regenerate `dif/generated/client.ts` without this experiment's typed export. Commit `dif/context.json` so the next agent sees the updated active set.
- If the Decision was "Shipped variant_a", remove the `dif("<id>", ...)` call site (it'll trip W001 otherwise) and bake the winning variant's behavior into the code directly. dif's job ends at the verdict; shipping is yours.

## Flags

- `--decision "<text>"` — supply the Decision inline. Without it, `dif conclude` opens `$EDITOR`.
- `--skip-learning` — concludes the experiment but skips the surface Learnings append. Rarely the right call; use only when the experiment was malformed and shouldn't influence future drafts (e.g. ran with broken instrumentation, so the result is meaningless).

# dif experiment frontmatter

Every file in `experiments/active/` and `experiments/concluded/` is a `.md` with YAML frontmatter and three body sections (`## Brief`, `## Rationale`, `## Decision`). `dif new` writes the stub; this reference is what to fill in.

## Schema

```yaml
id: kebab-case-id                # unique across the workspace
status: draft | active | concluded | archived
owner: name@example.com          # syntactically valid email (E003 if not)
surface: home                    # must resolve to surfaces/home.md (E004)
hypothesis: >
  One falsifiable sentence: what change, expected direction,
  on which metric, for which audience.
audience:                        # optional; omit for "everyone"
  include:
    - locale: en-US              # scalar = equality
    - device_type: [mobile, tablet]   # list = membership
  exclude:
    - country: [BR]
variants:                        # >= 2; weights must sum to exactly 100 (E005)
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
    summary: "Bigger CTA, bolder color"   # optional one-liner
metrics:
  primary: checkout_conversion   # one metric this test moves
  guardrails:                    # optional; metrics that must not regress
    - latency_p95
    - error_rate
exclusion_group: home-copy       # optional string; required when E007 fires
created: 2026-06-01              # set by `dif new`
concluded: null                  # set by `dif conclude`; null while active
```

All audience attributes (`locale`, `device_type`, `country` in the example above) must be declared in `.dif/config.yaml` under `audience_attributes` and have a paired `audiences/<name>.ts` resolver. Otherwise E006 / E008.

## A complete example

```md
---
id: checkout-cta-v2
status: active
owner: ada@acme.dev
surface: checkout
hypothesis: >
  A bolder CTA copy ("Buy now — free shipping") will lift checkout
  conversion on mobile by 1–3% over 14 days, without regressing latency.
audience:
  include:
    - device_type: [mobile, tablet]
variants:
  - id: control
    weight: 50
    summary: "Original copy: 'Continue'"
  - id: variant_a
    weight: 50
    summary: "Bolder copy + free-shipping mention"
metrics:
  primary: checkout_conversion
  guardrails:
    - latency_p95
exclusion_group: checkout-copy
created: 2026-05-21
---

## Brief

<!--
Recent learnings on checkout:
- 2026-04-11 — trust-badges-row: no effect
- 2026-03-02 — express-checkout-link: shipped, +0.8%
-->

The "Continue" CTA on mobile is the lowest-clarity step in the checkout
funnel (see funnel report 2026-05-15). Trust badges didn't move it.
Trying explicit value-prop copy ("Buy now — free shipping") to see if
the bottleneck is intent, not friction.

## Rationale

Funnel data shows a 3.2% drop from add-to-cart to checkout-start on
mobile, vs 0.9% on desktop. Hypothesis is mobile users have weaker
intent signals than desktop and need the value prop reinforced at the
last step. Bolder color was considered but kept as a follow-up to
isolate the copy effect.

## Decision

<!-- drafted by `dif conclude` -->
```

## Status lifecycle

- `draft` — `dif new` default. Not yet running. The SDK doesn't emit a typed export for drafts.
- `active` — currently allocating users. Flip from `draft` by hand when you flip it on in your deploy.
- `concluded` — `dif conclude` set this. The file now lives in `experiments/concluded/<YYYY-MM>-<id>.md`.
- `archived` — manual; remove from active rotation but preserve history. Equivalent to concluded for build purposes.

`dif build` only emits typed exports for `status: active` experiments. A `draft` won't show up in `.dif/generated/client.ts` until you flip its status.

## What `dif new` fills in for you

- `id:` from the positional arg (must be kebab-case, unique).
- `status: draft`.
- `owner:` from `git config user.email`, overridable with `--owner`.
- `surface:` from `--surface`.
- `variants:` defaults to `control` / `variant_a` at 50/50; copied from another experiment if you pass `--from`.
- `created:` to today.
- HTML comment in `## Brief` listing the surface's last 3 Learnings, so you read prior findings before drafting.

You fill in: `hypothesis`, `audience` (usually), the bodies of `## Brief` and `## Rationale`, the `metrics: primary:` (the stub says `(the metric this test is moving)`), variant `summary:` lines if useful, and optionally `exclusion_group:`.

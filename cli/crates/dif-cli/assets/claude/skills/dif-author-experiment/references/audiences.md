# dif audiences

dif's audience system is intentionally a closed set, not a DSL: every attribute is declared in `.dif/config.yaml`, paired with a TypeScript resolver under `audiences/`, and referenced by name in experiment frontmatter. The closed-set rule is what keeps the audience language sane as the project scales — no operators sneak in.

## The three-piece contract

For an attribute `<name>` to be usable in any experiment's `audience:` predicate, **all three** of these must exist:

1. **An entry in `.dif/config.yaml`** under `audience_attributes`:

   ```yaml
   audience_attributes:
     - name: locale
       type: string
     - name: device_type
       type: enum
       values: [mobile, tablet, desktop]
   ```

   Supported types: `string`, `boolean`, `number`, `enum` (with `values:`).

2. **A resolver file `audiences/<name>.ts`** exporting a default function:

   ```ts
   export default function resolve(): string | null {
     if (typeof navigator === "undefined") return null;
     return navigator.language ?? null;
   }
   ```

   Return `null` to fail-closed (the predicate evaluates to false and the user is excluded from any audience that requires this attribute). The return type must match the declared `type` from step 1.

3. **A reference in some experiment's `audience:` predicate** under `include:` or `exclude:`.

Mismatches are caught at validate time:

- Declared but no file → **E008** (error; build fails).
- File but not declared → **W002** (warning).
- Predicate references an undeclared name → **E006** (error; build fails).

`dif scaffold-audiences` will write the starter `locale.ts` / `device_type.ts` files into `audiences/` if they're not already there, idempotently.

## Predicate grammar

`audience:` has two lists: `include` (all must match) and `exclude` (none must match).

```yaml
audience:
  include:
    - locale: en-US                    # scalar = equality
    - device_type: [mobile, tablet]    # list = membership
  exclude:
    - country: [BR, AR]
```

Each list item is a single-key YAML map. Multiple keys in one map item are AND'd. The operators are exactly two:

- **Equality** when the value is a scalar (`locale: en-US` matches users whose `locale` resolver returns exactly `"en-US"`).
- **Membership** when the value is a list (`device_type: [mobile, tablet]` matches users whose `device_type` is `"mobile"` or `"tablet"`).

There are no `<`, `>`, regex, or negation operators. Negation is expressed structurally via the `exclude` list. Numeric ranges and async resolvers are deferred to v2.

## How predicates evaluate at runtime

For each user, the SDK calls every declared resolver function whose attribute is referenced by any active experiment. The result is a flat record `{ locale: "en-US", device_type: "mobile", … }`. Each experiment's audience is then evaluated against that record:

1. If any `include` predicate fails (or any `exclude` predicate matches), the user is excluded from this experiment.
2. If all `include` predicates match and no `exclude` matches, the user is eligible; the SDK proceeds to exclusion-group resolution and bucketing.

Resolvers that return `null` cause every predicate referencing them to evaluate to false (fail-closed). This is what makes SSR safe — the resolver returns null during server render, the user is excluded from audience-gated experiments, no exposure event fires, and the control branch is shown.

## Exclusion groups (different concept, similar word)

`exclusion_group: <key>` is *not* an audience filter — it's a coordination mechanism between experiments. Two active experiments on the same surface with overlapping audiences must either share an `exclusion_group` (the runtime picks the earlier-`created:` one per user) or have provably disjoint audiences. Otherwise E007.

A common pattern: every experiment touching the checkout CTA copy gets `exclusion_group: checkout-copy`. The runtime guarantees a user sees exactly one of them, never two stacked variants of the same surface element.

## Adding a new attribute

```sh
# 1. Declare in .dif/config.yaml under audience_attributes:
#      - name: country
#        type: string
# 2. Create audiences/country.ts with a default resolve() function.
# 3. (optional) Reference it in some experiment's audience: predicate.

dif validate    # confirms the three pieces are consistent
dif build       # emits the tree-shaken .dif/generated/audiences.ts
```

The generated `audiences.ts` only imports resolvers actually used by active experiments — adding a declared attribute that no experiment references is free at the runtime boundary.

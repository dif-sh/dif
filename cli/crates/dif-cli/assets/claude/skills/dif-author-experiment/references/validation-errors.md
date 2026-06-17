# dif validate error codes

`dif validate` collects all errors before exiting (not fail-fast), so one run shows the full picture. Errors abort the build; warnings don't. Codes E001 / E003-E008 are errors; W001 / W002 / W003 are warnings.

(There is intentionally no E002 — it was reserved during design and never used. The gap is preserved so existing codes don't renumber.)

## Errors

### E001 — Frontmatter invalid or required field missing

The YAML doesn't parse, or a required field is missing. The required set is: `id`, `status`, `owner`, `surface`, `hypothesis`, `variants`, `metrics`, `created`.

**Fix:** open the file at the line reported. Ensure the frontmatter is a valid YAML block between two `---` fences and every required field is set with the right type. `dif new` always writes a correct stub — copy from a fresh `dif new ... --surface ...` if you're stuck.

### E003 — owner is not a valid email

The email regex is permissive (one `@`, at least one `.` after it). Catches typos and unset values, not RFC edge cases.

**Fix:** set `owner:` to `name@example.com` form. `dif new --owner <email>` lets you supply it on the command line; `git config user.email <email>` is the persistent fix.

### E004 — surface does not exist

The experiment's `surface:` field doesn't match any `dif/surfaces/<name>.md`.

**Fix:** create `dif/surfaces/<name>.md` (the stub `dif init` emits is a usable template), or fix the `surface:` value to an existing one. `dif new --surface <name>` only allows existing surfaces, so this typically arises from hand-editing.

### E005 — variant weights don't sum to 100

The runtime bucketing math depends on the weights summing to exactly 100. `dif` refuses to compile otherwise.

**Fix:** distribute weights so they total 100. Common shapes: `50/50`, `80/10/10`, `70/15/15`, `25/25/25/25`. The error message tells you the actual sum, which usually makes the off-by-N obvious.

### E006 — audience attribute not declared

You used an attribute in an `audience:` predicate that isn't in `dif/config.yaml`'s `audience_attributes` list.

**Fix:** add the attribute to `audience_attributes:` (with a `name` and `type`), or remove the predicate. There is intentionally no inline DSL — every attribute is a closed-set declaration with a paired resolver file. After declaring, also create the matching `dif/audiences/<name>.ts` (or you'll trip E008 next).

### E007 — exclusion conflict

Two active experiments target the same surface, don't share an `exclusion_group`, and their audiences are not provably disjoint. The runtime has no basis for picking one when a user matches both, and dif wants that decision explicit in the files, not implicit in load order.

**Fix:** pick one of three:
1. Add the same `exclusion_group: <key>` to both. The runtime picks the earlier `created:` date per user.
2. Narrow one of the audiences so they're provably disjoint. E.g. one experiment has `include: [country: US]`, the other has `include: [country: UK]` — dif can prove these don't overlap.
3. Change one experiment's `surface:` so they're not competing for the same render site.

The disjointness check is conservative (scalar equality + list membership only), so two audiences might be effectively disjoint by your reasoning but not provably so by dif's. In that case, use option 1.

### E008 — declared audience attribute is missing its resolver

You declared `name: <attr>` in `audience_attributes` but `dif/audiences/<attr>.ts` doesn't exist.

**Fix:** create `dif/audiences/<attr>.ts` exporting a default `resolve()` function returning the user's value (or `null` for fail-closed during SSR). Run `dif scaffold-audiences` to pull in the starter `locale.ts` / `device_type.ts` if those are the ones missing.

## Warnings (non-fatal)

### W001 — orphan ref

A `dif("<id>", ...)` call site in source code references an experiment that isn't active. Often the experiment was concluded or renamed but the call site stayed.

**Fix:** create or activate the experiment, or remove the call site.

### W002 — orphan audience file

`dif/audiences/<name>.ts` exists but `audience_attributes` doesn't declare it. Could be an in-progress draft or a forgotten cleanup.

**Fix:** add the declaration to `dif/config.yaml`, or delete the file if it's no longer used.

### W003 — legacy `exposure:` block

`dif/config.yaml` still has an `exposure:` block. Event delivery is configured by `events:` now (`mode: cloud` or `mode: custom`); the old `exposure:` key is ignored and the workspace defaults to cloud.

**Fix:** replace `exposure:` with an `events:` block. See [/docs/events](https://dif.sh/docs/events/).

# dif.sh — CLI / product implementation plan

*v0.1. Companion to the product brief. Targets a working v1.*

## Context

The brief is the *what*. This is the *how*. It pins the architecture, the file layout, the data model, the command contracts, the compile pipeline, the SDK shape, and the build order — enough that an engineer (or a coding agent) can pick up `crates/dif-core/src/lib.rs` and start landing real implementations against a stable spec.

The discipline mirrors the brief: every piece earns its place either by serving the agent-native thesis or by removing a survey-cited correctness gap. If a primitive isn't here, it's deliberately deferred.

## Architecture in one paragraph

Three artifacts, two languages, one source of truth. **`dif-core`** is a Rust crate that owns correctness — parsing `.md` frontmatter, resolving the exclusion graph, deterministic bucketing, codegen. **`dif-cli`** is a thin Rust binary that wraps `dif-core` with `clap` + `miette` + `indicatif` and dispatches the six verbs. **`@dif.sh/sdk`** is a pure-TypeScript runtime SDK (~5 kB gzipped) that customers install and call from app code. The Rust side never ships into the customer's app — it produces a generated TypeScript file (`.dif/generated/client.ts`) and a `.dif/context.json` blob, and that pair is the entire contract. No FFI, no NAPI, no WASM at the runtime boundary.

```
   .md files in repo                customer's app
        │                                │
        ▼                                ▼
 ┌─────────────┐    dif build    ┌──────────────┐
 │  dif-core   │ ─────────────▶  │ generated.ts │
 │   (Rust)    │                 │ context.json │
 └─────────────┘                 └──────────────┘
        ▲                                │
        │                                ▼
   dif-cli (Rust)                 @dif.sh/sdk (TS)
                                        │
                                        ▼
                                   exposure sink
```

## Workspace layout

```
cli/
├── PLAN.md                              # this doc
├── Cargo.toml                           # workspace root
├── rust-toolchain.toml                  # pinned stable
├── crates/
│   ├── dif-core/                        # the engine
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                   # public re-exports + Workspace::load
│   │       ├── spec.rs                  # serde types for the .md frontmatter
│   │       ├── parse.rs                 # frontmatter + body parsing, with spans
│   │       ├── config.rs                # .dif/config.yaml types
│   │       ├── workspace.rs             # repo discovery + walk experiments/surfaces
│   │       ├── validate.rs              # schema, owner, surface-exists, refs
│   │       ├── exclusion.rs             # exclusion graph + resolver
│   │       ├── bucket.rs                # deterministic hash → variant
│   │       ├── codegen.rs               # emit .dif/generated/client.ts
│   │       ├── context.rs               # emit .dif/context.json
│   │       └── diag.rs                  # miette diagnostics with source spans
│   └── dif-cli/                         # the binary
│       ├── Cargo.toml
│       └── src/
│           ├── main.rs                  # clap entry
│           └── cmd/
│               ├── mod.rs
│               ├── init.rs
│               ├── new.rs
│               ├── validate.rs
│               ├── build.rs
│               ├── qa.rs
│               └── conclude.rs
└── packages/
    └── client/                          # @dif.sh/sdk
        ├── package.json
        ├── tsconfig.json
        ├── README.md
        └── src/
            ├── index.ts                 # public API: `dif()` wrapper, configure()
            ├── exposure.ts              # render-time event firing
            ├── types.ts                 # public types
            └── sinks/
                ├── index.ts             # sink interface + factory
                ├── webhook.ts
                ├── segment.ts
                ├── amplitude.ts
                └── mixpanel.ts
```

Two Cargo crates inside one workspace. One npm package. No monorepo tooling beyond Cargo + npm — turborepo / nx are out of scope until there's a second TS package to coordinate with.

## Data model

The frontmatter spec maps 1:1 to Rust types in `dif-core::spec`. `serde_yaml` for parse, validators in `validate.rs`.

```rust
// crates/dif-core/src/spec.rs
pub struct Experiment {
    pub id: String,                  // kebab-case, unique in workspace
    pub status: Status,              // draft | active | concluded | archived
    pub owner: Email,
    pub surface: SurfaceId,          // must resolve to surfaces/<name>.md
    pub hypothesis: String,
    pub audience: Audience,
    pub variants: Vec<Variant>,      // ≥ 2, weights sum to 100
    pub metrics: Metrics,
    pub exclusion_group: Option<String>,
    pub created: NaiveDate,
    pub concluded: Option<NaiveDate>,
}

pub enum Status { Draft, Active, Concluded, Archived }

pub struct Audience {
    pub include: Vec<AttrPredicate>,
    pub exclude: Vec<AttrPredicate>,
}

// AttrPredicate references audience_attributes declared in .dif/config.yaml.
// We refuse anything not declared — the survey's "no new DSL" rule.

pub struct Variant {
    pub id: String,                  // unique within experiment
    pub weight: u16,                 // 0–100, sum == 100
    pub summary: Option<String>,
}

pub struct Metrics {
    pub primary: MetricId,
    pub guardrails: Vec<MetricId>,
}
```

The body is preserved as `(Brief, Rationale, Decision)` blocks — section headings `## Brief`, `## Rationale`, `## Decision` are addressable so `dif conclude` can write the Decision block without touching the rest.

`Surface` is a separate type with its own .md file: description + landmines + `## Learnings` log. `dif conclude` appends one line under `## Learnings`; nothing else writes there.

## The six verbs — contract per command

Each verb has: **inputs** (CLI args + files read), **side effects** (files written, processes spawned), **exit codes**, **failure modes**, and a **one-line invariant** that must remain true after a successful run.

### `dif init`

```
USAGE: dif init [--surface <name>] [--force]
```

- Reads: nothing.
- Writes: `experiments/active/`, `experiments/concluded/`, `surfaces/<default-surface>.md` (stub), `.dif/config.yaml`, `.dif/.gitignore` (with `generated/`).
- Refuses if any of those paths exist unless `--force`.
- Exit 0 on success, 2 on existing-files-without-force.
- **Invariant**: a fresh `init` followed immediately by `validate` and `build` succeeds with zero experiments.

### `dif new <id> --surface <name>`

```
USAGE: dif new <id> --surface <surface> [--owner <email>] [--from <experiment-id>]
```

- Reads: `surfaces/<surface>.md` (for prior learnings, fed to the template).
- Writes: `experiments/active/<id>.md` with frontmatter pre-stubbed (`status: draft`, today's date, owner inherited from git config or `--owner`).
- The body template prefixes the `## Brief` section with a *“Recent learnings on this surface”* comment block summarizing the last 3 lines from the surface's `## Learnings` — this is the bit that makes "yesterday's learning is in tomorrow's draft" load-bearing rather than aspirational.
- Exit 0 on success, 2 if `<id>` already exists, 3 if surface doesn't exist.
- **Invariant**: the file it writes parses cleanly with `dif validate`.

### `dif validate`

```
USAGE: dif validate [--json]
```

- Reads: every `.md` under `experiments/` and `surfaces/`, plus `.dif/config.yaml`.
- Writes: nothing.
- Returns a `Report { errors, warnings }`. `--json` for machine output.
- Checks (in order, fail-fast disabled — collects all):
  1. Frontmatter parses and required fields are present.
  2. `owner` is a syntactically valid email.
  3. `surface` resolves to a file under `surfaces/`.
  4. Variant weights sum to exactly 100.
  5. All audience attribute predicates name attrs declared in `config.yaml`.
  6. No two `active` experiments share an `exclusion_group` *and* audience overlap (cheap superset check; full SAT not needed).
  7. Every `dif("<id>", …)` call site found in source maps to an active experiment (orphan refs are warnings, not errors — they're catch-able cleanup).
- Exit 0 on no errors (warnings OK), 1 on any error.
- Diagnostics use `miette` with the .md file's byte ranges so the error renders inline like `rustc`.

### `dif build`

```
USAGE: dif build [--out <dir>]
```

- Reads: everything `validate` reads, plus a quick grep of source files (`src/**`) for `dif(` call sites.
- Runs `validate` first; aborts if errors.
- Writes: `.dif/generated/client.ts` and `.dif/context.json`.
- The generated TS file:
  - Declares one typed export per active experiment.
  - Embeds an `__EXPERIMENTS` constant with the resolved decision tree (audience predicates, exclusion graph adjacency, variant weights).
  - Embeds the bucketing salt per experiment.
  - Imports the runtime from `@dif.sh/sdk` and calls `defineExperiment(...)` for each.
- The `context.json` file matches the shape shown in the site mockup ([site/index.html](../site/index.html) pane 3): `generated_at`, `active[]`, `surfaces[]`, `conventions[]`.
- Exit 0 on success, 1 on any compile error.
- **Invariant**: the generated TS file is byte-identical for identical inputs (deterministic codegen — required for sensible PR diffs).

### `dif qa`

```
USAGE: dif qa [--user <id>] [--force <exp>=<variant>]... [--preview-url <base>]
```

- Reads: `.dif/generated/client.ts` and `.dif/context.json` (no need to re-parse .md files — qa works against the compiled artifact, same as production).
- Writes: nothing.
- Prints the assignment chain for the given user, with each rule that fired (audience hit/miss, exclusion-group resolution, bucket number, final variant).
- If `--force` is passed, also emits a preview URL with the `_dif` cookie pre-baked so the user can open a browser at that state.
- Exit 0 always (it's a debugging tool).

### `dif conclude <id>`

```
USAGE: dif conclude <id> [--decision <text>] [--skip-learning]
```

- Reads: `experiments/active/<id>.md`, `surfaces/<surface>.md`.
- Writes (atomic, single transaction — either all succeed or all revert):
  1. Renames `experiments/active/<id>.md` → `experiments/concluded/<YYYY-MM>-<id>.md`.
  2. Inside the renamed file, replaces the empty `## Decision` block with the supplied decision text (or opens `$EDITOR` if `--decision` isn't given).
  3. Appends one line under `## Learnings` in the surface file, dated today, summarizing the decision.
  4. Updates `status: active` → `status: concluded` and sets `concluded: <today>` in frontmatter.
- Exit 0 on success, 1 on any IO/parse failure (revert all changes).
- **Invariant**: after success, `validate` and `build` still pass.

## The compile pipeline

`dif build` is `validate` followed by three passes:

1. **Resolve.** For each active experiment, materialize the runtime config: audience as a flat predicate AST, variants as a cumulative weight table, exclusion-group adjacency list.
2. **Bucket-salt.** Each experiment gets a deterministic salt = `sha256("dif.sh/v1" || experiment.id)[:16]`. Re-generating produces the same salt; renaming an experiment changes it (which is correct — it's a different experiment).
3. **Codegen.** Emit `client.ts` with a stable formatting rule (no `prettier` step — we control the writer). Emit `context.json` from a flat struct via `serde_json::to_string_pretty`.

Deterministic bucketing (canonical algorithm, also implemented in `@dif.sh/sdk`):

```
fn bucket(user_id: &str, salt: [u8; 16]) -> u16 {
    let mut h = Sha256::new();
    h.update(salt);
    h.update(user_id.as_bytes());
    let digest = h.finalize();
    u16::from_be_bytes([digest[0], digest[1]]) % 10_000  // 0..9999
}
```

Variant selection: walk variants in declared order, accumulating `weight * 100`; first variant whose cumulative crosses the bucket wins. Stable across Rust and TS because both use the same `sha256` and the same byte order.

The Rust and TS sides each have a `bucket_tests.json` fixture (~500 hand-picked (user_id, salt) → expected_bucket triples) checked in. CI runs both implementations against it. If they ever disagree, the build is broken until fixed.

## Exclusion resolution

`exclusion_group` is a string. Two active experiments sharing a group and overlapping audience cannot run on the same user. The resolver:

1. Group active experiments by `exclusion_group`.
2. Within each group, build a deterministic priority order — currently `(created date asc, id asc)`. Earliest experiment wins on collision.
3. At runtime: for a given user, walk groups; for each group, find the first experiment in priority order whose audience matches. Assign that one. Skip the rest in that group.

This is encoded into the generated TS as a single decision tree the runtime walks once per `dif()` call site, so there's no per-call sorting cost. The whole thing fits in `O(n)` of declared experiments.

**Conflict detection at build time** is the same logic, but applied to the entire user space (i.e., audience supersets), not per-user. Two experiments that *could* collide for some user → build fails. The survey's #1 correctness gap closed at compile time, not in production.

## The SDK contract

`@dif.sh/sdk` exposes:

```ts
// packages/sdk/src/index.ts
export interface DifConfig {
  userId: () => string | null;
  sink: Sink | Sink[];
  enabled?: boolean;          // default true; flip to false to short-circuit in test envs
}

export function configure(config: DifConfig): void;

export function defineExperiment<V extends string>(spec: {
  id: string;
  variants: readonly V[];
  salt: string;               // hex
  audience: AudienceFn;       // generated; takes user context, returns bool
  exclusionGroup: string | null;
  weights: Record<V, number>;
}, branches: Record<V, () => unknown>): () => unknown;
```

Customers never call `defineExperiment` directly — the generated file does it for them. They import the named export and call it at the render site:

```ts
import { checkoutCta } from "../.dif/generated/client";

function CheckoutButton() {
  return <Button>{checkoutCta()}</Button>;
}
```

That single call: looks up the user via `config.userId()`, evaluates the audience predicates, resolves exclusion groups, buckets the user, fires one exposure event, and returns the matching branch's value. All in <50 µs hot path.

### Exposure event shape

One event, one shape, every sink:

```ts
{
  event: "dif.exposure",
  experiment: "checkout-cta-v2",
  variant: "variant_a",
  user_id: "u_8131",
  surface: "checkout",
  bucket: 7142,
  fired_at: 1716304931542,    // unix ms
  source: "@dif.sh/sdk@1.0.0",
}
```

Sinks normalize this into their native format. Segment becomes `analytics.track("dif.exposure", { … })`, Amplitude becomes `amplitude.track("dif.exposure", { … })`, the webhook sink POSTs the raw object. No other event types in v1 — the customer's analytics tool handles the rest.

**Fire at render, not at assignment.** Bucketing is pure; firing the event is the side effect that takes work. We fire once per `(experiment, user)` pair per session — a tiny dedupe set keyed by `experiment+user_id`, cleared on page nav. The survey calls out the assignment-vs-render bug as a correctness issue; this is the structural fix.

## Distribution

- **`dif` CLI**: built with `cargo dist`. Three release artifacts: `dif-aarch64-apple-darwin.tar.gz`, `dif-x86_64-unknown-linux-gnu.tar.gz`, `dif-x86_64-pc-windows-msvc.zip`. Install via `curl | sh` (shipped script) or Homebrew tap. **Not** distributed via npm — the brief's "npm install -g @dif.sh/cli" pitch is preserved as a thin npm-wrapper package that downloads the right Rust binary on `postinstall`. This keeps the marketing claim true while keeping the CLI as a single static binary.
- **`@dif.sh/sdk`**: published to npm. Dual-format (`module` + `main`), no dependencies, no peer-deps beyond TypeScript types.
- **Versioning**: SemVer on each artifact independently. The Rust binary embeds its own version into the generated TS file (`// generated by dif vX.Y.Z`) so a customer can audit drift.

## What's deliberately not in v1

Holding the brief's line:

- No native analysis (SRM, lift, NL query) — v1.1.
- No hosted control plane — v2.
- No WASM build of `dif-core` for in-browser parsing — would let editor plugins lint .md files live, but adds a build target and ~80 kB to the bundle. Defer until there's a real editor plugin to ship.
- No MCP server — the CLI is the interface, agents call it. v1.1 if usage data shows agents struggle to discover the verbs.
- No bandits, no sequential testing, no MAB.
- No file-watcher / hot-rebuild mode. `dif build` is invoked by the user's existing dev-server hook or by CI; we don't reinvent that.

## Build order

Strict, sequential. Each step is shippable and unblocks the next.

1. **Workspace + skeleton.** Cargo workspace, both crates compile, `dif --help` runs and lists six subcommands (all `todo!()`). npm package builds and publishes a stub `defineExperiment` that throws "not yet implemented." *Status today.*
2. **`spec.rs` + `parse.rs`.** Real frontmatter parsing with `serde_yaml`. Round-trip test: parse → re-serialize → parse equals first parse. ~2 days.
3. **`dif init`.** First end-to-end. Real file IO, real config emission, real diagnostic output. ~1 day after step 2.
4. **`dif validate`.** Schema checks first; surface-exists, owner-format, weights-sum-100. Audience-attr-declared and exclusion-overlap come last because they need the workspace walker. ~3 days.
5. **`bucket.rs` + fixtures.** Deterministic hash, fixture JSON, Rust tests passing. Defer the TS port to step 8. ~1 day.
6. **`exclusion.rs`.** Graph build + resolver + compile-time overlap detection. ~2 days.
7. **`codegen.rs` + `context.rs`.** First version emits a hardcoded TS file shape; iterate on formatting. ~3 days. End state: `dif build` produces a real `.dif/generated/client.ts` that compiles under `tsc`.
8. **`@dif.sh/sdk` runtime.** Port the bucketing algorithm. Implement `defineExperiment`. Wire the webhook sink first; segment/amplitude/mixpanel after. Match the Rust fixture file. ~4 days.
9. **`dif qa`.** Reads the compiled artifact and replays it for a given user. ~1 day.
10. **`dif conclude`.** Atomic rename + Decision block insertion + surface log append. Transactional rollback on any failure. ~2 days.
11. **`dif new`.** Surface-log-aware draft template. Last because it's the most agent-facing and we want the rest stable before iterating on prompts. ~2 days.
12. **Release.** `cargo dist` setup, Homebrew tap, npm publish for the wrapper + the client. Docs site is the existing [site/index.html](../site/index.html). ~1 day.

Total nominal: ~22 working days for v1. With slop and review, plan for six weeks.

## Open questions

These need decisions before the relevant step begins; flagging here so they don't ambush the build.

1. **The audience predicate language.** YAML structure is committed (`include`/`exclude` lists). The actual operators are not. Lean: support exact equality, `in [list]`, and a single negation. No `<`/`>`/regex in v1 — those creep into a DSL.
   - **Resolved (v0.2):** each declared `audience_attributes` entry pairs with an `audiences/<slug>.ts` resolver file. `dif init` ships starters (`locale`, `device_type`); `dif build` tree-shakes the folder against active experiments and emits `.dif/generated/audiences.ts`, a one-line `attributes(overrides)` wiring the user passes to `dif.init`. User-supplied keys win on overlap. `validate` enforces the pairing with `E008` (declared, missing file) and `W002` (file, undeclared). Operators stay equality / `in [list]` — async, context-aware, and SSR-split resolvers are v2.
2. **Owner inheritance.** `dif new` infers owner from `git config user.email`. What about CI? Probably: explicit `--owner` flag required when `$CI` is set and `git config` isn't a person.
3. **User ID at runtime.** `config.userId()` returns nullable. What does the SDK do on null? Lean: skip the experiment, return the `control` branch, do not fire exposure. The alternative — error — punishes the customer for a state we should handle gracefully.
4. **Generated file location.** `.dif/generated/client.ts` is gitignored by default. But some teams want the artifact in-repo for review. Add a `build.commit_generated: bool` config option in `.dif/config.yaml`; default false.
5. **Hot-reload story.** Punted above, but if Next.js / Vite users complain, the cheap fix is a `dif watch` command that re-runs `build` on .md changes and writes to the same paths.

## Verification

The plan is verifiable end-to-end as it gets built:

- After step 1: `cargo build` succeeds, `cargo run --bin dif -- --help` lists six verbs.
- After step 3: `dif init` in an empty repo produces a tree that matches the brief's example layout.
- After step 7: pointing `dif build` at a sample experiment produces a TypeScript file that compiles, and a `context.json` matching the documented shape.
- After step 8: a tiny example app calls `checkoutCta()` and the webhook sink receives one exposure event per render with the schema above.
- After step 12: `npm install -g @dif.sh/cli && dif init` works on a fresh machine.

Every step is also covered by tests in `cargo test` and (for step 8 onward) `npm test`. The bucketing fixture is the cross-language anchor — it should be the first thing CI runs, on every PR, on both languages.

# dif.sh

**Experiments belong in the repo.**

One `.md` file per experiment, in the repo with the code. Every flag, A/B
test, holdout, and rollout is versioned in git and reviewable in a PR. Your
coding agent reads `dif/context.json` on session start, so prior learning
travels with the work.

## Install

```sh
# macOS / Linux — single static binary, no Node required
curl -fsSL https://dif.sh/install.sh | sh

# macOS via Homebrew
brew install dif-sh/tap/dif

# Any platform with Node 18+
npm install -g @dif.sh/cli
```

## Quickstart

From an empty repo to a tested experiment rendering in your app.

**1. `dif init`** — scaffold the workspace. One `dif/` directory holds everything.

```sh
$ dif init
✓ wrote dif/config.yaml
✓ created dif/experiments/{active,concluded}/
✓ created dif/surfaces/home.md
✓ created dif/audiences/{locale,device_type}.ts
✓ added dif guidance to CLAUDE.md, AGENTS.md
```

**2. `dif new`** — draft an experiment. Owner comes from `git config user.email`.

```sh
$ dif new checkout-cta-v2 --surface home
→ reading dif/surfaces/home.md
  found 0 prior learnings
→ drafted dif/experiments/active/checkout-cta-v2.md
  status: draft, owner: ada@acme.dev
```

Open the file, fill in the hypothesis, set `status: active`.

**3. `dif validate`** — every check in one pass. Errors include the source location.

```sh
$ dif validate
✓ all checks passed
```

**4. `dif build`** — compile the runtime artifacts your app imports and the
context file your agent reads.

```sh
$ dif build
✓ validated 1 active experiment
✓ client    → dif/generated/client.ts
✓ audiences → dif/generated/audiences.ts
✓ context   → dif/context.json
```

**5. Render it** — install the SDK, import the generated client once at boot,
and call `dif()` at the render site. Full reference on the
[SDK page](https://dif.sh/docs/sdk/).

```sh
$ npm install @dif.sh/sdk
```

```ts
import "./dif/generated/client";
import { attributes } from "./dif/generated/audiences";
import { dif } from "@dif.sh/sdk";

dif.init({
  userId: () => currentUser?.id ?? null,
  attributes: () => attributes(),
});

const cta = dif("checkout-cta-v2", {
  control:   () => "Place order",
  variant_a: () => "Get it today",
});

button.textContent = cta();
```

## Repo layout

```
README.md                # this file
PUBLIC_DOCS.md           # full reference docs (mirrors dif.sh/docs)
LICENSE                  # MIT
cli/                     # the CLI — Cargo workspace + npm packages
  crates/dif-core/       # parser, validator, resolver, codegen (Rust library)
  crates/dif-cli/        # the `dif` binary
  packages/cli/          # @dif.sh/cli — Node wrapper for `npm install -g`
  packages/sdk/          # @dif.sh/sdk — runtime SDK (TypeScript)
  packages/react/        # @dif.sh/react — provider + useDif hook
  packages/svelte/       # @dif.sh/svelte — Svelte 5 / SvelteKit adapter
dist/                    # install.sh + Homebrew tap template
.github/workflows/       # CI + release
```

## Architecture

Three artifacts, two languages, one source of truth.

- **`dif-core`** (Rust crate) — parsing, audience eval, deterministic
  bucketing, exclusion graph, codegen. Where correctness lives.
- **`dif-cli`** (Rust binary) — thin clap wrapper that dispatches the six
  verbs into `dif-core`. Single static binary.
- **`@dif.sh/sdk`** (TypeScript SDK) — ~5 kB gzipped, zero deps. Lives in
  the customer's app. Reads the generated TS artifact, evaluates audience,
  buckets the user, fires one exposure event per (experiment, user) per
  session, returns the variant.

The contract between Rust and TS is one generated file
(`dif/generated/client.ts`) plus `dif/context.json`. No FFI, no NAPI, no
WASM at the runtime boundary — the customer's install surface stays as
boring as humanly possible.

A cross-language fixture (`crates/dif-core/tests/fixtures/bucket_tests.json`)
locks the bucketing contract: any drift between Rust and TS fails CI on
both sides.

## Local development

```sh
cd cli
cargo test --workspace            # Rust tests (parser, validator, codegen, etc.)

cd packages/sdk
npm install
npm test                          # SHA-256 vectors + the bucket fixture
```

CI runs both on every PR. The release workflow at
[`.github/workflows/release.yml`](.github/workflows/release.yml) cuts a
GitHub release on every `v*` tag push and publishes the npm packages.

## dif.sh Cloud

The hosted control plane — event ingest, metrics catalog, statistical
analysis, and PR write-back — runs at [cloud.dif.sh](https://cloud.dif.sh) and
is self-hostable from
[`dif-sh/dif-cloud`](https://github.com/dif-sh/dif-cloud). Point the SDK at it
with `dif.init({ publishableKey, apiUrl: "https://cloud.dif.sh" })`.

## License

MIT — see [LICENSE](LICENSE).

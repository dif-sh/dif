# dif.sh

**Experimentation-as-code for teams whose primary developer is now an AI agent.**

Experiments live in your repo as plain `.md` files. Claude Code, Codex, and
Cursor read and write them natively. A build step compiles guardrails —
exclusion groups, decision logic, type-safe variant refs — so the runtime
stays small and the source of truth stays in git.

## Install

```sh
# macOS / Linux — single static binary, no Node required
curl -fsSL https://dif.sh/install.sh | sh

# macOS via Homebrew
brew install dif-sh/tap/dif

# Any platform with Node 18+
npm install -g @dif.sh/cli
```

Then, in any repo:

```sh
dif init                                 # scaffolds the convention
dif new checkout-cta-v2 --surface checkout
# ...edit experiments/active/checkout-cta-v2.md...
dif validate
dif build                                # → .dif/generated/client.ts
dif qa --user u_8131                     # trace a user's assignment chain
dif conclude checkout-cta-v2 --decision "Shipped. +2.1%."
```

## Repo layout

```
README.md                # this file
RELEASE.md               # release runbook (initial setup + per-version steps)
LICENSE                  # MIT
cli/                     # the CLI — Cargo workspace + npm packages
  crates/dif-core/       # parser, validator, resolver, codegen (Rust library)
  crates/dif-cli/        # the `dif` binary
  packages/cli/          # @dif.sh/cli — Node wrapper for `npm install -g`
  packages/sdk/       # @dif.sh/sdk — runtime SDK (TypeScript)
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
(`.dif/generated/client.ts`) plus `.dif/context.json`. No FFI, no NAPI, no
WASM at the runtime boundary — the customer's install surface stays as
boring as humanly possible.

A cross-language fixture (`crates/dif-core/tests/fixtures/bucket_tests.json`)
locks the bucketing contract: any drift between Rust and TS fails CI on
both sides.

## Local development

```sh
cd cli
cargo test --workspace            # Rust tests (parser, validator, codegen, etc.)

cd packages/client
npm install
npm test                          # SHA-256 vectors + the bucket fixture
```

CI runs both on every PR. The release workflow at
[`.github/workflows/release.yml`](.github/workflows/release.yml) cuts a
GitHub release on every `v*` tag push and publishes both npm packages.

## Status

v0.1.0 — pre-release. Every PLAN verb (`init`, `new`, `validate`, `build`,
`qa`, `conclude`) is implemented and tested. Cross-language contract holds.
What's NOT in v1: native analysis, hosted control plane, bandits — all on
the roadmap.

## License

MIT — see [LICENSE](LICENSE).

# Agent rules

These rules apply to every change in this repo.

## Comments

- Write comments in ASD-STE100 Simplified Technical English.
- Use present tense, active voice and approved words.
- Write one idea per sentence.
- Use at most 10 words per line.
- Use at most 2 lines per comment block.
- Comment the reason, not the action. Prefer no comment.
- Do not rewrite old comments in code you do not change.

## Tests

- Use red-green TDD for logic: write the test, run it, see it fail, then write the code.
- Logic means: maths, parsers, auth, access checks, state rules, data shaping.
- Do not add tests for wiring, copy, styles or docs.
- Do not add snapshot tests of large objects.

## Commits and PRs

- Use Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.
- Do not add `Co-authored-by` trailers.
- Do not add AI attribution to commits or PR bodies.
- Use one branch per workstream. Never push to `main`.

## Human-only actions

Never do these. Stop and ask a human:

- Run `scripts/prepare-release.sh`.
- Create or push git tags.
- Publish npm packages.
- Edit anything under `dist/homebrew-tap/`.

## Commands

- Rust checks (from the repo root): `cd cli && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`
- Skills mirror check: `node scripts/sync-skills.mjs --check`
- Skills mirror refresh, after you edit `cli/crates/dif-cli/assets/claude/skills/`: `node scripts/sync-skills.mjs`
- SDK tests (run `npm install` in that folder once first): `cd cli/packages/sdk && npm test`

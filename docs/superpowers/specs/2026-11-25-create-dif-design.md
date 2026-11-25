# `create-dif`: one command to add dif to an app

## Why

Adding dif to an existing JS app today means three steps: install `@dif.sh/cli`, run `dif init`, then copy the
`npm install @dif.sh/…` line that init prints. We want a single entry point, like `npx sv create`:

```bash
npm create dif@latest     # or: npx create-dif, pnpm create dif, bun create dif
```

It installs the CLI, runs the new `dif init` (PR #70), and init installs the SDK packages for the chosen framework.
It ships with 0.10.0, together with #70.

## Goals

- One command takes an existing app from no dif to a working workspace, with packages installed.
- Same look and the same questions as `dif init`. The user sees no new prompts in a different style.
- Uses the package manager the project already uses (npm, pnpm, yarn, bun).
- `dif init` run on its own (Homebrew, global install) also gets the install step.

## Non-goals

- Scaffolding a new app (`sv create my-app` style). This is for existing apps.
- Non-JS projects.

## Anti-goals

- Agents, CI or `--json` runs that start installing packages without being asked.
- A second list of frameworks or packages in JS that can drift from the Rust one.

## Approaches

- **A. Questions in Node** (`@clack/prompts`): ask the framework in JS, install, then run `dif init --framework`.
  Rejected: duplicates the framework list and detection, and `dif init` users get no install step.
- **B. Thin `create-dif`, install step in `dif init`. Picked.** One question flow, one look, one framework list
  (`Framework::packages()` already exists in #70).
- **C. `create-dif` downloads the binary directly.** Rejected: the binary that runs can differ from the
  `@dif.sh/cli` version the project then installs.

## Design

### `create-dif` (new package, `cli/packages/create-dif`)

Plain Node (>=18), ESM, no dependencies. Roughly 50 lines.

1. If the current folder has no `package.json`, print a short message (this adds dif to an existing app; run it in
   your app's folder) and exit 1.
2. Detect the package manager: `npm_config_user_agent` first (it shows which tool ran `npm/pnpm/yarn/bun create`),
   then the lockfile, else npm.
3. Run `<pm> add -D @dif.sh/cli@<create-dif's own version>` (`npm install -D` for npm). Output streams to the user.
   On failure, exit with its code.
4. Run the project-local `dif init`, passing through any arguments the user gave (`npm create dif -- --yes`).
   Exit with init's exit code.

`create-dif` has the same version as every other dif package. That pins the CLI it installs.

### `dif init` install step (Rust, on top of #70)

- **When:** after *Write files* succeeds and before the wrap-up, only when a `package.json` exists.
- **What:** `Framework::packages()`, minus packages already in `dependencies` or `devDependencies`. If nothing is
  left, skip the step without a message.
- **Ask:** "Install @dif.sh/sdk and @dif.sh/react with pnpm?" (confirm, default yes). Esc or No → print the command
  as a next step, as today.
- **Package manager:** lockfile (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock`/`bun.lockb`, `package-lock.json`), then
  `npm_config_user_agent`, else npm. This is pure logic with unit tests.
- **Run:** the package manager's add command, output streamed. If it fails, show a warning and the command to run
  by hand. The workspace is still written, so init still exits 0.
- **Non-interactive (`--yes`, `--json`, no terminal):** never installs unless the new `--install` flag is given.
  Agents keep today's behaviour by default.
- **Next steps:** `next[0]` uses the detected package manager (`pnpm add …` instead of always `npm install …`).
  It is left out when the packages are already installed.

### Release and docs

- Add `create-dif` to the version loop in `scripts/prepare-release.sh` and to the `npm-publish` job in
  `release.yml`, published after `@dif.sh/cli`. (Only the files change. A human still runs the release.)
- Docs: `init-flow.md` gets the install step, `cli-contract.md` gets `--install` and the `next[0]` change, and
  the README getting-started section leads with `npm create dif@latest`.

### Tests (red-green, logic only)

- Rust: package-manager detection, the add command for each manager, and filtering out installed packages.
- JS (`node:test`): user-agent and lockfile detection, and the install arguments.

## Left to the builder

- Exact wording of messages, following the #70 style.
- Whether `bun.lock` and `bun.lockb` both count (they should).
- Branch: `feat/create-dif`, on top of `feat/revised-init`. Rebase onto `main` once #70 merges.

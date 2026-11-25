# create-dif Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm create dif@latest` installs `@dif.sh/cli` into an existing app and runs `dif init`, and `dif init` installs the SDK packages for the chosen framework.

**Architecture:** A dependency-free Node package `create-dif` detects the package manager, adds `@dif.sh/cli` as a dev dependency, makes sure its binary is present, and runs the project's `dif init`. The Rust `dif init` gets a new pure module (`init/install.rs`) for package-manager detection and install commands, and an install step after the files are written. The step asks on a TTY, runs with `--install`, and otherwise only prints the command.

**Tech Stack:** Rust (clap, cliclack, serde_json), Node >=18 ESM with `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-25-create-dif-design.md`

## Global Constraints

- Branch `feat/create-dif`, based on `feat/revised-init` (PR #70). Never push to `main`.
- Conventional Commits, no `Co-authored-by`, no AI attribution.
- Comments follow AGENTS.md: ASD-STE100, reason not action, at most 2 lines, at most 10 words per line.
- Red-green TDD for logic only (detection, commands, filtering). No tests for wiring, copy or docs.
- `create-dif` has no runtime dependencies, uses `"type": "module"`, and has `"engines": { "node": ">=18" }`.
- `create-dif` version = every other dif package version (0.9.0 now; the release script bumps it).
- Package managers: npm, pnpm, yarn, bun. Lockfiles: `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`, `package-lock.json`.
- Non-interactive `dif init` (`--yes`, `--json`, no TTY) never installs unless `--install` is given.
- A failed install warns and shows the command. `dif init` still exits 0.
- Do not run `scripts/prepare-release.sh`, create tags or publish. Editing the script is fine.
- Rust checks: `cd cli && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`

## Review Focus

1. **`--json --install` output stays pure JSON.** The package manager's stdout must go to stderr, or agents can't parse the result. → Task 2 test `json_install_keeps_stdout_json` (uses a missing package manager, see the test).
2. **pnpm 10 and bun skip postinstall scripts by default**, so `@dif.sh/cli`'s binary never downloads and `dif init` fails with "binary not found". → Task 3 always runs the CLI's `install.js` after the add. It does nothing when the binary is already there. Test `cliInstallScript` resolves the path.
3. **Packages already in package.json** must not be reinstalled or listed as a next step. → Task 1 `missing_packages` tests and Task 2 `json_skips_installed_packages`.
4. **Windows:** `npm`, `pnpm` and `yarn` are `.cmd` shims, so `spawnSync` needs `shell: true` on win32. → Task 3 `runCommand` sets `shell: process.platform === "win32"`. No test (wiring), but check it in review.
5. **No `package.json`** (a Homebrew user runs `dif init` in a Go repo): there's no install step and no install next step. → Task 2 `json_without_package_json_has_no_install_step`.

---

### Task 1: Package-manager logic in Rust

**Files:**
- Create: `cli/crates/dif-cli/src/cmd/init/install.rs`
- Modify: `cli/crates/dif-cli/src/cmd/init.rs` (add `mod install;` next to `mod choices;`)

**Interfaces:**
- Produces:
  - `pub enum PackageManager { Npm, Pnpm, Yarn, Bun }` (`Clone, Copy, Debug, PartialEq, Eq`)
  - `PackageManager::name(self) -> &'static str`: `"npm"`, `"pnpm"`, `"yarn"`, `"bun"`
  - `PackageManager::add_args(self, packages: &[&str]) -> Vec<String>`: the program plus its arguments. npm → `["npm","install",…]`; the others → `[name,"add",…]`
  - `PackageManager::add_line(self, packages: &[&str]) -> String`: `add_args` joined with spaces
  - `pub fn detect_package_manager(files: &[&str], user_agent: Option<&str>) -> PackageManager`: `files` are the file names present in cwd
  - `pub fn missing_packages<'a>(package_json: &str, wanted: &[&'a str]) -> Vec<&'a str>`

- [ ] **Step 1: Write the failing tests** in `#[cfg(test)] mod tests` in `install.rs`:

```rust
#[test]
fn lockfile_picks_the_manager() {
    assert_eq!(detect_package_manager(&["pnpm-lock.yaml"], None), PackageManager::Pnpm);
    assert_eq!(detect_package_manager(&["yarn.lock"], None), PackageManager::Yarn);
    assert_eq!(detect_package_manager(&["bun.lock"], None), PackageManager::Bun);
    assert_eq!(detect_package_manager(&["bun.lockb"], None), PackageManager::Bun);
    assert_eq!(detect_package_manager(&["package-lock.json"], None), PackageManager::Npm);
}

#[test]
fn lockfile_beats_user_agent() {
    let ua = Some("npm/10.8.2 node/v22.11.0 darwin arm64 workspaces/false");
    assert_eq!(detect_package_manager(&["pnpm-lock.yaml"], ua), PackageManager::Pnpm);
}

#[test]
fn user_agent_used_without_lockfile() {
    assert_eq!(detect_package_manager(&[], Some("pnpm/9.12.0 npm/? node/v22.11.0 darwin arm64")), PackageManager::Pnpm);
    assert_eq!(detect_package_manager(&[], Some("yarn/4.5.0 npm/? node/v22.11.0 darwin arm64")), PackageManager::Yarn);
    assert_eq!(detect_package_manager(&[], Some("bun/1.1.30 npm/? node/v22.6.0 darwin arm64")), PackageManager::Bun);
}

#[test]
fn defaults_to_npm() {
    assert_eq!(detect_package_manager(&[], None), PackageManager::Npm);
    assert_eq!(detect_package_manager(&[], Some("garbage")), PackageManager::Npm);
}

#[test]
fn add_line_per_manager() {
    let pkgs = ["@dif.sh/sdk", "@dif.sh/react"];
    assert_eq!(PackageManager::Npm.add_line(&pkgs), "npm install @dif.sh/sdk @dif.sh/react");
    assert_eq!(PackageManager::Pnpm.add_line(&pkgs), "pnpm add @dif.sh/sdk @dif.sh/react");
    assert_eq!(PackageManager::Yarn.add_line(&pkgs), "yarn add @dif.sh/sdk @dif.sh/react");
    assert_eq!(PackageManager::Bun.add_line(&pkgs), "bun add @dif.sh/sdk @dif.sh/react");
}

#[test]
fn missing_skips_deps_and_dev_deps() {
    let pkg = r#"{"dependencies":{"@dif.sh/sdk":"^0.9.0"},"devDependencies":{"@dif.sh/react":"^0.9.0"}}"#;
    assert!(missing_packages(pkg, &["@dif.sh/sdk", "@dif.sh/react"]).is_empty());
    let pkg = r#"{"dependencies":{"react":"^19"}}"#;
    assert_eq!(missing_packages(pkg, &["@dif.sh/sdk", "@dif.sh/react"]), vec!["@dif.sh/sdk", "@dif.sh/react"]);
}

#[test]
fn missing_with_bad_json_wants_all() {
    assert_eq!(missing_packages("not json", &["@dif.sh/sdk"]), vec!["@dif.sh/sdk"]);
}
```

- [ ] **Step 2: Run to see them fail.** Run: `cd cli && cargo test -p dif-cli install::` Expected: compile errors (items not defined).
- [ ] **Step 3: Implement** the Interfaces items. User agent: take the text before the first `/` and match the manager name. Lockfile order: pnpm, yarn, bun, npm.
- [ ] **Step 4: Run to see them pass.** Run: `cd cli && cargo test -p dif-cli install::` Expected: 7 passed.
- [ ] **Step 5: Commit.** `git commit -m "feat(init): detect the package manager and missing packages"`

---

### Task 2: Install step in `dif init`

**Files:**
- Modify: `cli/crates/dif-cli/src/cmd/init.rs` (`Args`, `run_in`, `next_steps`, `report_success`, tests module)
- Modify: `cli/crates/dif-cli/src/cmd/init/ui.rs` (split `report_success`, add `confirm_install`)
- Modify: `docs/init-flow.md`, `docs/cli-contract.md`

**Interfaces:**
- Consumes: Task 1 (`detect_package_manager`, `missing_packages`, `PackageManager::{name, add_args, add_line}`), `Framework::packages()`.
- Produces:
  - `Args.install: bool`: `#[arg(long)]`, doc "Install the SDK packages without asking. Off for --yes and --json." Add `"install"` to `agents_only`'s `conflicts_with_all`.
  - `fn next_steps(surface: &str, install: Option<&str>) -> Vec<String>`: the install line comes first when `Some`, then the existing two steps.
  - `fn pending_install(cwd: &Path, framework: Framework) -> Option<(PackageManager, Vec<&'static str>)>`: `None` without `package.json` or when nothing is missing. Reads the cwd file names and `std::env::var("npm_config_user_agent")`.
  - `fn run_install(cwd: &Path, pm: PackageManager, packages: &[&str], json: bool) -> bool`: `std::process::Command` in `cwd`. Stdin and stderr are inherited. Stdout is inherited, except under `json`, where it is piped to our stderr. Returns success. A spawn error (manager not on PATH) returns false.
  - `ui::report_written(progress: Progress, s: &Summary) -> io::Result<()>`: the first half of today's `report_success` (spinner stop, rows, agent rows).
  - `ui::report_next(s: &Summary, next: &[String]) -> io::Result<()>`: the second half (note and outro).
  - `ui::confirm_install(pm: PackageManager, packages: &[&str]) -> io::Result<bool>`: `cliclack::confirm("Install @dif.sh/sdk and @dif.sh/react with pnpm?").initial_value(true)`. Esc → `Ok(false)`.
  - The JSON payload gains `"installed": [<package>…]` (empty when nothing was installed).

**Flow in `run_in` after the files are written:**
1. `let pending = pending_install(cwd, framework);`
2. Interactive: `ui::report_written`. If pending, ask with `confirm_install` unless `args.install`. On yes, run `run_install`. Failure → `cliclack::log::warning("Install failed. Run: <add_line>")`.
3. Non-interactive: run only if `args.install`.
4. The install next step is `Some(add_line)` when pending and not installed successfully. Otherwise `None`.
5. Interactive → `ui::report_next`; otherwise `report_success(&summary, json, &next, &installed)`.

- [ ] **Step 1: Write the failing tests** in the init.rs tests module. Follow the pattern of the existing JSON tests near the `// json=true keeps this non-interactive` comment, using a temp dir and parsing the JSON:
  - `json_install_step_uses_lockfile_manager`: `package.json` `{}` plus an empty `pnpm-lock.yaml`, framework React, json, no `--install` → `next[0] == "pnpm add @dif.sh/sdk @dif.sh/react"`, `installed == []`, no `node_modules` dir.
  - `json_skips_installed_packages`: `package.json` with `@dif.sh/sdk` in dependencies, framework Sdk → `next.len() == 2`, and `next[0]` starts with `"dif new"`.
  - `json_without_package_json_has_no_install_step`: no `package.json` → `next.len() == 2`.
  - `json_install_keeps_stdout_json`: a new integration test file, `cli/crates/dif-cli/tests/init_install.rs`. `CARGO_BIN_EXE_dif` only exists for integration tests, and mutating the process env in unit tests is not allowed. Run `env!("CARGO_BIN_EXE_dif")` with `init --json --install --framework sdk` in a temp dir with `package.json` `{}` and `PATH` set to an empty temp dir, so the spawn fails. Assert stdout parses as JSON, `installed == []`, `next[0] == "npm install @dif.sh/sdk"`, exit code 0.
  - Update the existing test `next_steps_install_the_framework_adapter` for the new signature.
- [ ] **Step 2: Run to see them fail.** Run: `cd cli && cargo test -p dif-cli init::` Expected: compile errors or failed assertions in the new tests.
- [ ] **Step 3: Implement** the Interfaces and Flow above.
- [ ] **Step 4: Run the full Rust checks** (Global Constraints command). Expected: all pass, clippy clean.
- [ ] **Step 5: Check it by hand.** Build, make a temp dir with `package.json` `{"dependencies":{"react":"^19"}}`, run `cargo run -q -p dif-cli -- init` in it, answer Yes to the install question, and confirm that `node_modules/@dif.sh/react` exists.
- [ ] **Step 6: Docs.** In `init-flow.md`, add an **Install packages** node between *Write files* and *Wrap-up* that covers yes, no, failed, already installed and no package.json. In `cli-contract.md`, add `--install`, the `installed` field, and say that `next[0]` uses the detected manager and is left out when nothing is missing.
- [ ] **Step 7: Commit.** `git commit -m "feat(init): install the SDK packages after scaffolding"`

---

### Task 3: The `create-dif` package

**Files:**
- Create: `cli/packages/create-dif/package.json`, `index.js`, `lib.js`, `lib.test.js`, `README.md`

**Interfaces:**
- `package.json`: `name: "create-dif"`, `version: "0.9.0"`, `type: "module"`, `bin: { "create-dif": "index.js" }`, `files: ["index.js", "lib.js", "README.md"]`, `engines.node: ">=18"`, `scripts.test: "node --test"`, `license: "MIT"`, `publishConfig.access: "public"`, plus repository, homepage and keywords copied from `@dif.sh/cli`.
- `lib.js` exports:
  - `detectPackageManager({ files: string[], userAgent?: string }) -> "npm"|"pnpm"|"yarn"|"bun"`: the same rules as Task 1.
  - `addDevArgs(pm, spec: string) -> string[]`: npm `["npm","install","-D",spec]`, others `[pm,"add","-D",spec]`.
  - `execDifArgs(pm, args: string[]) -> string[]`: npm `["npm","exec","--no","--","dif",...args]`, pnpm `["pnpm","exec","dif",...args]`, yarn `["yarn","run","dif",...args]`, bun `["bun","run","dif",...args]`.
  - `cliInstallScript(cwd: string) -> string | null`: resolves `@dif.sh/cli/install.js` from `cwd` with `createRequire(join(cwd, "package.json"))`, or returns null.
- `index.js` (`#!/usr/bin/env node`, wiring only, no tests):
  1. No `package.json` in cwd → print "create-dif adds dif to an existing app. Run it in your app's folder, next to package.json." and exit 1.
  2. `pm` = `detectPackageManager({ files: readdirSync(cwd), userAgent: process.env.npm_config_user_agent })`.
  3. Print `Installing @dif.sh/cli with <pm>…`, then run `addDevArgs(pm, "@dif.sh/cli@" + ownVersion)`. `ownVersion` is read from its own `package.json`. Non-zero → exit with that code.
  4. If `cliInstallScript(cwd)` is non-null, run `node <script>`. This fetches the binary when pnpm or bun skipped postinstall.
  5. Run `execDifArgs(pm, ["init", ...process.argv.slice(2)])` and exit with its code.
  - `runCommand([cmd, ...args])` = `spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" })`.

- [ ] **Step 1: Write the failing tests** in `lib.test.js` (`node:test`, `node:assert/strict`):
  - `detectPackageManager`: the same cases as Task 1 (each lockfile, lockfile beats UA, UA alone for pnpm/yarn/bun, default npm).
  - `addDevArgs("npm", "@dif.sh/cli@0.9.0")` deep-equals `["npm","install","-D","@dif.sh/cli@0.9.0"]`; `addDevArgs("pnpm", …)` deep-equals `["pnpm","add","-D","@dif.sh/cli@0.9.0"]`.
  - `execDifArgs("npm", ["init","--yes"])` deep-equals `["npm","exec","--no","--","dif","init","--yes"]`; the yarn case deep-equals `["yarn","run","dif","init","--yes"]`.
  - `cliInstallScript`: in a temp dir with `package.json` and `node_modules/@dif.sh/cli/{package.json,install.js}` (package.json `{"name":"@dif.sh/cli"}`), it returns a path ending in `install.js`. In an empty temp dir it returns `null`.
- [ ] **Step 2: Run to see them fail.** Run: `cd cli/packages/create-dif && npm test` Expected: fails (`lib.js` missing).
- [ ] **Step 3: Implement** `lib.js`, then `index.js`.
- [ ] **Step 4: Run to see them pass.** Run: `cd cli/packages/create-dif && npm test` Expected: all pass.
- [ ] **Step 5: README.md:** the usage line `npm create dif@latest` (plus the pnpm, yarn and bun forms), what it does in 3 lines, and that extra args go to `dif init` (`npm create dif@latest -- --yes`).
- [ ] **Step 6: Commit.** `git commit -m "feat: add create-dif to add dif to an existing app"`

---

### Task 4: Release, CI and docs wiring

**Files:**
- Modify: `scripts/prepare-release.sh` (the `for pkg in …` loop: add `create-dif`; fix the comment list)
- Modify: `.github/workflows/release.yml` (after "publish wrapper": steps "sync version (create-dif)" and "publish create-dif", same shape as the wrapper)
- Modify: `.github/workflows/ci.yml` (a step running `npm test` in `cli/packages/create-dif` with Node 22, next to the wrapper checks)
- Modify: `README.md` (Quickstart leads with `npm create dif@latest` in your app's folder; keep the global install as the alternative)
- Modify: `AGENTS.md` (Commands: `create-dif tests: cd cli/packages/create-dif && npm test`)

- [ ] **Step 1:** Make the edits above.
- [ ] **Step 2: Check.** Run `bash -n scripts/prepare-release.sh`. Check that both workflow files still parse with `python3 -c "import yaml,sys;[yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/ci.yml .github/workflows/release.yml`. Expected: no output.
- [ ] **Step 3: Full check.** Run the Rust checks, `node scripts/sync-skills.mjs --check`, and `cd cli/packages/create-dif && npm test`. Expected: all pass.
- [ ] **Step 4: End-to-end by hand.** `npm pack` in `cli/packages/cli` and `cli/packages/create-dif` can't pin an unpublished CLI. Instead, in a temp React app, run `node <repo>/cli/packages/create-dif/index.js` with `@dif.sh/cli@0.9.0` (the published version). Confirm it installs the CLI and that `dif init` starts. Write down that the 0.10.0 flow can only be fully checked after publishing.
- [ ] **Step 5: Commit.** `git commit -m "chore: release and document create-dif"`

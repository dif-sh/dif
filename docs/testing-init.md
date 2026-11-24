# Testing `dif init` from this branch

How to build the CLI from source and try the new `dif init` flow against the real dif analytics, by hand or with Claude Code. For the question order, see [init-flow.md](init-flow.md). For the JSON and Cloud API contract, see [cli-contract.md](cli-contract.md).

## 1. Set up once

You need:

- **Rust:** install with [rustup](https://rustup.rs), then open a new terminal or run `source "$HOME/.cargo/env"`.
- **Node 20 or later:** only for the SDK tests.
- **A dif analytics account** at [cloud.dif.sh](https://cloud.dif.sh), in an org where you're an owner or admin, so you can create projects.

Build the CLI from the repo root:

```sh
cd cli && cargo build -p dif-cli && cd ..
```

The binary is `cli/target/debug/dif`. Put it first on your `PATH` for this terminal, so `dif` means the branch build and not an installed release:

```sh
export PATH="$PWD/cli/target/debug:$PATH"
dif --version
```

Rebuild with `cargo build -p dif-cli` (from `cli/`) after every code change.

## 2. Try it by hand

Always test in a throwaway folder. The interactive flow only runs in a real terminal.

```sh
cd "$(mktemp -d)" && mkdir my-test-app && cd my-test-app
echo '{"name":"my-test-app","devDependencies":{"@sveltejs/kit":"2"}}' > package.json
dif init
```

The `package.json` is optional. It shows framework detection (Svelte is pre-selected) and sets the project name to `my-test-app`.

Keys: **arrows** move, **Space** ticks, **Enter** confirms, **Esc** cancels without writing anything.

> **Signing in creates real data.** "Sign in with your browser" → "Create a new project" creates a real project in your Cloud org. Give test projects an obvious name through `package.json` (for example `zz-test-init`), and delete them from the dashboard afterwards. The CLI can't delete projects.

### Paths worth trying

Start each one in a new folder.

| Try this | You should see |
|---|---|
| Accept everything, sign in, **Create a new project**, tick Marketing + Ecommerce | Browser opens, "Signed in as …", "Created org/my-test-app". `dif/config.yaml` has `project_type`, `key` and `url`. The dashboard link appears in Next steps. The categories show in the dashboard only once Cloud stores `project_type`. |
| Run `dif init` again in the same folder | Only the framework question, then "already up to date" |
| Sign in again in a new folder, pick an **existing** project | "Use your dif.sh login (you@…)", then "Linked org/project" |
| **Paste a publishable key**: first a secret `dif_live_…` key, then your `dif_pk_…` key | Secret key rejected inline; the publishable key is saved |
| **Skip for now** | No key; Next steps shows "Turn on analytics: dif connect" |
| Untick **Analytics** | No events or Cloud questions; config has `analytics: false` |
| **Where should events go?** → Your own handlers | `mode: custom` and `dif/events/exposure.ts` + `track.ts` |
| Press **Esc** at any question | "Operation cancelled", no `dif/` folder |
| Edit `dif/surfaces/home.md`, run `dif init` again | Red ✗ list and "Nothing was written" (exit code 2) |
| `dif init --json`, or `dif init \| cat` | No questions, no logo; plain or JSON output |

### Your login

The login is saved in `~/.config/dif/credentials.json`, and it's shared with any installed `dif`.

```sh
dif auth status --verify   # who you're signed in as
dif auth logout            # sign out and revoke the token
```

## 3. Try the agent path

Agents never see the questions. They run `dif` with `--json` (or without a terminal) and follow the recipe in [cli-contract.md §7](cli-contract.md). To walk through it yourself in a new folder:

```sh
dif init --json --project-type marketing,ecommerce
dif auth status --json
dif auth login --no-wait --json     # open the URL it prints, approve the code
dif auth login --resume --json      # waits until you approve
dif connect --json                  # lists projects: "needs_selection"
dif connect --create --json         # or: --project <slug>
dif build
```

Without `--name`, `dif connect --create` names the project after `project:` in `dif/config.yaml`, which comes from `package.json`. It also sends the config's `project_type`.

## 4. Try it with Claude Code

Start Claude Code in a throwaway folder with the branch build on its `PATH`. From the repo root:

```sh
DIF_BIN="$PWD/cli/target/debug"
cd "$(mktemp -d)" && mkdir zz-test-agent && cd zz-test-agent
echo '{"name":"zz-test-agent","devDependencies":{"@sveltejs/kit":"2"}}' > package.json
git init -q
PATH="$DIF_BIN:$PATH" claude
```

Then ask it what a real user would, for example:

> Set up dif.sh feature flags and A/B testing in this repo. I want analytics connected to dif analytics, so create a new project for it. It's our marketing site with a small shop.

Claude will show you a sign-in link and code. Approve it in your browser; it's waiting and carries on by itself.

Check that it:

- learned the flags from `dif init --help` and used `--json` or `--yes`
- passed `--project-type marketing,ecommerce`
- signed in with `dif auth login --no-wait` and then `--resume`
- ended up with the same name for `project:` in the config and the Cloud project
- ran `dif build` and told you the dashboard link

To run it headless and keep a transcript:

```sh
PATH="$DIF_BIN:$PATH" claude -p "Set up dif.sh in this repo with dif analytics. Create a new project. It's a marketing site with a small shop." \
  --output-format stream-json --verbose --max-turns 40 \
  --permission-mode acceptEdits \
  --allowedTools "Bash(dif:*)" "Bash(ls:*)" "Bash(cat:*)" "Read" "Glob" "Grep" \
  > transcript.jsonl
```

Headless, the sign-in link is only in `transcript.jsonl`. Search it for `verification_uri_complete` and approve the link within 10 minutes.

## 5. Run the automated checks

From the repo root, before you open a PR:

```sh
cd cli && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && cd ..
node scripts/sync-skills.mjs --check
cd cli/packages/sdk && npm install && npm test && cd ../../..
```

The tests cover the logic: names, features, framework detection, config reuse, the Cloud request body. The questions and the browser sign-in can only be checked by hand, with sections 2–4 above.

## 6. Clean up

- `dif auth logout`
- Delete your test projects in the [dashboard](https://cloud.dif.sh)
- Remove the throwaway folders: they're under your temp folder (`echo $TMPDIR`)

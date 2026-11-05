---
name: dif-connect-cloud
description: Connect a dif.sh workspace to dif cloud from the terminal. Signs the dif CLI in with a code the person approves in the browser, links or creates the dif cloud project, writes its publishable key into dif/config.yaml, shows the GitHub App install link and runs dif build. Use when the user wants to connect, link or set up dif cloud, log in or sign up to dif, send events to dif cloud, or mentions dif auth login, dif connect or needs_selection. Other dif skills use it as their "Connect to dif cloud" step.
---

# Connecting to dif cloud

Use this skill to connect the `dif/` workspace in this repo to a dif cloud project. At the end, `dif/config.yaml` has `mode: cloud` and the project's publishable key under `events:`, and `dif build` has put the key into the generated client.

If the person gives you a publishable key (`dif_pk_...`), do not use the steps below. Run `dif connect --key <key> --json`, then `dif build`. That path needs no login and no network.

If `dif` is not on the PATH, use `npx @dif.sh/cli` in place of `dif` in every command. Never use `npx dif`: it can run a different npm package. If `dif auth` is an unknown command, the CLI is older than v0.9.0. Tell the person to update it.

## How to read the CLI

- Add `--json` to every `dif auth` and `dif connect` command. Each prints exactly one JSON object on stdout.
- Branch on `ok` and on the `error` code. Do not branch on `message` or on the exit code number.
- In JSON mode the CLI never prompts. When it needs a choice, you ask the person.

## Step 1. Check the login

```sh
dif auth status --json
```

If `logged_in` is `true`, go to Step 4. This command makes no network call and never prints the token.

## Step 2. Start the login

```sh
dif auth login --no-wait --json
```

It returns at once. Show `verification_uri_complete` and `user_code` to the person, for example:

```
Open https://cloud.dif.sh/cli/activate?code=WDJB-MJHT
Check that the page shows the code WDJB-MJHT, then approve.
```

A person with no dif account can sign up on that page. Do not open the URL yourself. The person approves in their own browser.

If the person is at a terminal and prefers it, they can run `dif auth login` there themselves. It opens the browser and waits. Then go to Step 4.

## Step 3. Wait for the approval

```sh
dif auth login --resume --json
```

- `"status": "logged_in"`: go to Step 4.
- `authorization_pending`: the person has not approved yet. Run the same command again. The CLI keeps the code.
- `access_denied`: the person clicked Deny. Stop and tell them.
- `expired_token`: the code expired. Stop and tell them. Start again at Step 2 only if they ask.
- `no_pending_login`: there is no login to resume. Go to Step 2.

The command waits up to 600 seconds. If your shell stops long commands, add `--timeout 60` and repeat on `authorization_pending`.

## Step 4. Connect the workspace

```sh
dif connect --json
```

On `ok: true`, go to Step 5. On `needs_selection`, the response lists `orgs` and `projects`. Show them to the person and ask for one of these:

- **An existing project.** Run `dif connect --project <slug> --json`.
- **A new project.** Run `dif connect --create --json`. Add `--name <name>` for a name other than the folder name.

Add `--org <slug>` when `orgs` has more than one entry. A project whose `repo` is this repo is usually the right one, but the person decides. Do not pick for them.

## Step 5. Link the GitHub repo

If `repo.status` is `"unlinked"`, show `repo.github_install_url` to the person. Tell them that dif cloud syncs the experiment files from the repo after they install the GitHub App. Events work before the install.

If `repo.status` is `"linked"`, there is nothing to do. Show `dashboard_url` in both cases.

## Step 6. Build

```sh
dif build
```

This writes the key into `dif/generated/client.ts`. `dif connect` changed only `dif/config.yaml`.

## Errors

| `error` | What to do |
|---|---|
| `not_logged_in` | Go to Step 2. |
| `token_invalid` | The login expired or was revoked. If Step 1 showed `"source": "env"`, the `dif_cli_` token in `DIF_TOKEN` is no longer valid. Ask the person to replace or unset it, and stop. Otherwise go to Step 2. |
| `forbidden` | This login cannot do that, for example create a project in that org. Tell the person. They can pick an existing project, or ask an org owner. |
| `org_not_found`, `project_not_found` | The slug is wrong. Run `dif connect --json` with no flags to get the lists again. |
| `no_workspace` | There is no `dif/` folder here. Run `dif init` first. |
| `rate_limited` | Wait `retry_after` seconds, then try once more. |
| `cloud_unreachable`, `cloud_error` | Tell the person and show `message`. Do not retry in a loop. |

## Rules

- Never print, ask for or write a token. The CLI keeps it in `~/.config/dif/credentials.json`.
- Do not run `dif auth logout` unless the person asks.
- Do not edit the `events:` block by hand. `dif connect` writes it.
- Keep `DIF_CLOUD_URL` if the person set it. It points the CLI at a local or self-hosted dif cloud.

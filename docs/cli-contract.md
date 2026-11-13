# dif CLI ↔ Cloud contract (v1)

Status: **frozen**, approved by Chris on 2026-11-05. Version: `cli-contract/1`, with the clarifications listed at the end. Target release: dif CLI v0.9.0.

This file fixes the parts that other code depends on:

- `dif` commands, flags, JSON output and exit codes, which `npx dif-init` and the dif skills call.
- `dif/config.yaml` keys that the initializer writes.
- `/v1/cli/*` Cloud routes, which the CLI calls.

Internals (storage layout, table design, UI copy) are **not** part of the contract.

## Change rule

1. Additive changes are allowed without a version bump: a new optional flag, a new JSON field, or a new `error` code on a path that already fails.
2. Any rename, removal, type change, or change to a meaning needs a new version (`cli-contract/2`). Update this file first, then tell the initializer owner, then change the code.
3. Consumers must ignore JSON fields they don't know about.

---

## 1. Shared CLI rules

**JSON mode.** `--json` is global. In JSON mode the command prints **exactly one JSON object** on stdout and nothing else. Human text and progress go to stderr. Commands never prompt in JSON mode.

**Envelope.** Every object has `ok: boolean`. A failure has `error: string`, a stable snake_case code, and can also carry a free-text `message`. Consumers branch on `error`, never on `message`.

```json
{ "ok": false, "error": "not_logged_in", "message": "run dif auth login" }
```

**Exit codes** (these match the CLI's existing behavior):

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | The command ran and failed (validation failed, network error, server error). |
| `2` | A precondition was not met, so the command did nothing (no workspace, not logged in, needs a choice, bad usage). |

Branch on `error`, not on the exit-code number. Treat any non-zero exit as failure.

**Cloud errors common to all cloud verbs:**

| `error` | Exit | When |
|---|---|---|
| `not_logged_in` | 2 | No usable credential: no `dif_cli_` token in `DIF_TOKEN`, and no credentials file for the current cloud URL. A stored login applies only to the cloud URL that issued it. The current cloud URL is `DIF_CLOUD_URL`, or `https://cloud.dif.sh` when it is unset, so a local login does not apply without `DIF_CLOUD_URL`. |
| `token_invalid` | 2 | The server rejected the token (revoked, expired). The CLI deletes the local credential. |
| `forbidden` | 1 | The token is valid but lacks the role or scope. |
| `cloud_unreachable` | 1 | DNS, TLS, timeout or connection failure. |
| `cloud_error` | 1 | The server answered 5xx or returned a body the CLI can't read. |
| `rate_limited` | 1 | HTTP 429. `retry_after` (seconds) is included. |

**Environment:**

| Variable | Effect |
|---|---|
| `DIF_TOKEN` | Used only when it holds a `dif_cli_…` token; then it wins over the credentials file. Any other value (for example a `dif_pat_` read token for MCP) is ignored with a note on stderr. `dif auth logout` doesn't delete or revoke it. |
| `DIF_CLOUD_URL` | Cloud base URL. The default is `https://cloud.dif.sh`. |

**Local-only commands** (`init`, `new`, `validate`, `build`, `qa`, `conclude`, `scaffold-audiences`, `connect --key`) **never** make network calls and never need login.

---

## 2. `dif init` additions

New flags (all optional):

| Flag | Value | Default |
|---|---|---|
| `--project-type` | comma list of `marketing`, `app`, `ecommerce` | none (the key is left out of config) |
| `--features` | comma list of the **enabled** features: `analytics`, `flags`, `experiments` | all three |
| `--yes` | – | Off. Accepts the default for every prompt. Implied by `--json` or a non-TTY. |

Unchanged: `--surface`, `--events`, `--key`, `--force`, `--agents`, `--agents-only`. `--events cloud` with no `--key` is valid: the workspace is ready for Cloud but has no key yet.

Errors added: `usage` (exit 2) for an unknown value in `--project-type` or `--features`, or for an empty list.

The success JSON adds two fields. `project_type` is always an array, `[]` when the flag is omitted. `features` always lists all three keys.

```json
{
  "ok": true,
  "already_initialized": false,
  "created": ["dif/experiments/active", "…"],
  "next": ["…"],
  "project_type": ["app", "ecommerce"],
  "features": { "analytics": true, "flags": true, "experiments": true }
}
```

## 3. `dif/config.yaml` additions

```yaml
project_type: [app, ecommerce]   # optional
features:                        # optional; a missing block or key means true
  analytics: true
  flags: true
  experiments: true
```

- The fields are additive. Old configs with no `features` block behave as all-on. `dif init` writes the `features` block only when a feature is off.
- `project_type` values outside the three listed load without error; only `dif init --project-type` rejects them.
- `dif build`: `experiments: false` leaves out experiment registrations. `flags: false` has no build effect yet, because there is no flag-only codegen. `dif validate` warns (`W005`, it does not fail) when `experiments: false` and active experiments exist.
- **Reserved:** what `analytics: false` removes from the generated client is decided separately. The key and its type are frozen now.
- The initializer may write these keys itself or through `dif init` flags. The flags are the preferred path.

---

## 4. `dif auth`

Credentials go to `$XDG_CONFIG_HOME/dif/credentials.json` (default `~/.config/dif/`) with mode `0600`. The file format is internal.

### `dif auth login`

There are three ways to run it.

**a) Interactive** (a person at a terminal, or the initializer with `stdio: inherit`). The command prints the URL and code to stderr, opens the browser (unless `--no-browser`), and polls until approval. With `--json`, it prints only the final object.

**b) Agent, step 1: `dif auth login --no-wait --json`.** It starts the device flow, stores the pending code locally, and returns at once. The agent shows the URL and code to the person.

```json
{
  "ok": true,
  "status": "pending",
  "verification_uri": "https://cloud.dif.sh/cli/activate",
  "verification_uri_complete": "https://cloud.dif.sh/cli/activate?code=WDJB-MJHT",
  "user_code": "WDJB-MJHT",
  "expires_in": 600
}
```

**c) Agent, step 2: `dif auth login --resume --json`.** It polls the stored pending code until approval, denial or expiry. Add `--timeout <seconds>` (default 600) to return earlier with `authorization_pending`, so the agent can call it again.

Success, for (a) and (c):

```json
{
  "ok": true,
  "status": "logged_in",
  "user": { "id": "uuid", "email": "dev@example.com" },
  "expires_at": "2027-02-03T00:00:00Z"
}
```

| `error` | Exit | When |
|---|---|---|
| `authorization_pending` | 2 | `--resume` hit `--timeout` before approval. The pending code is kept. |
| `access_denied` | 1 | The person clicked Deny. The pending code is cleared. |
| `expired_token` | 1 | The code expired. Start again. |
| `no_pending_login` | 2 | `--resume` ran with no stored pending code. |

When already logged in, `login` starts a new flow and replaces the credential on success.

### `dif auth status`

It never makes a network call unless you add `--verify`. It never prints the token.

```json
{ "ok": true, "logged_in": false }
```

```json
{
  "ok": true,
  "logged_in": true,
  "source": "file",
  "cloud_url": "https://cloud.dif.sh",
  "user": { "id": "uuid", "email": "dev@example.com" },
  "expires_at": "2027-02-03T00:00:00Z"
}
```

`source` is either `"file"` or `"env"`. For `"env"` without `--verify`, `user` and `expires_at` are left out, because the CLI can't know them without a network call. With `--verify`, a server rejection returns `token_invalid`.

### `dif auth logout`

It revokes the token on the server (best-effort) and deletes the local credential. A logout with no credential still succeeds.

```json
{ "ok": true, "revoked": true }
```

`revoked: false` means the server call failed or there was no credential. The local file is gone either way.

---

## 5. `dif connect` (logged-in path)

`dif connect --key dif_pk_…` is unchanged: no network, no login.

When there is no `--key`, the command needs login. It writes the project's publishable key into `dif/config.yaml` and sets `events.mode: cloud`.

| Flag | Meaning |
|---|---|
| `--org <slug>` | Org to use. Optional when the user has exactly one. |
| `--project <slug>` | Link to an existing project. |
| `--create` | Create a new project. Can't be combined with `--project`. |
| `--name <name>` | Name for `--create`. The default is the workspace folder name. |

On a TTY with none of these flags, the CLI prompts. In JSON mode or on a non-TTY, it returns `needs_selection` so that the caller can ask the person:

```json
{
  "ok": false,
  "error": "needs_selection",
  "orgs": [{ "slug": "acme", "name": "Acme" }],
  "projects": [{ "slug": "acme-shop", "name": "acme-shop", "org": "acme", "repo": "acme/shop" }]
}
```

`needs_selection` exits with 2. `projects` lists the selected org only, or every org when `--org` is missing. `repo` is `null` for a project that has no repo yet. With `--create` and several orgs, the caller must add `--org <slug>`.

Success:

```json
{
  "ok": true,
  "project": { "slug": "acme-shop", "org": "acme", "created": true },
  "config": "dif/config.yaml",
  "mode": "cloud",
  "switched_from_custom": false,
  "dashboard_url": "https://cloud.dif.sh/acme-shop",
  "repo": { "status": "unlinked", "detected": "acme/shop", "github_install_url": "https://github.com/apps/dif-sh/installations/new?state=…" },
  "next": "dif build"
}
```

`repo.status` takes one of these values:

- `"linked"`: the project already has a repo; `github_install_url` is left out.
- `"unlinked"`: show `github_install_url` to the person. Spec sync starts after the install. `github_install_url` is `null` when the Cloud has no GitHub App configured (local or self-hosted).

`dashboard_url` is `<cloud_url>/<slug>` for an existing project too.

`repo.detected` comes from `git remote get-url origin` when it points at GitHub, and is `null` otherwise.

| `error` | Exit | When |
|---|---|---|
| `no_workspace` | 2 | No `dif/` here. This error is unchanged. |
| `org_not_found` / `project_not_found` | 2 | An unknown slug was passed. |
| `usage` | 2 | `--project` was combined with `--create`, or `--url` names a host other than the login's. |

---

## 6. Cloud routes: `/v1/cli/*`

All routes take and return JSON with `cache-control: no-store`. Errors follow the existing Cloud shape `{ "error": "<code>" }` plus an HTTP status. Authenticated routes take `Authorization: Bearer dif_cli_…`. A malformed body gives 400 `bad_request`. `user.email` can be `null`.

### `POST /v1/cli/device`
No auth. Rate-limited per IP.

```json
// request
{ "client_name": "dif", "client_version": "0.9.0", "hostname": "chris-mbp" }
// 200
{
  "device_code": "opaque",
  "user_code": "WDJB-MJHT",
  "verification_uri": "https://cloud.dif.sh/cli/activate",
  "verification_uri_complete": "https://cloud.dif.sh/cli/activate?code=WDJB-MJHT",
  "interval": 5,
  "expires_in": 600
}
```

### `POST /v1/cli/token`
No bearer auth. The device code is the credential.

```json
// request
{ "device_code": "opaque" }
// 200, sent once per approval
{ "token": "dif_cli_…", "expires_at": "…", "user": { "id": "uuid", "email": "…" } }
```

Errors (400): `authorization_pending`, `slow_down`, `access_denied`, `expired_token`. On `slow_down`, the client adds 5 seconds to its interval. A second redeem after success, or an unknown `device_code`, returns `expired_token`.

### `GET /v1/cli/whoami`
```json
{ "user": { "id": "uuid", "email": "…" }, "orgs": [{ "slug": "acme", "name": "Acme", "role": "owner" }], "expires_at": "…" }
```
Each successful authenticated call slides `expires_at` to now + 90 days.

### `GET /v1/cli/projects?org=<slug>`
`org` is optional.
```json
{ "projects": [{ "slug": "acme-shop", "name": "acme-shop", "org": "acme", "repo": "acme/shop", "role": "owner" }] }
```
`repo` is `null` for a project that has no repo yet.

### `POST /v1/cli/projects`
Scope: `project:create`. The caller must be an org owner or admin. A paid plan is **not** required; the dashboard needs one.
```json
// request
{ "org": "acme", "name": "acme-shop", "repo_full_name": "acme/shop", "project_type": ["marketing", "ecommerce"] }
// 201
{
  "slug": "acme-shop",
  "project_key": "dif_pk_live_…",
  "dashboard_url": "https://cloud.dif.sh/acme-shop",
  "repo": { "status": "unlinked", "github_install_url": "https://github.com/apps/dif-sh/installations/new?state=…" }
}
```
`repo_full_name` is optional and only a hint. The GitHub App install binds the repo; the hint does not.

`project_type` is optional: the project categories from `dif/config.yaml` (`marketing`, `app`, `ecommerce`). The CLI leaves it out when the config has none. `dif init` and `dif connect --create` both send it.

Errors: `org_not_found` (404, also for an org the caller is not in) and `forbidden` (403, a member who is not owner or admin). `repo.github_install_url` can be `null` (see section 5).

### `GET /v1/cli/projects/:slug/key`
Scope: `keys:read`. The caller must be a project member. A paid plan is not required.
```json
{ "project_key": "dif_pk_live_…", "repo": { "status": "linked" } }
```
An unlinked project returns `"repo": { "status": "unlinked", "github_install_url": "…" }`. Errors: `project_not_found` (404, also for a project the caller can't read).

### `POST /v1/cli/logout`
It revokes the calling token.
```json
{ "revoked": true }
```

**Shared auth errors:** `unauthorized` (401: a missing, malformed, revoked or expired token) and `forbidden` (403). The CLI maps them to `token_invalid` and `forbidden`.

---

## 7. Recipe: the "Connect to dif Cloud" step in skills and the initializer

1. `dif auth status --json`. If `logged_in` is true, go to step 4.
2. `dif auth login --no-wait --json`. Show `verification_uri_complete` and `user_code` to the person.
3. `dif auth login --resume --json`. On `authorization_pending`, call it again. On `access_denied` or `expired_token`, stop and tell the person.
4. `dif connect --json`. On `needs_selection`, ask the person to pick a project or to create one, then run it again with `--project <slug>`, or `--create` (add `--org <slug>` when `orgs` lists more than one).
5. If `repo.status` is `"unlinked"`, show `github_install_url`.
6. `dif build`.

The initializer can skip steps 2–3 and run `dif auth login` interactively with `stdio: inherit`.

---

## Clarifications (2026-11-05, after the build)

These tighten cases that v1 left open. None of them changes a name, a type or a documented meaning, so the version stays `cli-contract/1`.

- `DIF_TOKEN` is used only for `dif_cli_` tokens (section 1).
- A stored login applies only to the cloud URL that issued it, and the default is `https://cloud.dif.sh` (section 1).
- On the logged-in path, `--url` must match the login host (section 5).
- `project_type: []` when omitted; `features` written to config only when a feature is off; unknown `project_type` strings load (sections 2–3).
- `dif build` effect per feature is spelled out (section 3).
- `dif auth status` with `source: "env"` omits `user` and `expires_at` without `--verify` (section 4).
- `repo` can be `null`, `github_install_url` can be `null`, `--create` with several orgs needs `--org` (sections 5–7).
- No paid plan is needed to create a project or read its key. Additive errors: `bad_request`, `project_not_found` on the key route (section 6).

# dif.sh Documentation Draft

> Implementation-aligned public documentation for the dif.sh CLI, SDK, React
> adapter, and Svelte adapter.

dif.sh is experimentation-as-code. Experiments are Markdown files checked into
your repository, `dif validate` checks them for correctness, and `dif build`
compiles active experiments into a small TypeScript runtime definition.

The source of truth stays in Git:

```text
experiment Markdown + surface Markdown + config
                         |
                         | dif validate
                         v
                  correctness checks
                         |
                         | dif build
                         v
          generated client + audience wiring + context
                         |
                         v
              @dif.sh/sdk and framework adapters
```

## Installation

### Standalone binary

macOS and Linux:

```sh
curl -fsSL https://dif.sh/install.sh | sh
```

The installer places `dif` in `$HOME/.local/bin` by default. Override the
destination with `DIF_INSTALL_DIR`:

```sh
curl -fsSL https://dif.sh/install.sh | DIF_INSTALL_DIR="$HOME/bin" sh
```

Install a specific release:

```sh
curl -fsSL https://dif.sh/install.sh | sh -s -- --version v0.4.3
```

### Homebrew

```sh
brew install dif-sh/tap/dif
```

### npm CLI wrapper

```sh
npm install -g @dif.sh/cli
dif --help
```

The npm package requires Node.js 18 or newer. Its postinstall script downloads
the matching Rust binary for:

- macOS on Apple Silicon or Intel
- Linux on x86_64 or arm64
- Windows on x86_64

The SDK and framework packages require Node.js 20.6 or newer.

## Quick Start

Run these commands from the root of an application repository:

```sh
dif init --surface checkout
dif new checkout-cta-v2 --surface checkout --owner ada@example.com
```

Edit `dif/experiments/active/checkout-cta-v2.md`, replace the placeholder
content, and change:

```yaml
status: draft
```

to:

```yaml
status: active
```

Then validate and build:

```sh
dif validate
dif build
```

Install the browser SDK:

```sh
npm install @dif.sh/sdk
```

Import the generated registry once, initialize the SDK, and render the
experiment:

```ts
import "./dif/generated/client";
import { attributes } from "./dif/generated/audiences";
import { dif } from "@dif.sh/sdk";

dif.init({
  project: "acme-shop",
  publishableKey: "dif_pk_live_example",
  userId: () => currentUser?.id ?? null,
  attributes: () => attributes({
    plan: currentUser?.plan ?? null,
  }),
});

const checkoutCta = dif("checkout-cta-v2", {
  control: () => "Place order",
  variant_a: () => "Get it today",
});

button.textContent = checkoutCta();
```

The import of `dif/generated/client` is important. The generated module
registers active experiments with the SDK as a side effect.

## Workspace Layout

A fully built dif workspace uses this structure:

```text
dif/
  config.yaml
  .gitignore
  context.json             # created by dif build
  audiences/
    locale.ts
    device_type.ts
  experiments/
    active/
    concluded/
  generated/
    client.ts              # created by dif build
    audiences.ts           # created by dif build
  surfaces/
    home.md
```

`dif init` creates the directories, config, starter resolvers, and surface.
The generated TypeScript files and `context.json` appear after `dif build`.

`dif/generated/` is ignored by the generated `dif/.gitignore`.
`dif/context.json` lives outside that directory and is intended to be visible
to coding agents and other repository tooling.

By default, `dif init` also adds dif guidance to:

```text
CLAUDE.md
AGENTS.md
.cursorrules
.claude/skills/dif-author-experiment/
.claude/skills/dif-conclude-experiment/
.claude/skills/dif-generate-surfaces/
```

Existing content in `CLAUDE.md`, `AGENTS.md`, and `.cursorrules` is preserved.
dif owns only its marked managed block inside those files.

## Project Configuration

The project configuration is stored in `dif/config.yaml`.

```yaml
project: acme-shop
default_surface: home

audience_attributes:
  - name: locale
    type: string
  - name: device_type
    type: enum
    values: [mobile, tablet, desktop]
  - name: returning_visitor
    type: boolean
  - name: lifetime_value
    type: number

bucketing:
  id: user_id
  fallback: anon_cookie

exposure:
  sink: webhook
  fire_at: render

build:
  out: dif/generated
  fail_on: [conflict, orphan_ref, missing_owner]
  commit_generated: false
```

### Configuration fields

| Field | Description |
| --- | --- |
| `project` | Human-readable project identifier. |
| `default_surface` | Default surface recorded by the scaffold. `dif new` currently still requires `--surface`. |
| `audience_attributes` | Closed schema of attributes experiments may reference. |
| `audience_attributes[].type` | One of `string`, `boolean`, `number`, or `enum`. |
| `audience_attributes[].values` | Allowed values for an `enum` declaration. |
| `bucketing.id` | Name of the primary identity field. |
| `bucketing.fallback` | Intended fallback identity strategy, commonly `anon_cookie`. |
| `exposure.sink` | Project-level sink declaration. Runtime SDK sinks are configured separately in `dif.init`. |
| `exposure.fire_at` | Exposure lifecycle convention. Use `render`. |
| `build.out` | Output directory for generated TypeScript. Defaults to `dif/generated`. |
| `build.fail_on` | Reserved build policy configuration. Current validation errors always fail the build and warnings do not. |
| `build.commit_generated` | Records whether generated files are intended to be committed. It does not currently change CLI behavior. |

## Surfaces

A surface is a logical area of the product where experiments run. Each surface
has a Markdown file at `dif/surfaces/<name>.md`.

```md
# Surface: checkout

The checkout surface covers the final cart review and payment action.

## Known landmines

- The payment button is controlled by the payment provider after submission.
- Avoid layout changes that move the tax disclosure.

## Learnings

- 2026-05-28 - checkout-trust-copy: Trust copy did not change conversion.
```

The surface ID comes from the filename, not the heading. In the example above,
the ID is `checkout` because the file is `dif/surfaces/checkout.md`.

`dif new` reads up to the first three parsed learning entries and inserts them
as a comment in the new experiment brief. `dif conclude` prepends the newest
learning under `## Learnings`.

## Experiment Files

Experiments are Markdown files with YAML frontmatter:

```md
---
id: checkout-cta-v2
status: active
owner: ada@example.com
surface: checkout
hypothesis: >
  More specific checkout copy will increase completed checkout rate
  among mobile and tablet users.
audience:
  include:
    - device_type: [mobile, tablet]
  exclude:
    - locale: fr-FR
variants:
  - id: control
    weight: 50
    summary: Existing "Place order" copy
  - id: variant_a
    weight: 50
    summary: New "Get it today" copy
metrics:
  primary: completed_checkout
  guardrails:
    - refund_rate
exclusion_group: checkout-copy
created: 2026-06-12
concluded: null
---

## Brief

Describe the user problem, proposed change, and expected result.

## Rationale

Explain the evidence and why this test is the appropriate next step.

## Decision

<!-- drafted by `dif conclude` -->
```

### Frontmatter fields

| Field | Required | Description |
| --- | --- | --- |
| `id` | Yes | Unique experiment ID. Use kebab-case and keep it equal to the active filename stem. |
| `status` | Yes | `draft`, `active`, `concluded`, or `archived`. |
| `owner` | Yes | Accountable owner in email form. |
| `surface` | Yes | Must match a file in `dif/surfaces/`. |
| `hypothesis` | Yes | Free-form hypothesis text. |
| `audience` | No | Include and exclude predicates. Omitted means everyone. |
| `variants` | Yes | Ordered variants and integer weights. Weights must total 100. |
| `metrics.primary` | Yes | Primary outcome metric. |
| `metrics.guardrails` | No | Metrics that should not regress. |
| `exclusion_group` | No | Shared coordination key for potentially overlapping experiments. |
| `created` | Yes | Creation date in `YYYY-MM-DD` form. |
| `concluded` | No | Conclusion date, normally set by `dif conclude`. |

Only experiments with `status: active` are emitted by `dif build` and assigned
by `dif qa`. A file may remain in `dif/experiments/active/` while its status is
`draft`.

### Audience predicates

`include` predicates are ANDed. Any matching `exclude` predicate disqualifies
the user.

```yaml
audience:
  include:
    - locale: en-US
    - device_type: [mobile, tablet]
  exclude:
    - plan: free
```

Supported comparisons:

- A scalar uses strict equality.
- A YAML list means membership in that list.
- Multiple keys in one predicate map must all match.
- A missing or `null` included attribute fails closed.

There are no range, regex, asynchronous, or custom operator expressions.

Every referenced attribute must:

1. Be declared in `dif/config.yaml`.
2. Have a resolver at `dif/audiences/<name>.ts`.
3. Return a scalar compatible with its declaration.

Example resolver:

```ts
// dif/audiences/plan.ts
export default function resolve(): string | null {
  return window.currentUser?.plan ?? null;
}
```

`dif build` includes only resolvers referenced by active experiments in the
generated `audiences.ts` module.

## CLI Reference

Run `dif` from the repository root or any descendant directory. The CLI walks
upward until it finds `dif/config.yaml`.

```text
Usage: dif [OPTIONS] <COMMAND>
```

Commands:

```text
init
new
validate
build
qa
conclude
scaffold-audiences
```

### Global `--json`

All commands accept the global `--json` option:

```sh
dif --json validate
dif validate --json
```

Use it in CI, editor integrations, or scripts that need stable structured
output. Errors that prevent workspace loading, such as malformed
`dif/config.yaml`, are still printed by the top-level CLI error handler.

### `dif init`

Scaffold a dif workspace in the current directory.

```text
Usage: dif init [OPTIONS]

Options:
  --surface <SURFACE>
  --force
  --no-agent-files
  --json
```

Basic usage:

```sh
dif init
dif init --surface checkout
```

Defaults:

- The default surface is `home`.
- Agent onboarding files are installed.
- Existing dif-owned structural files are not overwritten.

Files and directories created:

```text
dif/config.yaml
dif/.gitignore
dif/audiences/locale.ts
dif/audiences/device_type.ts
dif/experiments/active/
dif/experiments/concluded/
dif/generated/
dif/surfaces/<surface>.md
```

The command also writes or updates the agent guidance files unless
`--no-agent-files` is passed:

```sh
dif init --no-agent-files
```

If a structural file such as `dif/config.yaml` or the requested surface
already exists, initialization refuses to continue:

```sh
dif init --force
```

`--force` overwrites dif-owned structural files and generated skill files. It
does not erase user-authored content around the dif managed blocks in shared
root files.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Workspace created. |
| `2` | Existing structural files were found without `--force`. |
| `1` | An unexpected filesystem or command error occurred. |

### `dif scaffold-audiences`

Add the starter audience resolver files to an existing project.

```text
Usage: dif scaffold-audiences [OPTIONS]

Options:
  --force
  --json
```

```sh
dif scaffold-audiences
```

This command creates `dif/audiences/` if needed and writes:

```text
dif/audiences/locale.ts
dif/audiences/device_type.ts
```

It is idempotent. Existing files are preserved unless `--force` is supplied:

```sh
dif scaffold-audiences --force
```

The command never modifies `dif/config.yaml`. It prints the declaration snippet
that should be added under `audience_attributes`.

Exit code `0` means the scaffold operation completed, including when existing
files were intentionally kept.

### `dif new`

Create a draft experiment.

```text
Usage: dif new [OPTIONS] --surface <SURFACE> <ID>

Arguments:
  <ID>

Options:
  --surface <SURFACE>
  --owner <OWNER>
  --from <EXPERIMENT_ID>
  --json
```

Example:

```sh
dif new checkout-cta-v2 \
  --surface checkout \
  --owner ada@example.com
```

`--surface` is required and must match an existing file under
`dif/surfaces/`.

If `--owner` is omitted, dif runs:

```sh
git config user.email
```

The command fails when no owner can be resolved.

The generated experiment:

- Is written to `dif/experiments/active/<id>.md`.
- Starts with `status: draft`.
- Uses today's UTC date for `created`.
- Starts with `control` and `variant_a`, each weighted at 50.
- Includes up to three recent surface learnings in an HTML comment.
- Includes placeholders for the hypothesis, primary metric, brief, rationale,
  and decision.

Clone the audience, variants, and exclusion group from another active or
concluded experiment:

```sh
dif new checkout-cta-v3 \
  --surface checkout \
  --from checkout-cta-v2
```

`--from` does not copy the source experiment's owner, metrics, hypothesis,
status, or body.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Draft created. |
| `1` | Owner could not be resolved or an unexpected error occurred. |
| `2` | The ID already exists, or the `--from` experiment was not found. |
| `3` | The requested surface does not exist. |

### `dif validate`

Validate the complete workspace without writing files.

```text
Usage: dif validate [OPTIONS]

Options:
  --schema-only
  --json
```

```sh
dif validate
```

Validation is collect-all rather than fail-fast. One run reports every
diagnostic that can be determined from the loaded workspace.

The validator reads:

- `dif/config.yaml`
- Every direct `.md` file in `dif/experiments/active/`
- Every direct `.md` file in `dif/experiments/concluded/`
- Every direct `.md` file in `dif/surfaces/`
- Resolver filenames in `dif/audiences/`
- JavaScript and TypeScript source files used for orphan call-site detection

Call-site scanning covers `.js`, `.jsx`, `.ts`, and `.tsx` files. It skips
`.git`, `node_modules`, `target`, `dist`, `build`, and the entire `dif`
directory. The current scanner recognizes literal double-quoted calls such as:

```ts
dif("checkout-cta-v2", branches);
```

The following checks run:

| Code | Severity | Check |
| --- | --- | --- |
| `E001` | Error | Experiment frontmatter, required fields, YAML, or surface structure is invalid. |
| `E003` | Error | `owner` is not a syntactically valid email. |
| `E004` | Error | An experiment references a missing surface. |
| `E005` | Error | Variant weights do not total exactly 100. |
| `E006` | Error | An audience predicate uses an undeclared attribute. |
| `E007` | Error | Active experiments on the same surface may overlap without a shared exclusion group. |
| `E008` | Error | A declared audience attribute has no matching resolver file. |
| `W001` | Warning | A scanned `dif("id", ...)` call references no active experiment. |
| `W002` | Warning | An audience resolver file has no matching config declaration. |

`E007` is conservative. Two same-surface experiments pass when either:

- They share the same `exclusion_group`.
- Their include predicates are provably disjoint on at least one attribute.

For example, `country: US` and `country: UK` are provably disjoint. More
complex application-specific reasoning may not be. Use an explicit shared
group when the validator cannot prove separation.

`--schema-only` is reserved for a future fast editor path. It currently runs
the same complete validation suite:

```sh
dif validate --schema-only
```

JSON output:

```sh
dif validate --json
```

```json
{
  "ok": false,
  "errors": [
    {
      "code": "E005",
      "message": "variant weights sum to 90, expected 100",
      "file": "dif/experiments/active/checkout-cta-v2.md",
      "line": 1,
      "column": 1,
      "help": "Distribute the variants so the weights total 100."
    }
  ],
  "warnings": []
}
```

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | No errors. Warnings may still be present. |
| `1` | One or more validation errors, or workspace loading failed. |

### `dif build`

Validate the workspace and generate runtime artifacts.

```text
Usage: dif build [OPTIONS]

Options:
  --out <OUT>
  --json
```

```sh
dif build
```

The command runs the same validation suite as `dif validate`. No generated
files are written when validation has errors.

Default outputs:

```text
dif/generated/client.ts
dif/generated/audiences.ts
dif/context.json
```

#### `client.ts`

The client module contains one internal registration call per active
experiment, sorted by experiment ID. Each registration includes:

- Experiment ID and surface
- Ordered variant IDs
- Deterministic bucketing salt
- Variant weights
- Exclusion group metadata
- Compiled audience predicate

Import it once before using `dif()`:

```ts
import "./dif/generated/client";
```

The current generated client registers experiments by side effect. It does not
export a named function for each experiment.

#### `audiences.ts`

The generated audience module imports only resolver files referenced by active
experiments:

```ts
import { attributes } from "./dif/generated/audiences";

dif.init({
  attributes: () => attributes({
    plan: currentUser?.plan ?? null,
  }),
});
```

Values passed to `attributes(overrides)` win over resolver-produced values with
the same key.

#### `context.json`

The context file contains:

- Generation timestamp
- Active experiment IDs, surfaces, variants, and run duration
- Surface names and their most recent learning
- Project conventions derived from configuration

`client.ts` and `audiences.ts` are deterministic for identical inputs.
`context.json` intentionally contains a generation timestamp and changes on
each build.

Override the TypeScript output directory:

```sh
dif build --out src/generated/dif
```

Relative paths are resolved from the workspace root. The context file is still
written to `dif/context.json`.

Keep `--out` inside the workspace. Audience imports are generated relative to
the workspace root.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Validation and generation succeeded. |
| `1` | Validation, workspace loading, or file generation failed. |

### `dif qa`

Trace experiment assignment for a user and generate preview links.

```text
Usage: dif qa [OPTIONS]

Options:
  --user <USER>
  --force <EXP=VARIANT>
  --attr <KEY=VALUE>
  --preview-url <URL>
  --json
```

Trace a known user:

```sh
dif qa --user u_8131
```

If `--user` is omitted, dif creates a time-seeded synthetic ID. Repeated runs
therefore sample different buckets:

```sh
dif qa
```

Supply audience attributes with repeatable `--attr` options:

```sh
dif qa \
  --user u_8131 \
  --attr locale=en-US \
  --attr device_type=mobile \
  --attr returning_visitor=true \
  --attr lifetime_value=42
```

Attribute values are parsed as YAML, so strings, numbers, booleans, and null
values keep their types.

The trace reports one outcome per active experiment:

- Assigned variant and bucket
- Forced variant
- Audience miss
- Exclusion-group loss and winning experiment

Experiments in the same exclusion group are prioritized by earliest
`created` date, then by experiment ID.

Force one or more variants:

```sh
dif qa \
  --user u_8131 \
  --force checkout-cta-v2=variant_a \
  --force pricing-headline=control
```

A force bypasses that experiment's audience predicate. Within a shared
exclusion group, the earliest forced experiment in group priority order wins.

Add `--preview-url` to generate a browser link:

```sh
dif qa \
  --force checkout-cta-v2=variant_a \
  --preview-url https://staging.example.com/checkout
```

The result uses the `_dif` query parameter:

```text
https://staging.example.com/checkout?_dif=checkout-cta-v2%3Dvariant_a
```

The browser SDK and framework adapters persist the force in a session cookie.
Forced assignments do not emit exposure events.

Use real experiment and variant IDs in forces. Browser SDKs ignore a forced
variant that is not declared by the experiment.

JSON output:

```sh
dif qa --json --user u_8131 --attr locale=en-US
```

```json
{
  "user_id": "u_8131",
  "assignments": [
    {
      "experiment": "checkout-cta-v2",
      "surface": "checkout",
      "outcome": "assigned",
      "variant": "variant_a",
      "bucket": 7162
    }
  ],
  "preview_url": null
}
```

A successful trace exits `0`. Invalid `--force` or `--attr` syntax, malformed
YAML values, or workspace loading errors exit `1`.

### `dif conclude`

Conclude an active experiment and record its learning.

```text
Usage: dif conclude [OPTIONS] <ID>

Options:
  --decision <DECISION>
  --skip-learning
  --json
```

Inline decision:

```sh
dif conclude checkout-cta-v2 \
  --decision "Shipped variant_a. Completed checkout increased 2.1%."
```

Without `--decision`, dif opens `$EDITOR`, then `$VISUAL`, then `vi`:

```sh
dif conclude checkout-cta-v2
```

The decision must be non-empty.

On success, the command:

1. Changes `status: active` to `status: concluded`.
2. Sets or inserts `concluded: <today>`.
3. Replaces the `## Decision` section body.
4. Moves the file to
   `dif/experiments/concluded/<YYYY-MM>-<id>.md`.
5. Prepends a learning to the experiment's surface.

The first line of the decision becomes the surface learning summary, prefixed
with the conclusion date and experiment ID.

Skip the surface update only for exceptional automation cases:

```sh
dif conclude checkout-cta-v2 \
  --decision "Stopped because the upstream dependency was removed." \
  --skip-learning
```

The command computes edits before writing and performs best-effort rollback if
a later filesystem operation fails.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Experiment concluded. |
| `1` | Experiment or surface was missing, the decision was empty, the editor failed, or a filesystem operation failed. |

## Browser SDK

Install:

```sh
npm install @dif.sh/sdk
```

### Register generated experiments

Import the generated client once at application boot:

```ts
import "./dif/generated/client";
```

Without this import, the SDK has no registered experiment definitions. An
unknown experiment safely returns the first branch, but does not bucket or emit
an exposure.

### Initialize

```ts
import { dif } from "@dif.sh/sdk";
import { attributes } from "./dif/generated/audiences";

dif.init({
  project: "acme-shop",
  publishableKey: "dif_pk_live_example",
  apiUrl: "https://cloud.dif.sh",
  userId: () => currentUser?.id ?? null,
  attributes: () => attributes({
    plan: currentUser?.plan ?? null,
  }),
  enabled: true,
});
```

`dif.init` configures a module-level singleton. Calling it again replaces the
previous state.

### `DifInitConfig`

| Option | Default | Description |
| --- | --- | --- |
| `project` | `undefined` | Project slug carried by configuration. |
| `publishableKey` | `undefined` | Browser-safe Cloud write key. |
| `apiUrl` | `https://cloud.dif.sh` | Cloud or self-hosted API base URL. |
| `userId` | `() => null` | Resolves the current user ID at assignment time. |
| `attributes` | `() => ({})` | Resolves the current audience attribute bag. |
| `sink` | Cloud sink when a publishable key exists, otherwise none | Exposure sink or array of sinks. Pass `[]` to disable exposure delivery. |
| `enabled` | `true` | Global assignment and tracking kill switch. |
| `overrides` | `{}` | Initial QA experiment-to-variant forces. |

`dif.configure(config)` remains available as a deprecated alias for
`dif.init(config)`.

### Render an experiment

`dif(id, branches)` returns a zero-argument function. Call that returned
function at the render site:

```ts
const cta = dif("checkout-cta-v2", {
  control: () => "Place order",
  variant_a: () => "Get it today",
});

const text = cta();
```

Branches can return any common type:

```ts
const checkoutStyle = dif("checkout-style", {
  control: () => ({ color: "blue", size: "md" }),
  variant_a: () => ({ color: "green", size: "lg" }),
});
```

Keep branch keys synchronized with the variants in the experiment Markdown.
The current generated module does not create a named, experiment-specific
TypeScript wrapper, so this relationship is checked by project validation and
runtime registration rather than by a generated function signature.

Assignment behavior:

1. A valid QA force wins and emits no exposure.
2. An uninitialized or disabled SDK returns the experiment's first variant.
3. A missing user ID returns the first variant and emits no exposure.
4. An audience miss returns the first variant and emits no exposure.
5. An eligible user is deterministically bucketed from experiment salt and
   user ID.
6. The chosen variant is selected from cumulative weights.
7. One exposure is emitted per `(experiment, user)` for the lifetime of the
   loaded SDK module.

Calling `dif()` with an empty branches object throws an error.

### Exposure sinks

When `publishableKey` is set and `sink` is omitted, the SDK automatically sends
exposures to:

```text
POST <apiUrl>/v1/exposure
Authorization: Bearer <publishableKey>
```

Opt out:

```ts
dif.init({
  publishableKey: "dif_pk_live_example",
  sink: [],
});
```

Use a webhook:

```ts
import { dif, webhookSink } from "@dif.sh/sdk";

dif.init({
  userId: () => currentUser.id,
  sink: webhookSink("https://events.example.com/dif"),
});
```

Combine Cloud and another sink:

```ts
import { dif, cloudSink, segmentSink } from "@dif.sh/sdk";

dif.init({
  publishableKey: "dif_pk_live_example",
  sink: [
    cloudSink({
      apiUrl: "https://cloud.dif.sh",
      publishableKey: "dif_pk_live_example",
    }),
    segmentSink(window.analytics),
  ],
});
```

Bundled sink factories:

```ts
cloudSink({ apiUrl, publishableKey });
webhookSink(url);
segmentSink(analytics);
amplitudeSink(amplitude);
mixpanelSink(mixpanel);
```

Custom sinks implement:

```ts
import type { Sink } from "@dif.sh/sdk";

const sink: Sink = {
  kind: "custom",
  emit(event) {
    customAnalytics.track(event.event, event);
  },
};
```

An exposure event has this shape:

```ts
interface ExposureEvent {
  event: "dif.exposure";
  experiment: string;
  variant: string;
  user_id: string;
  surface: string;
  bucket: number;
  fired_at: number;
  source: string;
}
```

### Metric tracking

Track a conversion:

```ts
dif.track("completed_checkout");
```

Track a numeric value:

```ts
dif.track("revenue", {
  value: 49,
  currency: "USD",
});
```

Pass additional properties:

```ts
dif.track("article_read", {
  userId: "u_42",
  firedAt: Date.now(),
  idempotencyKey: "article-a91-u42",
  props: {
    article_id: "a_91",
    category: "research",
  },
});
```

Browser tracking posts one event at a time to:

```text
POST <apiUrl>/v1/track
Authorization: Bearer <publishableKey>
```

Calls are fire-and-forget and use `fetch(..., { keepalive: true })`. Network
failures are swallowed so analytics cannot crash application rendering.

Events are dropped when:

- The SDK is not initialized.
- `enabled` is false.
- No user ID is available.
- No publishable key is configured.

When no publishable key is configured, dropped tracking calls are logged with
`console.debug` when a console is available.

### Preview and QA overrides

The override wire format is:

```text
?_dif=experiment=variant,other-experiment=variant
```

Clear overrides:

```text
?_dif=off
```

In a framework-free browser app:

```ts
import {
  dif,
  syncOverrides,
  mountDifPreview,
} from "@dif.sh/sdk";

dif.init({ /* config */ });

syncOverrides();
mountDifPreview();
```

`syncOverrides`:

- Reads the `_dif` URL parameter first.
- Falls back to the `_dif` cookie.
- Persists active forces in a session cookie.
- Removes `_dif` from the visible address bar.
- Updates the SDK's active overrides.

Disable overrides in an environment:

```ts
syncOverrides({ allow: false });
```

Programmatic API:

```ts
dif.setOverrides({
  "checkout-cta-v2": "variant_a",
});

console.log(dif.getOverrides());

dif.setOverrides({});
```

Additional exports are available for custom integrations:

```ts
parseOverrides(raw);
serializeOverrides(map);
clearOverrides();
mountDifPreview();
```

## Server SDK

There are two separate server use cases:

1. Request-scoped experiment assignment.
2. Server-side metric tracking.

### Pure server assignment

Import the generated registry and call `assign` with an explicit request
context:

```ts
import "./dif/generated/client";
import { assign } from "@dif.sh/sdk";

const assignment = assign("checkout-cta-v2", {
  userId: session.userId,
  attributes: {
    locale: requestLocale,
    plan: session.plan,
  },
  overrides: {},
});
```

The result is:

```ts
interface Assignment {
  variant: string;
  bucket: number | null;
  exposed: boolean;
  forced?: boolean;
}
```

`assign`:

- Returns `null` for an unknown experiment ID.
- Does not read the browser SDK singleton.
- Does not fire an exposure.
- Does not touch client exposure deduplication.
- Is safe to call from a long-lived server process with explicit per-request
  input.

Assign every registered experiment:

```ts
import "./dif/generated/client";
import { assign, registered } from "@dif.sh/sdk";

const assignments = Object.fromEntries(
  registered().map((spec) => [
    spec.id,
    assign(spec.id, {
      userId: session.userId,
      attributes: requestAttributes,
    }),
  ]),
);
```

If the server renders an eligible assignment, the browser is responsible for
recording the exposure after mount:

```ts
import { recordExposure } from "@dif.sh/sdk";

if (assignment?.exposed && assignment.bucket !== null) {
  recordExposure(
    "checkout-cta-v2",
    assignment.variant,
    assignment.bucket,
  );
}
```

`recordExposure` uses the browser SDK's configured user ID and sinks and
deduplicates against later `dif()` calls.

The Svelte adapter implements this server-to-client handoff automatically.

### Server-side metric tracking

Import `DifServer` from the server-only package path:

```ts
import { DifServer } from "@dif.sh/sdk/server";

const dif = new DifServer({
  apiKey: process.env.DIF_API_KEY!,
  apiUrl: "https://cloud.dif.sh",
});

await dif.track({
  metric: "completed_checkout",
  userId: user.id,
  value: 49,
  currency: "USD",
  idempotencyKey: order.id,
  props: {
    order_id: order.id,
  },
});
```

`DifServer` requires a secret API key. Never include it in a browser bundle.

Configuration:

```ts
interface DifServerConfig {
  apiKey: string;
  project?: string;
  apiUrl?: string;
  source?: string;
}
```

Track input:

```ts
interface TrackInput {
  metric: string;
  userId: string;
  value?: number;
  currency?: string;
  unit?: string;
  firedAt?: number;
  idempotencyKey?: string;
  props?: Record<string, unknown>;
}
```

The server client sends one request per call. It does not batch or retry.
Non-success responses and network errors produce `console.warn` output but do
not reject the call with an analytics error.

## React

Install the SDK and adapter:

```sh
npm install @dif.sh/sdk @dif.sh/react
```

`@dif.sh/sdk` is a peer dependency and must be installed explicitly.

### Register experiments

Import the generated registry once in a client entry module or root layout:

```ts
import "./dif/generated/client";
```

### Add the provider

```tsx
import "./dif/generated/client";
import { attributes } from "./dif/generated/audiences";
import { DifProvider } from "@dif.sh/react";

export function Root({ children }: { children: React.ReactNode }) {
  return (
    <DifProvider
      config={{
        project: "acme-shop",
        publishableKey: process.env.NEXT_PUBLIC_DIF_PUBLISHABLE_KEY,
        userId: () => currentUser?.id ?? null,
        attributes: () => attributes({
          plan: currentUser?.plan ?? null,
        }),
      }}
    >
      {children}
    </DifProvider>
  );
}
```

`DifProvider` initializes the module-level SDK state once per provider mount.
It does not reinitialize when the `config` prop changes. Pass a stable config
for the lifetime of the mounted provider.

Provider props:

```ts
interface DifProviderProps {
  config: DifInitConfig;
  children: React.ReactNode;
  allowOverrides?: boolean;
  preview?: boolean;
}
```

`allowOverrides` defaults to true. `preview` defaults to true.

### Render an experiment

```tsx
import { useDif } from "@dif.sh/react";

export function CheckoutCTA() {
  const { exposure } = useDif();

  const cta = exposure("checkout-cta-v2", {
    control: () => "Place order",
    variant_a: () => "Get it today",
  });

  return <button>{cta()}</button>;
}
```

`exposure` has the same signature and behavior as the bare SDK `dif()`
function.

### Track from a component

```tsx
import { useEffect } from "react";
import { useDif } from "@dif.sh/react";

export function CheckoutSuccess() {
  const { track } = useDif();

  useEffect(() => {
    track("completed_checkout", {
      value: 49,
      currency: "USD",
    });
  }, []);

  return <Receipt />;
}
```

`useDif()` must be called below `DifProvider`. It returns:

```ts
interface DifContextValue {
  track(metric: string, opts?: TrackProps): void;
  exposure(id: string, branches: Record<string, () => unknown>): () => unknown;
}
```

The bare `dif` import and `useDif()` share the same singleton state.

### React preview links

On client mount, `DifProvider` automatically:

- Reads `?_dif=` or the `_dif` session cookie.
- Updates active overrides.
- Displays the preview badge when overrides are active.

Disable overrides:

```tsx
<DifProvider config={config} allowOverrides={false}>
  <App />
</DifProvider>
```

Keep overrides but hide the badge:

```tsx
<DifProvider config={config} preview={false}>
  <App />
</DifProvider>
```

The React adapter is a provider and hook layer. It does not currently include
a request-scoped SSR load helper. Use the SDK's pure `assign` API for custom
server rendering, or use control-first rendering when no request identity is
available.

## Svelte 5 and SvelteKit

Install:

```sh
npm install @dif.sh/sdk @dif.sh/svelte
```

The Svelte adapter provides:

- Request-scoped assignment in SvelteKit server load functions
- A stable anonymous `dif_uid` cookie
- Header-derived audience attributes
- Server-to-client assignment serialization
- Client-only exposure delivery
- A Svelte readable store for experiment values

### 1. Assign in a server layout

```ts
// src/routes/+layout.server.ts
import "$lib/dif/generated/client";
import { difLoad } from "@dif.sh/svelte/server";

export const load = (event) => ({
  dif: difLoad(event),
});
```

The generated client import populates the SDK registry before `difLoad`
enumerates active experiments.

`difLoad`:

1. Reads or creates a `dif_uid` cookie.
2. Derives default attributes from request headers.
3. Merges application attributes over the defaults.
4. Reads QA overrides.
5. Assigns every registered experiment without firing exposures.
6. Returns serializable `DifData`.

Default header mapping:

| Header | Attribute |
| --- | --- |
| `Accept-Language` | `locale`, using the first locale value |
| `User-Agent` | `device_type`: `mobile`, `tablet`, or `desktop` |

Add application attributes:

```ts
export const load = (event) => ({
  dif: difLoad(event, {
    attributes: {
      plan: event.locals.user?.plan ?? null,
      returning_visitor: Boolean(event.locals.user),
    },
  }),
});
```

Replace header derivation:

```ts
export const load = (event) => ({
  dif: difLoad(event, {
    deriveAttributes(headers) {
      return {
        locale: headers.get("x-app-locale"),
        device_type: headers.get("x-device-class"),
      };
    },
  }),
});
```

`DifLoadOptions`:

| Option | Default | Description |
| --- | --- | --- |
| `attributes` | `{}` | App attributes merged over derived values. |
| `cookieName` | `dif_uid` | Anonymous identity cookie name. |
| `deriveAttributes` | `attributesFromHeaders` | Request-header mapper. |
| `enabled` | `true` | When false, returns no server assignments. |
| `sameSite` | `lax` | `dif_uid` cookie SameSite mode. |
| `secure` | `true` | `dif_uid` cookie Secure flag. |
| `allowOverrides` | `true` | Honor `_dif` URL and cookie overrides. |

The `dif_uid` cookie:

- Contains a random UUID, not a secret.
- Is readable by the client so browser bucketing matches the server.
- Uses `httpOnly: false`.
- Uses `path: /`.
- Has a one-year maximum age.

For local plain HTTP environments that do not accept secure cookies, pass:

```ts
difLoad(event, { secure: false });
```

### 2. Initialize in the root Svelte layout

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { setContext } from "svelte";
  import {
    initDif,
    DIF_CONTEXT_KEY,
  } from "@dif.sh/svelte";
  import {
    PUBLIC_DIF_PUBLISHABLE_KEY,
    PUBLIC_DIF_CLOUD_URL,
  } from "$env/static/public";

  let { data, children } = $props();

  setContext(DIF_CONTEXT_KEY, data.dif);

  initDif({
    data: data.dif,
    publishableKey: PUBLIC_DIF_PUBLISHABLE_KEY,
    apiUrl: PUBLIC_DIF_CLOUD_URL,
  });
</script>

{@render children()}
```

`initDif` initializes the browser SDK with:

- The server-provided `difUid` as user identity
- The server-provided attribute bag
- The server-provided override map
- Any publishable key, API URL, sink, or enabled option you pass

Options:

```ts
interface InitDifOptions {
  data?: DifData;
  cookieName?: string;
  allowOverrides?: boolean;
  preview?: boolean;
  project?: string;
  publishableKey?: string;
  apiUrl?: string;
  sink?: Sink | Sink[];
  enabled?: boolean;
}
```

`userId` and `attributes` are derived from `data` and cannot be supplied
directly through `InitDifOptions`. Active overrides are also taken from
`data.overrides` or synchronized from the URL and cookie.

### 3. Render an experiment store

```svelte
<script lang="ts">
  import { experiment, track } from "@dif.sh/svelte";

  const cta = experiment("checkout-cta-v2", {
    control: () => "Place order",
    variant_a: () => "Get it today",
  });
</script>

<button onclick={() => track("checkout_cta_clicked")}>
  {$cta.value}
</button>

<small>Variant: {$cta.variant}</small>
```

`experiment(id, branches)` returns:

```ts
Readable<{
  value: R;
  variant: string;
}>
```

Call `experiment` during component initialization because it reads Svelte
context.

Resolution order:

1. Reuse the server assignment from `DifData` when present.
2. Otherwise assign on the client from the stable cookie identity.
3. Fall back to the first branch for an unknown experiment or invalid variant.
4. Fire an owed exposure only after a client subscription.

This keeps the server HTML and first browser render aligned when the server
load function runs per visitor.

### Track metrics

```svelte
<script lang="ts">
  import { track } from "@dif.sh/svelte";

  function completedCheckout() {
    track("completed_checkout", {
      value: 49,
      currency: "USD",
    });
  }
</script>
```

`track` is a thin wrapper around `dif.track`.

### Svelte preview links

Both `difLoad` and `initDif` honor:

```text
?_dif=checkout-cta-v2=variant_a
?_dif=checkout-cta-v2=variant_a,home-hero=control
?_dif=off
```

Disable server and client override handling together:

```ts
// +layout.server.ts
difLoad(event, { allowOverrides: false });
```

```svelte
<!-- +layout.svelte -->
<script lang="ts">
  initDif({
    data: data.dif,
    allowOverrides: false,
  });
</script>
```

Hide only the browser preview badge:

```ts
initDif({
  data: data.dif,
  preview: false,
});
```

### ISR and shared HTML caches

On an ISR-cached route, the server load function may not run for every
visitor. Cached HTML and serialized load data can therefore be shared.

For those routes:

- Do not assume the cached server assignment belongs to the current visitor.
- Prefer client assignment from `dif_uid`, accepting a possible post-hydration
  change from the control branch.
- Or vary the cache key on every request property used for assignment,
  including identity and relevant headers.

## CI

A typical validation job:

```yaml
name: dif

on:
  pull_request:
  push:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install -g @dif.sh/cli
      - run: dif validate
      - run: dif build
```

Because `dif/context.json` contains a generation timestamp, rebuilding it in CI
will normally produce a diff even when experiment inputs are unchanged. Do not
assert a clean context diff unless your workflow intentionally normalizes or
commits that timestamp on every build.

## Runtime Guarantees and Current Constraints

- Bucketing is deterministic for a given experiment salt and user ID.
- Rust and TypeScript bucketing share a cross-language fixture in the
  repository test suite.
- Audience includes use equality or list membership only.
- Browser exposures are deduplicated per experiment and user for the lifetime
  of the loaded module.
- Forced QA assignments do not emit exposures.
- Browser event delivery is fire-and-forget.
- Server event delivery sends one request per call and does not retry.
- There is no offline queue or event batching.
- The generated client currently registers experiments by side effect and does
  not export named experiment functions.
- The browser `assign` API resolves one experiment at a time. The CLI `qa`
  command provides the full exclusion-group trace.
- JavaScript call-site validation recognizes literal, double-quoted `dif()`
  IDs. Dynamic IDs and other quote forms are not included in orphan-ref
  scanning.
- Audience resolver functions are synchronous.

## Package Summary

| Package | Purpose |
| --- | --- |
| `@dif.sh/cli` | npm-distributed wrapper around the Rust `dif` binary. |
| `@dif.sh/sdk` | Browser assignment, exposure delivery, metric tracking, pure assignment primitives, and QA overrides. |
| `@dif.sh/sdk/server` | Secret-key server metric tracking. |
| `@dif.sh/react` | `DifProvider` and `useDif` for React 18+. |
| `@dif.sh/svelte` | Svelte 5 client initialization, stores, context, and tracking. |
| `@dif.sh/svelte/server` | SvelteKit request assignment and cookie handling. |

## Command Summary

```sh
# Create a workspace
dif init --surface home

# Add starter audience resolvers to an existing workspace
dif scaffold-audiences

# Create a draft
dif new checkout-cta-v2 --surface checkout --owner ada@example.com

# Check all specs and call sites
dif validate

# Generate client.ts, audiences.ts, and context.json
dif build

# Trace a user with audience attributes
dif qa \
  --user u_8131 \
  --attr locale=en-US \
  --attr device_type=mobile

# Generate a forced preview link
dif qa \
  --force checkout-cta-v2=variant_a \
  --preview-url https://staging.example.com/checkout

# Record the decision and move the experiment to concluded/
dif conclude checkout-cta-v2 \
  --decision "Shipped variant_a. Completed checkout increased 2.1%."
```

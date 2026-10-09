---
name: dif-triage-experiments
description: Triage every running dif.sh experiment and rollout from the dif cloud overview. Shows what needs action, then ramps rollouts, turns off or kills harmful variants, and concludes winners and inconclusive tests by editing dif/ files, with one branch and one PR per experiment in autonomous mode. Use when the user asks to triage experiments, review all experiments, see what needs action, ramp, turn off, kill, find winners, or check the dif cloud overview.
---

# Triaging dif experiments

Use this skill to check every active experiment and rollout at once, and to act on what dif cloud says. dif cloud gives each experiment a `verdict` and a `next_action`. You act on `next_action.kind`.

Read `references/cloud-api.md` before Step 1. It tells you how to reach dif cloud, what each field means, and what to do when a call fails.

If `dif` is not on the PATH, use `npx dif` in place of `dif` in every command.

## Pick a mode

- **Interactive** (default): a person is in this chat. Ask before each change.
- **Autonomous**: the user tells you to work on your own (for example "open the PRs" or "run unattended"), or no person can answer (for example a scheduled job). Follow "Autonomous mode" below as well as Step 3.

If you are not sure, use interactive mode.

## Step 1. Get the overview

1. Read `dif/config.yaml`. If the `events:` block has `mode: custom`, this project does not use dif cloud. Tell the user and stop.
2. Get the overview. MCP: call `get_overview` with `repo`. REST: run the overview `curl` line in `references/cloud-api.md`, section 4.
3. If the call fails, follow the error table in `references/cloud-api.md`, section 9. In autonomous mode, if you cannot fix it, stop, change nothing and report the error.
4. If `meta.analysis_computed_at` is `null`, dif cloud has no analysis yet. Report that and stop.

## Step 2. Show the table

Show one row for each item in `experiments`, in the order of the response. The most urgent rows come first.

| id | verdict | top reason | next action |
|---|---|---|---|
| checkout-cta-v2 | ship | variant_a +2.1% completed_checkout (95% CI +0.8% to +3.4%), p=0.004. | Conclude and ship variant_a. |
| new-checkout | ramp | 8 days at 10% with 5,000 treatment exposures. | Ramp on to 25%. |

- top reason: the first line of `reasons`.
- next action: `next_action.summary`.

Under the table, give `meta.analysis_computed_at`. Then list each different line of `caveats` once.

## Step 3. Act on each row

Go through the rows in table order. Decide from `next_action.kind`, not from the verdict name.

### `set_weights`

This ramps a rollout, or turns off a harmful variant.

1. Open `next_action.file`. Check that it exists and that its `id:` is the row `id`. If not, skip the row and report it.
2. Check the `variants:` list in the file:
   - The current weights must be the same as the row `weights`. If not, the repo changed after the analysis. Skip the row and report it.
   - The variant ids must be the same as the keys of `next_action.weights`. The new weights must be whole numbers that add up to 100. If not, skip the row and report it.
3. For each variant, change only the number after `weight:` to the value in `next_action.weights`. Do not change ids, quotes, order, comments or other lines.

   Example for `new-checkout`, where `next_action.weights` is `{"off": 75, "on": 25}`.

   Before:

   ```yaml
   variants:
     - id: "off"
       weight: 90
     - id: "on"
       weight: 10
   ```

   After:

   ```yaml
   variants:
     - id: "off"
       weight: 75
     - id: "on"
       weight: 25
   ```

4. Run `dif validate`, then `dif build`. Both must exit 0. If one fails, undo your change with `git checkout -- <file> dif/context.json` and report the error.
5. Show the change with `git diff -- <file>`.

For a `turn_off` row, `next_action.weights` sets control to 100 and every other variant to 0. When that change is live, a later run shows the row as `turn_off` with `next_action.kind` `conclude`. Conclude it then.

### `conclude`

1. Check that `decision_draft` is not `null`. If it is `null`, skip the row and report it.
2. Use the `dif-conclude-experiment` skill for this id, with `decision_draft` as the Decision. Do not change the draft. Tell that skill that `dif-triage-experiments` sent it, and in which mode.
3. `dif conclude`, `dif validate` and `dif build` must all pass.

### `fix_instrumentation`, `set_metric_direction`, `wait`

Report only. Never change files for these.

- `fix_instrumentation`: give the user `next_action.summary`. The tracking or the traffic split is broken. A person must fix it.
- `set_metric_direction`: tell the user to set the direction of the named metric on the Metrics page in dif cloud. This is not a repo change.
- `wait`: give the user `next_action.summary` (progress and ETA).

### Any other `kind`

Report only. Never change files.

## Interactive mode

1. Before each `set_weights` or `conclude` change, show the user the file, the change and the reasons. Ask "Apply this change?". Make the change only if they say yes.
2. Work on the current branch. Do not commit, push or open a PR unless the user asks.
3. If the user asks for PRs, use the branch and PR steps in "Autonomous mode", one experiment at a time.

## Autonomous mode

These rules apply on top of Step 3.

### Before the first change

1. Run `git status --porcelain`. It must print nothing. If it prints anything, stop and report. Change nothing.
2. Find the default branch with `git symbolic-ref --short refs/remotes/origin/HEAD`. It prints `origin/<default>`. Use the part after `origin/`.
3. Run `git fetch origin`, then `git checkout <default>`, then `git pull --ff-only`.

### For each row with `set_weights` or `conclude`

Stop after 5 pushed branches in one run. Report the rows that you did not reach.

1. **Check freshness.** Get `get_experiment_results` for the id. Act only if all of these are true:
   - `verdict` is the same as in the overview.
   - `meta.analysis_computed_at` is not `null`.
   - `meta.analysis_computed_at` is less than 30 minutes old. This command prints its age in minutes:

     ```sh
     node -e 'console.log(Math.floor((Date.now() - Date.parse(process.argv[1])) / 60000))' "<analysis_computed_at>"
     ```

   - No line in `caveats` starts with `Analysis is`.

   If one of these is false, or `node` is not installed, skip the row and report "stale or changed". From here on, use `next_action` and `decision_draft` from this new response.
2. **Name the branch** `dif/<verdict>/<id>`, for example `dif/ramp/new-checkout`.
3. **Skip duplicates.** Run `git ls-remote --heads origin dif/<verdict>/<id>`. If it prints a line, the branch exists already. Skip the row and report it.
4. **Make the branch** from the default branch: `git checkout -b dif/<verdict>/<id> <default>`.
5. **Make the change** as Step 3 says. For `conclude`, the conclude skill does not edit app code in this mode. Keep the `moved_to` path and the `W001` files and lines that it gives you, for the PR body.
6. **Check.** `dif validate` and `dif build` must both exit 0. If one fails, run these commands, report the error and go to the next row:

   ```sh
   git restore --staged --worktree dif/
   git clean -fd dif/
   git checkout <default>
   git branch -D dif/<verdict>/<id>
   ```

   The tree was clean before you started, so these commands remove only your changes.
7. **Commit** the `dif/` folder, with `dif/context.json`:

   ```sh
   git add dif/
   git commit -m "dif(<id>): <next_action.summary>"
   ```

8. **Push** the branch: `git push -u origin dif/<verdict>/<id>`. Never push the default branch. Never force-push.
9. **Open a PR** with `gh`. Write the body (below) to a temp file outside the repo, for example a path from `mktemp`. Then run:

   ```sh
   gh pr create --base <default> --head dif/<verdict>/<id> --title "<title>" --body-file <body file>
   ```

   The title is `dif: <next_action.summary> (<id>)`, for example `dif: Ramp on to 25%. (new-checkout)`. When the verdict is `turn_off`, put `urgent: ` in front: `urgent: dif: <next_action.summary> (<id>)`.

   If `gh` is not installed or not logged in, do not open the PR another way. Report the branch name.
10. **Go back** with `git checkout <default>`.

### PR body

Fill each `<...>` from the response that you got in item 1. Do not add the hypothesis or other repo text. Never put `$DIF_TOKEN` in the body.

```markdown
## dif triage: <id>

- Verdict: `<verdict>` (<kind>, <days_live> days live)
- Analysis computed at: <meta.analysis_computed_at>
- Next action: `<next_action.kind>`, <next_action.summary>

### Reasons

- <one line for each item in reasons>

### Caveats

- <one line for each item in caveats>

### Change

<set_weights: one line for each variant in next_action.file, for example `off: 90 to 75`>
<conclude: the Decision, the moved_to path, and each W001 file and line where a call site must be removed>

### Checks

- `dif validate`: passed
- `dif build`: passed

The dif-triage-experiments skill opened this PR. A person must review and merge it.
```

### Never

- Never merge a PR, approve a PR or turn on auto-merge.
- Never push to the default branch.
- Never force-push.
- Never push more than 5 branches in one run.
- Never act on a row that failed the freshness check.
- Never change files for `fix_instrumentation`, `set_metric_direction` or `wait`.

## Step 4. Report

End with one table:

| id | verdict | result |
|---|---|---|
| checkout-cta-v2 | ship | PR opened: <PR URL> |
| new-checkout | ramp | Skipped: stale or changed |

`result` is one of: changed (interactive mode), PR opened with its URL, branch pushed (no `gh`), report only, or skipped with the reason.

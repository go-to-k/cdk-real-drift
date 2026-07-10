# cdk-real-drift (`cdkrd`)

[![npm](https://img.shields.io/npm/v/cdk-real-drift)](https://www.npmjs.com/package/cdk-real-drift)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Drift detection for AWS CDK that sees what your template can't, including the
**properties you never declared**. **Detect** it, **record** it, or **revert** it.

**In a nutshell:**

```text
live AWS state  vs  ( CFn template + AWS defaults + .cdkrd baseline )
```

`cdkrd` compares your real deployed resources against your intent, which is three
things combined:

- **CFn template** — the properties you **declared**.
- **AWS defaults** — undeclared properties still sitting at their AWS default,
  subtracted automatically (you maintain nothing here).
- **.cdkrd baseline** — a small committed file recording the **undeclared** values
  that actually differ from the default and you've accepted.

The baseline is **optional**: with just the first two, `cdkrd` already catches
drift on your declared properties and undeclared properties that drift away from
their AWS default (plus out-of-band deletes) — no setup required. The baseline
only adds one more thing: confirming drift on undeclared values that were
non-default from the start, which your template never mentions.

## Why

Someone tweaks one of your resources from the console: an extra inline policy on a
role, a bucket setting you never declared. CloudFormation drift detection only
compares properties that **appear in your template**, so it reports nothing:

```bash
$ npx cdk drift
✨  Number of resources with drift: 0
```

`cdkrd` reads the **full** live resource model and subtracts everything
explainable, so the same change shows up:

```console
$ npx cdkrd check
=== check: ApiStack (us-east-1) ===
[CFn-Undeclared Drift: 1] (live-only (not in your CloudFormation template), changed from your .cdkrd baseline — the differentiator)
  ApiRole.Policies (AWS::IAM::Role) — appeared since record
      actual =[{"PolicyName":"manual-debug-access", ...}]

─────────────────────────────────
result: 1 drift(s) (undeclared=1)
─────────────────────────────────
```

![cdkrd finds an out-of-band inline policy that `cdk drift` reports as zero](demo/demo.gif)

| Capability                                                     | `cdkrd` | `cdk drift` / CFn drift detection |
| -------------------------------------------------------------- | :-----: | :-------------------------------: |
| Drift on **declared** properties (+ out-of-band deletes)       |   ✅    |                ✅                 |
| Drift on **undeclared** properties                             |   ✅    |                ❌                 |
| **Added** out-of-band resources (not in template)              |   ✅    |                ❌                 |
| **Revert** declared drift                                      |   ✅    |  ✅ `cdk deploy --revert-drift`   |
| **Revert** undeclared drift                                    |   ✅    |                ❌                 |
| **Ignore / accept** a drift, incl. a **declared** one          |   ✅    |                ❌                 |
| **Record** undeclared / added state as a reviewed git baseline |   ✅    |                ❌                 |

## Quick start

Install it in your CDK project, then the `cdkrd` bin is on your `PATH` (via
`npx`):

```bash
npm install -D cdk-real-drift   # in your CDK project
npx cdkrd check                 # checks every stack your app defines
```

Or run it without installing:

```bash
npx cdk-real-drift check             # zero-install (resolves the cdkrd bin)
npx -p cdk-real-drift cdkrd check    # same, naming the bin explicitly
```

The package is `cdk-real-drift` and its bin is `cdkrd`; a bare
`npx cdk-real-drift check` resolves the single bin, and `-p cdk-real-drift cdkrd`
names it explicitly.

`check` is the only command you run by hand, with nothing to set up first: it
finds drift and offers **Record**, **Revert**, and **Ignore** inline on what it
turns up.

## How to use

### Your first run needs no baseline

The first time you run `check` on a stack, before recording anything:

```console
=== check: ApiStack (us-east-1) ===
No baseline yet — live-only values can't be confirmed as drift, but declared drift and out-of-band deletes always can.

[CFn-Declared Drift: 1] (declared in your CloudFormation template — the live value differs)
  Topic.DisplayName (AWS::SNS::Topic)
      desired="prod-alerts"
      actual ="test"

[Potential Drift: 2] (live-only and not yet in your .cdkrd baseline, so cdkrd can't tell whether it's intended or an out-of-band change — Record to accept it, or Revert to remove it)
  Queue.RedrivePolicy (AWS::SQS::Queue)
      actual ={"maxReceiveCount":5}
  Role.Policies (AWS::IAM::Role)
      actual =[{"PolicyName":"adhoc", ...}]

─────────────────────────────────────────────────────────────
result: 3 findings — 1 drift (declared=1) + 2 potential drift
─────────────────────────────────────────────────────────────

ApiStack: drift found — what do you want to do?
  ❯ Nothing (decide later)
    Record undeclared (live-only) — snapshot into the .cdkrd baseline (keeps watching)
    Revert — write the desired values back to AWS
    Ignore — stop reporting it (writes .cdkrd/ignore.yaml)
    Decide per finding — assign a different action to each
```

Each block above is one kind of finding, and neither needed a baseline:

- **`[CFn-Declared Drift]`**: a property you declared changed out of band, so it's
  confirmed against your template right away (deletes of declared resources are
  confirmed the same way).
- **`[Potential Drift]`**: settings that live only on the real resource, not in
  your template. cdkrd detects these too: it strips the obvious noise (AWS
  defaults, auto-generated names) so what's left is the values most likely to be
  real drift. They're only _potential_ because there's no baseline yet — and,
  being an unconfirmed best-effort guess, this is the one tier that **can include
  false positives** (an AWS-managed default or noise the fold tables didn't yet
  strip). Confirmed `[CFn-Declared Drift]` never guesses. If a potential-drift
  value is really noise, [please report it](https://github.com/go-to-k/cdk-real-drift/issues)
  so it becomes a fold-table fix.

At the prompt you act on each finding: **record** it (accept and watch),
**revert** it (undo the change), or **ignore** it (stop reporting).

### Recording

Recording snapshots those live-only values into a git-committed `.cdkrd` baseline,
so from then on any later out-of-band change to them is confirmed drift. That's the
day-to-day loop: run `check`, record what's intended, commit the baseline, and the
next out-of-band change stands out on its own.

With `Role.Policies` recorded, an inline policy added later out of band now
surfaces as **`[CFn-Undeclared Drift]`**: confirmed drift on a value that isn't in
your CloudFormation template, the kind `cdk drift` can't see:

```console
=== check: ApiStack (us-east-1) ===
[CFn-Undeclared Drift: 1] (live-only (not in your CloudFormation template), changed from your .cdkrd baseline — the differentiator)
  Role.Policies (AWS::IAM::Role) — changed since record
      actual =[{"PolicyName":"adhoc", ...}, {"PolicyName":"manual-debug-access", ...}]

─────────────────────────────────
result: 1 drift(s) (undeclared=1)
─────────────────────────────────
```

`record` covers live-only state only, not a `[CFn-Declared Drift]`; the other
verbs are in [The model](#the-model-one-verb-you-run-three-it-offers).

### In CI

Run `npx cdkrd check --fail`. It's read-only, never prompts, and exits 1 on drift;
it never writes a baseline (you record locally and commit the file).

## The model: one verb you run, three it offers

`cdkrd check` is the entry point: on a TTY it finds drift and offers the other
three as inline actions.

All four are also standalone commands for non-TTY use (scripting / CI). Here's what
each does, run on its own:

| verb           | meaning                                                              | writes                              |
| -------------- | -------------------------------------------------------------------- | ----------------------------------- |
| `cdkrd check`  | find drift (the one you run)                                         | nothing; the 3 below do the writing |
| `cdkrd record` | "this undeclared / added state is the norm; tell me if it _changes_" | a git file (baseline)               |
| `cdkrd ignore` | "stop reporting this property, ever"                                 | a git file (`ignore.yaml`)          |
| `cdkrd revert` | "this state is wrong"; write the desired value back                  | AWS (plan + confirm)                |

The scopes differ: `record` is **undeclared / added only**, while `ignore` works on
**any** tier. It's the only in-tool way to accept a **declared** drift without
editing code or reverting.

`check`, `record`, and `ignore` never write to AWS. `revert` is the one mutating
verb and always confirms first (`--dry-run` to preview, `--yes` to skip the
prompt). Baselines stay a reviewed, git-committed artifact either way; CI never
writes one. It re-reads each touched resource afterward to verify it converged:

```console
=== revert: ApiStack (us-east-1) ===

  ApiRole (AWS::IAM::Role)
    - Policies -> remove (undeclared, not in baseline)

Apply 1 revert op(s) to ApiStack? This WRITES to AWS. · yes
  reverted: ApiRole

verifying convergence (re-reading 1 resource(s))...
ApiStack: CLEAN after revert.
```

Picking an action lets you choose **which** findings it touches; after a Record or
Ignore the prompt re-offers anything still drifting, so you finish in one run. Full
prompt mechanics (multiselect, Decide per finding, key bindings) are under
[Interactive prompts](#interactive-prompts-tty-only-ci-is-never-prompted).

## How drift is judged

cdkrd compares the **live AWS resource** against your deployed **CloudFormation
template** (or your local synth with `--pre-deploy`). It's reality vs intent,
**not** a line-by-line diff of your CDK source the way `cdk diff` works, so
undeployed code changes don't show up as drift by default. `--pre-deploy` inverts
that, checking live state against the freshly synthesized template (see
[`--pre-deploy`](#--pre-deploy)).

### The kinds of drift

Named so "declared" is never ambiguous (`CFn-declared` means **in the deployed
template**, not your CDK code and not your `.cdkrd` baseline):

| term                           | source                               | how it's judged                                                         |
| ------------------------------ | ------------------------------------ | ----------------------------------------------------------------------- |
| **CFn-declared**               | in the deployed template             | vs the deployed template; drift from the first run, no baseline needed  |
| **CFn-undeclared** (live-only) | on the resource, not in the template | vs your `.cdkrd` baseline; the key differentiator                       |
| **Added resource**             | a whole resource not in the template | reconciled against the baseline like an undeclared property (see below) |
| **Deleted**                    | in the template, gone live           | the most blatant drift; always fails `--fail`                           |

(`CFn-undeclared` is a template axis; `recorded` / `unrecorded` is a separate
baseline-file axis: whether you've snapshotted that value yet.)

The mechanics:

- **Until a stack's first `record`, undeclared / added state is `unrecorded`:**
  informational, CLEAN, never fails `--fail`.
  [Recording](#recording) is what arms detection,
  turning a later out-of-band change into failing drift. The baseline is a
  git-committed JSON file at `.cdkrd/baselines/<stack>.<accountId>.<region>.json`
  (reviewable; account id + region in the name prevent cross-account collisions).
- **There is no watch-list to maintain.** Every `check` snapshots the full live
  model (Cloud Control API + SDK readers for the gap types) and subtracts everything
  explainable: schema read-only/write-only/defaults, AWS-managed fields, `aws:*`
  tags, policy-document and ordering noise. What survives is signal.
- **Anything not confidently comparable is reported honestly** (`readGap` /
  `unresolved` / `skipped`), never guessed, so no false drift.

### Added out-of-band resources

A whole child resource that exists live but isn't in your template (e.g. an API
Gateway `ANY` method added on `/` via the console) is the resource-level sibling
of an undeclared property, and is reconciled the same way against your baseline:

| state                       | reported as                                    |
| --------------------------- | ---------------------------------------------- |
| added, **not** recorded     | **Potential Drift** (no baseline, unconfirmed) |
| recorded, unchanged         | suppressed                                     |
| recorded, **changed** since | failing drift                                  |

`cdk drift` / CFn drift detection compare only template-declared resources, so an
out-of-band addition is invisible to them. Decide it like any finding: `record`
snapshots its full live model and watches it, `ignore` accepts it, or `revert`
**deletes** it (Cloud Control `DeleteResource`, behind the usual confirm /
`--dry-run` / picker; an unrecorded one needs `--remove-unrecorded`).

<details>
<summary>Covered parent types (the <code>CHILD_ENUMERATORS</code> registry, growing per type)</summary>

- **API Gateway REST**: resources, methods, authorizers, models, request
  validators, gateway responses, stages
- **API Gateway V2** (HTTP / WebSocket): routes, integrations, authorizers, stages
- **SNS**: topic subscriptions
- **Lambda**: event source mappings, function URLs, aliases, versions
- **EventBridge**: bus rules
- **Cognito**: user pool clients, groups, resource servers
- **AppSync**: data sources, resolvers, functions
- **CloudWatch Logs**: metric filters, subscription filters
- **ELBv2**: listeners, listener rules
- **EC2**: VPC subnets, route table routes
- **ECS**: cluster services
- **KMS**: key aliases
- **AppConfig**: application environments, configuration profiles
- **EFS**: file system mount targets
- **RDS**: database cluster instances

</details>

Full design and rationale: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Selecting stacks

| invocation            | what is checked                                               |
| --------------------- | ------------------------------------------------------------- |
| `cdkrd check`         | every stack the CDK app defines, each in its own `env.region` |
| `cdkrd check 'Dev*'`  | glob, matched against the app's stack names                   |
| `cdkrd check MyStack` | every same-named stack (a name can repeat across regions)     |

cdkrd resolves your CDK app to discover which stacks exist and to label findings by
construct path. The app comes from `cdk.json` (when run in the project directory) or
from `--app`: a command (`--app "node bin/app.js"`) or a pre-synthesized assembly
(`--app cdk.out`, read not executed); `$CDKRD_APP` also works. The drift
comparison still reads each stack's **deployed** template + live state from AWS;
synth only tells cdkrd which stacks to look at.

**Context lookups.** Resolving a CDK app that uses `fromLookup`
(`Vpc.fromLookup`, `HostedZone.fromLookup`, …) runs the same live AWS context
lookups as `cdk synth` and caches the results in `cdk.context.json` in your app
directory — so an app with uncached lookups will make read-only AWS calls and
create/update that file (a `git status` change is expected; the cache makes
subsequent checks reproducible). cdkrd prints a one-liner when it does so. This
matches `cdk synth` semantics and is the only file `check` writes; it never writes
to AWS. If every lookup fails (leaving only an empty `{}`), cdkrd removes the file
it just created rather than leave that noise in your tree.

## Commands & options

| command                     | does                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| `cdkrd check [<stack>...]`  | compare live state vs template (declared) + baseline (undeclared)      |
| `cdkrd record [<stack>...]` | snapshot undeclared + added state into the baseline (CI: `--yes`)      |
| `cdkrd ignore [<stack>...]` | stop reporting chosen drift via `.cdkrd/ignore.yaml` (CI: `--yes`)     |
| `cdkrd revert [<stack>...]` | write the desired value back to AWS (confirms; `--dry-run` to preview) |

Day to day you run only `cdkrd check` and act from its prompt; the standalone
`record` / `ignore` / `revert` are the **same actions** for scripting / non-TTY /
CI (with `--yes`).

### Exit codes

- `check` is **report-only by default**: drift prints but exits `0` (a note names
  the flag).
- **`--fail`** (the `cdk diff --fail` / `cdk drift --fail` convention) exits `1` on
  drift and suppresses all prompts. It's the one flag for scripts and CI.
- **`--strict`** is the orthogonal **coverage** axis: it exits `1` when a run was
  incomplete (a resource skipped for an ACTIONABLE reason — a CC-unsupported type
  with no override, a read error / throttle / AccessDenied — or a nested stack not
  recursed into). A **custom resource** (`Custom::*` /
  `AWS::CloudFormation::CustomResource`, e.g. `Custom::S3AutoDeleteObjects` /
  `Custom::LogRetention`) has no cloud-side model to read, so it is a
  permanent-by-nature gap that no `record` / `ignore` could clear — it is
  **informational** and does NOT fail `--strict` (otherwise the flag would exit `1`
  forever on nearly every real CDK app). The gap is always surfaced regardless (as
  the `skipped=N` footer line or a loud `warning:`); `--strict` only decides whether
  an actionable gap fails the build.
- Errors always exit `2`; `revert` exits `1` when drift remains after it.
- Interrupting a run with **Ctrl-C** (or **ESC** / SIGINT) during the gather/read
  phase exits `130` (128 + SIGINT) for every verb, and a **SIGTERM** (CI
  cancellation, `timeout`, a supervisor) exits `143` promptly on the first signal
  — never `0`, so an aborted `check --fail` can never be mistaken for "no drift"
  and an aborted `record` is never a false "written". An unhandled internal error
  (a stray promise rejection / uncaught exception) always exits `2` (the error
  code), never `0` or `1`.

```yaml
- run: npm ci # cdkrd resolves the CDK app, so its deps must be installed
- run: npx cdkrd check --fail --region us-east-1 # fails the job on drift
# or point at a prebuilt assembly artifact instead of synthesizing:
# - run: npx cdkrd check --fail --app cdk.out --region us-east-1
```

### Options

<!-- Editor note: this table is hand-aligned to a fixed column width. The
     alignment is COSMETIC only — GitHub renders the table regardless — but a
     cell that overflows the width silently skews the `|` columns in the source.
     When editing a row, re-pad the `option` and `meaning` cells (and the
     separator row) to match, or accept that alignment is inconsequential and
     leave cells natural-width. Don't chase pixel alignment at the cost of a
     readable diff. -->

| option                     | meaning                                                                                                                                                                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--region <r>`             | a stack's own `env.region` ALWAYS wins; for an env-AGNOSTIC stack (no `env`) it falls back to `--region` (or `$AWS_REGION` / `$AWS_DEFAULT_REGION`), else the AWS-CLI/cdk region chain — the active profile's region, then the `[default]` profile's region, then EC2 IMDS    |
| `--profile <p>`            | AWS profile (else `$AWS_PROFILE`, else `$AWS_DEFAULT_PROFILE` — same order `aws` and `cdk` use)                                                                                                                                                                               |
| `-a, --app <cmd\|cdk.out>` | CDK app command or pre-synthesized assembly dir (or `$CDKRD_APP` / cdk.json `"app"`); stack auto-discovery + construct paths                                                                                                                                                  |
| `-c, --context key=value`  | context for synth (repeatable; cdk.json is the base layer)                                                                                                                                                                                                                    |
| `--all`                    | target every stack the app defines (the default when no `<stack>` is named; overrides any positional names)                                                                                                                                                                   |
| `--json`                   | machine-readable output (see [JSON contract](#json-output-contract))                                                                                                                                                                                                          |
| `--fail`                   | (check) exit 1 on drift and never prompt; for scripts/CI. Without it, check reports drift but exits 0                                                                                                                                                                         |
| `--strict`                 | (check) exit 1 when coverage is incomplete. A coverage gap is always surfaced loudly; `--strict` makes it CI-failing. Orthogonal to `--fail`                                                                                                                                  |
| `--show-all`               | (check) inventory mode: show all current undeclared state, ignoring the baseline                                                                                                                                                                                              |
| `--verbose` / `-v`         | (check) expand the `info:` footer tiers / (revert) expand the not-revertable summary to full lists; (record) itemizes nested sub-keys in the multiselect. `-v` means `--verbose` **inside a verb** (`check -v`); a bare `cdkrd -v` (no verb) prints the version               |
| `--pre-deploy`             | (check) compare live vs the LOCAL synth template: the declared drift your next `cdk deploy` would silently overwrite                                                                                                                                                          |
| `--undeclared-only`        | (check) undeclared drift only: pair cdkrd with `cdk drift` for the declared side                                                                                                                                                                                              |
| `--declared-only`          | (check) declared drift vs the deployed template only (undeclared tier skipped; baseline untouched). Not `--pre-deploy`                                                                                                                                                        |
| `--dry-run`                | (revert) print the plan; make no changes                                                                                                                                                                                                                                      |
| `--wait[=DURATION]`        | (revert) on a transient "resource is mid-update" error (e.g. Route53Resolver `RSLVR-00705`) keep retrying until it settles, up to DURATION (default `10m`; e.g. `--wait=5m`, `--wait=90s`). The DURATION is **inline-only** (`--wait=5m`); a separate `--wait 5m` is not read |
| `--remove-unrecorded`      | (revert, and check for its inline revert) REMOVE unrecorded values + DELETE unrecorded added resources in a no-prompt run (`--yes`/CI); an interactive revert already lists them                                                                                              |
| `--yes` / `-y`             | skip confirmations (revert apply; record records all without the multiselect)                                                                                                                                                                                                 |

Unknown options (`--apq`) and options missing their value (`--app` at the end of
the line) are errors (exit `2`): a typo'd flag never silently becomes a stack name.
The three `check` scope flags — `--pre-deploy`, `--undeclared-only`, and
`--declared-only` — are **mutually exclusive**; passing two of them is an exit-`2`
error (they select which comparison runs, so a combination is contradictory).

### Interactive prompts (TTY only, CI is never prompted)

Every option runs exactly the same code as the standalone commands. Prompts are
skipped under `--json`, `--show-all`, `--pre-deploy`, and `--fail`. A non-TTY run
never prompts: a required write decision without `--yes` errors with exit 2 (the
safe side). "Interactive" requires **both** a TTY stdin and a TTY stdout — so
**redirecting or piping the output** (`cdkrd check > report.txt`, `| tee`) is also
treated as non-interactive: the report is written cleanly with no prompt (which
would otherwise deadlock, waiting on stdin for a prompt written into the file) and
no spinner frames leaking into the text. `--yes` in a TTY skips the write
confirmation AND each verb's selection
multiselect — `record` records ALL, `ignore` ignores ALL, `revert` applies the full
plan. Only `check`'s action menu (Record / Revert / Ignore / …) still shows under
`--yes`.

- **`check` with drift** offers `Record / Revert / Ignore / Decide per finding /
Nothing` (see [The model](#the-model-one-verb-you-run-three-it-offers)). Each
  option appears only when it applies (no Revert if nothing is revertable; "Decide per finding" only
  with >1 finding). Aborting the Revert confirmation writes nothing.
- **`revert`** shows the plan, then a multiselect of the op(s) to write. **Every op
  starts unselected**: it's the one command that writes to AWS, so you opt in to
  each write. REMOVE ops (deleting a live value not in your template) are labeled
  `(REMOVE)`. **space** toggles · **→** selects all · **←** clears all · **enter**
  confirms. `--yes` applies the full plan.
- **`record`** shows a multiselect of only the **delta** from the existing
  baseline; already-recorded unchanged values are auto-kept. **New** undeclared
  values are pre-selected; a value that **changed since record** (a recorded value
  altered out of band) is shown as `recorded → live` and default **UNSELECTED**,
  so one Enter never silently blesses a changed value. A recorded value that
  **reverted to its AWS default or was removed** since record is offered as a
  separate default-unselected "drop from baseline?" row — leaving it keeps the
  watch (it stays reported by `check`); a `--yes` record preserves it and echoes
  what it accepted. Deselect a suspicious one and it stays reported by `check`.
  Nested
  undeclared sub-keys (a value inside an object you _did_ declare) are listed in
  full alongside the top-level ones — a non-default one is a real out-of-band
  setting, so it is surfaced, not hidden. `record` writes only undeclared + added
  state; any declared /
  deleted drift is not written and `record` prints a note that it still stands
  (resolve with `revert` or `cdk deploy`).
- **`Decide per finding`** assigns a different action to each finding. On a busy
  stack, **just start typing to filter** the rows (↑↓ move · space cycles a row's
  actions · → applies the focused action to every visible row · enter applies).
- **Folded inventory**: if `check` folded undeclared values out of the report,
  Ignore / Decide first ask whether to act on just the shown drift (default) or the
  folded values too, so the picker never lists values you never saw.

### `--pre-deploy`

Normal `check` asks "did reality drift from what I deployed?". `--pre-deploy` asks
the inverse, **right before a deploy**: "which LIVE values would my local code
overwrite?" It compares live state against your **local synth** template, so a
console hot-fix made during an incident shows up before `cdk deploy` silently
reverts it:

```console
$ npx cdkrd check --pre-deploy
(--pre-deploy) comparing live state against the LOCAL synth template
=== check: ApiStack (us-east-1) ===
[CFn-Declared Drift: 1]
  Api/Handler.MemorySize (AWS::Lambda::Function)
      desired=1024
      actual =2048

───────────────────────────────
result: 1 drift(s) (declared=1)
───────────────────────────────
```

`desired` is what your local code is about to set; `actual` is live now: someone
bumped memory to 2048 out of band. Port it into code (or decide it should go away)
before deploying. As a pipeline gate:

```yaml
- run: npx cdkrd check --pre-deploy --fail # block the deploy on clobber risk
- run: npx cdk deploy --all --require-approval never
```

`--pre-deploy` reports **declared** drift only (the undeclared tier is defined
against the _deployed_ template) and never touches the baseline.

### Ignoring externally-managed properties

Some properties are _legitimately_ rewritten by another system, such as Application
Auto Scaling moving an ECS Service `DesiredCount`, or autoscaled DynamoDB capacity.
A recorded snapshot would re-flag every move. Run **`cdkrd ignore`** to pick the
drift to suppress, or hand-edit the git-committed `.cdkrd/ignore.yaml`. It is a
hand-edited policy file (the `.gitignore` / `.dockerignore` / `.trivyignore`
family), so it is YAML rather than JSON: the single most valuable hand-edit is a
`#` comment recording **why** a property is ignored, and YAML can carry it where
JSON cannot. (The companion baseline stays JSON because it is the opposite —
machine-generated, wholesale-rewritten data, not human policy.)

```yaml
# cdkrd ignore rules — properties cdkrd should stop reporting as drift.
ignore:
  # DesiredCount is managed by Application Auto Scaling
  - path: '*.DesiredCount'
  # the common case: scope a rule to one stack
  - path: '*.DesiredCount'
    stack: Prod*
  # narrow further to a single account and/or region when the same stack
  # name is deployed to several (a property may legitimately drift in only one)
  - path: Fn*.ReservedConcurrentExecutions
    stack: Prod*
    account: '111111111111'
    region: ap-northeast-1
```

- Every rule is a mapping `{ path, stack?, account?, region? }`. `cdkrd ignore`
  stamps the current **stack / account / region** onto each rule it writes (the same
  three identity axes a baseline file is keyed on), so ignoring a within-stack path on
  one stack never leaks to a same-named twin stack in another account/region — an
  unscoped `{ path }` was match-all (#757). The verb is **comment-preserving and
  append-only**: it keeps your existing comments and layout, and appends new rules at
  the end — you own the order. `path` is an exact `<constructPath>.<path>` — the
  construct path WITHIN the stack (the stack/Stage prefix stripped), byte-identical to
  what `cdkrd check` prints, so you can copy what you see (or `<logicalId>.<path>` on a
  non-CDK stack). Rules written with the older full `<stack>/<constructPath>.<path>`
  form still match. Widening a stamped scope to a `*` glob (to intentionally ignore a
  path across every stack/account/region) stays a hand-edit.
- All four fields accept `*` / `?` globs, but the `path` axis is **segment-aware**
  while the scope axes are not. In `path`, `*` / `?` match within a single
  segment, bounded by `.`, `/`, and `[` (`*.DesiredCount` matches
  `<anyId>.DesiredCount`, not a deeper `Tbl.Config.DesiredCount`; `MyApi/*`
  matches a direct construct-path child but not a grandchild
  `MyApi/Resource/Method`) — but an explicit parent `path` (e.g. `MyApi/Resource`)
  still covers its whole `/`-subtree (`MyApi/Resource/Method.Prop`) via the
  ancestor walk, symmetric with the `.` case, so the segment bound does not
  under-match. A leaf-pinned wildcard like `MyApi/*.Prop` still does NOT cross
  segments (it only matches a direct child's `.Prop`). Inside a `[...]`
  bracket key a `*` /
  `?` is **unbounded within that bracket** (the brackets delimit the key, so a `.`
  between them is data): `Alb.LoadBalancerAttributes[*]` and
  `Alb.LoadBalancerAttributes[routing.*]` both match the dotted key
  `[routing.http2.enabled]`. To match a **literal** `*` / `?` in a `path`
  (e.g. an API Gateway `MethodSettings[*]` key from `HttpMethod: '*'`, or an S3
  lifecycle `Id` like `clean*tmp`), backslash-escape it — `\*` / `\?` (and `\\`
  for a literal backslash). The `ignore` verb writes such paths pre-escaped, so
  a machine-written rule matches only the finding it came from; hand-copied rules
  need the escape added. On **stack / account / region**, `*` / `?` are unbounded
  (those names carry no `.`). The three scope axes are exactly the
  baseline file's identity axes; each is **omitted to leave that axis unscoped**
  (match-all) — a present-but-empty `""` is rejected (it would match nothing),
  as is an all-wildcard `path` (`*`, `**`, `*.*`) — it would silence _every_
  finding, so a rule must name at least one literal segment.
  **Account** keeps a `stack: "Prod*"` rule from
  leaking into a same-named stack in another account (stack-name uniqueness only
  holds within one account / App); **region** is independent the same way — the same
  stack in several accounts or regions may drift in only one.
- Matching findings move to the informational `ignored` tier: visible under
  `--verbose`, never exit-affecting, excluded from `revert` and `record`. A
  **deleted resource is never ignorable**.

## Output

Two parts: the **drift sections** in full detail, then a one-line `info:` footer
that folds everything informational.

```console
=== check: ApiStack (us-east-1) ===
[CFn-Declared Drift: 1]
  UploadBucket.VersioningConfiguration.Status (AWS::S3::Bucket)
      desired="Enabled"
      actual ="Suspended"

───────────────────────────────
result: 1 drift(s) (declared=1)
───────────────────────────────
info:
  - readGap=1 (declared but unverifiable — AWS doesn't return them on read, not drift: 1 write-only)
  - skipped=2 (custom resource 2)
  run with --verbose for the list
```

- **Drift tiers** (`deleted` / `declared` / `undeclared`) are always listed in
  full and drive the `--fail` exit. They are the point.
- **`[Potential Drift: N]`**: undeclared values with no baseline yet; cdkrd
  can't tell an intentional setting from an out-of-band change, so they're listed
  in full as _potential_ (unconfirmed) drift and don't drive the `--fail` exit;
  `result:` points you at `cdkrd record` to accept them (or `revert` to remove).
  Once a resource is fully snapshotted, a value that _appears_ later is real drift
  (`appeared since record`).
- **`↳` origin hint**: when a finding's live value has a recognizable external
  source — e.g. the CloudWatch Application Signals / Lambda Insights
  auto-instrumentation footprint (an added Insights layer + tracer execution
  policy, typically enabled account-wide, not per-resource) — a `↳` line names
  the likely source. It's an explanation only: the finding is still real drift and
  still drives the exit, so an unexpected account-wide enablement is never hidden.
- **`info:` footer** folds the informational tiers to per-reason counts
  (`--verbose` expands them):

| tier                                             | what it folds                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atDefault`                                      | an undeclared value sitting at a known AWS default (e.g. Lambda `TracingConfig: PassThrough`). Equality-gated, so a change away from it re-surfaces; never recorded.                                                                                                                                                                                                                                                       |
| `generated`                                      | an undeclared value AWS/CDK minted, like an auto `TopicName`. Equality-gated; never recorded.                                                                                                                                                                                                                                                                                                                              |
| `nested`                                         | an undeclared sub-key inside a property you _did_ declare (e.g. a CloudFront origin gaining `ConnectionTimeout`, or an API Gateway method's `Integration.PassthroughBehavior`). Surfaced in full like a top-level undeclared value — a non-default nested value is a real out-of-band setting — and recordable. (Catalogued AWS defaults are folded upstream as `atDefault`/`generated`, so only genuine settings remain.) |
| `readGap` / `unresolved` / `skipped` / `ignored` | values cdkrd can't confidently compare, reported honestly rather than guessed (never false drift).                                                                                                                                                                                                                                                                                                                         |

`^result:` is the greppable verdict, framed by a horizontal rule when there is
drift so it stands out from the findings above (a CLEAN stack stays compact).
Colorized on a TTY (`NO_COLOR` respected): red/yellow/green for the verdicts and
tiers, while explanatory prose (tier notes, the `↳` hint, the `info:` footer) uses
your terminal's default foreground so it stays legible on any theme — dim/gray is
reserved for picker rows you aren't on. Piped / CI / `--json` output is plain text.

### JSON output contract

`--json` emits **one top-level JSON array for the whole invocation — one element per
stack**:

```json
[
  { "stack": "stackA (us-east-1)", "drifted": 1, "findings": [ ... ] },
  { "stack": "stackB (us-east-1)", "drifted": 0, "findings": [] }
]
```

The whole stdout stream is a single `JSON.parse`-able value. This holds even for a
single-stack run — it is an **array of one** (never a bare object), so a consumer's
`JSON.parse` always yields an array and never has to special-case the count. (Earlier
builds printed one pretty-printed `{...}` per stack back-to-back, which was neither one
valid JSON value nor JSONL; multi-stack `--json` was unparseable — issue #755.) All
`note` / `warning` / progress lines go to **stderr**, so stdout stays pure JSON.

A **stack that errored or was skipped** before it could be checked still appears as an
element so a consumer sees which stacks ran: it carries `"error": "<reason>"` alongside
`"drifted": 0` and an empty `"findings": []`. (`error` is absent on a
successfully-checked stack.) Its `stack` is `"<name> (<region>)"` as usual, EXCEPT
when the failure is that no region could be resolved for the stack — then `stack`
is the bare `"<name>"` (no ` (<region>)` suffix), since there is no region to name.

A **stack deleted out of band** — its committed baseline proves it was once deployed but
it is now gone from CloudFormation — is the strongest drift, so it carries
`"drifted": 1` and `"stackDeleted": true` (never `"error"`, which is reserved for a
pre-check failure). A consumer summing `drifted` across stacks therefore sees the
deletion instead of a misleading zero.

If the whole invocation fails before any stack is reached (bad config, an
un-synthesizable app, or a zero-stack app), stdout is still a valid empty array
`[]` (exit code non-zero, the reason on stderr) — never empty bytes.

Each stack element is `{ "stack": "<name> (<region>)", "drifted": <n>, "findings": [...] }`
(`error` added only on a pre-check failure; `stackDeleted: true` only on a deleted
stack). Each **finding** has a stable shape:

- Always present: `tier`, `logicalId`, `resourceType`, `path`.
- Usually present: `desired`, `actual`, `note`, `physicalId`, `constructPath` (any of
  these may be omitted when it doesn't apply — e.g. an undeclared finding has no
  `desired`).
- `tier` is one of `deleted` | `added` | `declared` | `undeclared` | `atDefault` |
  `generated` | `ignored` | `readGap` | `unresolved` | `skipped`. The output carries
  **every** finding of every tier (including the informational `atDefault` / `generated`
  / `ignored` / `readGap` / `unresolved` / `skipped` ones the text report folds into its
  `info:` footer), regardless of `--verbose`.
- `drifted` counts only confirmed-drift tiers (`deleted` / `declared` / `undeclared` /
  `added`) that are not `unrecorded`; the informational tiers and unrecorded values are
  excluded.

Optional per-finding fields, present only when they apply:

- `hint` — a non-classifying, human-facing note on where a live value likely came from
  (e.g. an account/region-level auto-instrumentation footprint). Display-only; it never
  changes the tier.
- `unrecorded` (`true`) — a live-only value (`undeclared` or `added`) with no baseline
  entry yet: **potential drift**, not confirmed drift. Excluded from `drifted`.
- `attributeKey` — for a `declared` drift inside an identity-keyed attribute bag (ELB
  `LoadBalancerAttributes` / `TargetGroupAttributes`), the `Key` of the changed
  attribute (`path` stays at the bag property; `desired`/`actual` are the scalar value).
- `arrayDelta` — for an `undeclared` recorded identity-keyed array that changed vs the
  baseline, the element-level delta (`{ identityField, added, changed, removed }`) so a
  consumer sees which element(s) differ, not the whole-array dump.
- `nested` (`true`) — an `undeclared` value is a live sub-key inside a property you
  _did_ declare (dotted `path`). `freeFormKey` (`true`) additionally marks it as living
  inside a free-form map (e.g. a Lambda env var).
- `modelReadFailed` (`true`) — an `added` resource whose full live model could not be
  read this run (`actual` is only the enumerator's identity snippet); it exists but is
  not change-watchable until the next check.
- `wholeArrayRevert` (`{ path, value }`) — **internal, revert-only** metadata on a
  `declared` per-element finding inside an unordered object-array (a set the
  service reorders — SecurityGroup rules, PrefixList entries, …): it carries the
  WHOLE declared array so `revert` replaces the array as a unit instead of
  index-patching a sorted position that does not map to the live index.
  Display-only for the report; a consumer can ignore it.
- `siblingPolicyNames` (`"unresolved"`) — **internal, revert-only** sentinel on a
  `declared` IAM Role `Policies` finding whose sibling `AWS::IAM::Policy` names
  could not be resolved; `revert` reads it and refuses to act (a per-entry revert
  could delete a managed inline policy). The only emitted value is the
  `"unresolved"` string; a consumer can ignore it.
- On an `added` finding, `desired` carries the **recorded baseline model** and `actual`
  the live one (so a recorded `added` resource that changed shows the delta), and
  `unrecorded` marks a never-recorded one as potential drift.

`record` / `ignore` / `revert` also honor `--json` (for scripting / non-TTY use),
each emitting the same **one-array-per-invocation** shape — one element per stack,
all notes on stderr, `[]` on a top-level error. `--json` forces non-interactive
mode: a `record` / `ignore` that would need the selection prompt refuses without
`--yes` (`"refused": true`), and `revert` refuses the AWS write without `--yes`
(`"exit": 2`). Per-verb element:

- `record` → `{ "stack", "recorded": <n>, "wrote": <bool>, "baseline"?: "<path>",
"refused"?: true, "error"?: "<reason>" }` — `recorded` is how many undeclared
  value(s) were written.
- `ignore` → `{ "stack", "added": <n>, "wrote": <bool>, "config"?:
".cdkrd/ignore.yaml", "refused"?: true, "error"?: "<reason>" }` — `added` is how
  many new rules were appended.
- `revert` → `{ "stack", "reverted": <n>, "failed": <n>, "aborted": <bool>, "exit":
<n>, "error"?: "<reason>" }` — `reverted` / `failed` count resources; `exit` is
  that stack's contribution (0 clean / 1 drift remains / 2 failure).

After publication this shape is a backward-compatible API.

`revert` also **refuses to write (exit 2) when the target stack is mid-operation**
(`*_IN_PROGRESS`): it re-reads the stack status immediately before applying, so a
revert can never fight an in-flight `cdk deploy` / update by writing stale values
onto an updating stack — wait for the stack to settle, then re-run. And
`record` / `ignore` / `revert` now surface the same stack-status warning `check`
prints when a stack is mid-operation or in a failed state (a `record` mid-update
would otherwise snapshot transient values into the committed baseline).

## IAM permissions

`check` / `record` are **read-only**: the AWS managed `ReadOnlyAccess` policy
covers them. **If you never run `revert`, cdkrd needs no write permissions at all.**

<details>
<summary>Minimal read permissions (check / record)</summary>

- `cloudformation:GetTemplate`, `ListStackResources`, `DescribeStacks`,
  `DescribeType`; `DescribeStackResources` (the sibling-ownership check for the
  `added` tier — see the `added`-tier entry below); `ListExports` (only for
  templates using `Fn::ImportValue`)
- `sts:GetCallerIdentity` (resolves the current account so `check` can tell a stack
  never deployed in THIS account from one deleted out of band, under the
  multi-account baseline pattern — allowed for any valid credentials, so no policy
  statement is normally required)
- `cloudcontrol:GetResource`: Cloud Control invokes each type's own read handler,
  so it needs that type's read permissions (this is why `ReadOnlyAccess` is the
  simple answer). `revert` additionally uses `cloudcontrol:UpdateResource` /
  `cloudcontrol:DeleteResource` (the latter to delete an out-of-band `added`
  resource) and `cloudcontrol:GetResourceRequestStatus` to poll the async request —
  see the revert section below.
- SDK readers for the Cloud-Control-gap types: `s3:GetBucketPolicy`,
  `sns:GetTopicAttributes`, `sqs:GetQueueAttributes`, `iam:GetRolePolicy`,
  `iam:GetUserPolicy`, `iam:GetGroupPolicy`, `iam:GetPolicy`, `iam:GetPolicyVersion`,
  `lambda:GetPolicy`, `budgets:ViewBudget`, `ec2:DescribeAddresses`,
  `ec2:DescribeLaunchTemplateVersions`, `ec2:DescribeNetworkAcls`,
  `route53:ListResourceRecordSets`,
  `ses:DescribeReceiptRuleSet`, `ses:DescribeReceiptRule`, `ses:ListReceiptFilters`
  (the SES inbound receipt-rule family — `ReceiptRuleSet` / `ReceiptRule` /
  `ReceiptFilter` — has no Cloud Control handlers),
  `acm:DescribeCertificate` + `acm:ListTagsForCertificate` (read an
  `AWS::CertificateManager::Certificate` — the ACM registry type ships no Cloud
  Control read handler, so every cert was silently skipped, including an
  out-of-band `Options.CertificateTransparencyLoggingPreference` flip or an
  out-of-band deletion of a cert an ALB / CloudFront / API domain still references),
  `glue:GetTable`, `logs:DescribeMetricFilters`, `scheduler:GetSchedule`,
  `cloudwatch:DescribeAnomalyDetectors` (reads an
  `AWS::CloudWatch::AnomalyDetector` — NON_PROVISIONABLE, no Cloud Control
  handlers),
  `dlm:GetLifecyclePolicy` (reads an `AWS::DLM::LifecyclePolicy` — a Data
  Lifecycle Manager EBS-snapshot / AMI backup-schedule policy, NON_PROVISIONABLE
  with no Cloud Control handlers; the physical id IS the policy id),
  `dms:DescribeEndpoints` + `dms:DescribeReplicationSubnetGroups` (read an
  `AWS::DMS::Endpoint` / `AWS::DMS::ReplicationSubnetGroup` — the classic DMS
  migration/CDC family, NON_PROVISIONABLE with no Cloud Control handlers),
  `mediaconvert:GetQueue` + `mediaconvert:GetJobTemplate` (read an
  `AWS::MediaConvert::Queue` / `AWS::MediaConvert::JobTemplate` — a video-pipeline
  staple, NON_PROVISIONABLE with no Cloud Control handlers; the physical id IS the
  resource name),
  `ssm:DescribeParameters` (supplements the Cloud Control read of an
  `AWS::SSM::Parameter` with its writeOnly `Description` / `AllowedPattern`),
  `elasticache:DescribeReplicationGroups` + `elasticache:DescribeCacheClusters`
  (supplement an `AWS::ElastiCache::ReplicationGroup` with its writeOnly
  `PreferredMaintenanceWindow` / `NotificationTopicArn` / `EngineVersion`, read
  from the member cache cluster),
  `elasticache:DescribeCacheParameterGroups` + `elasticache:DescribeCacheParameters`
  (read an `AWS::ElastiCache::ParameterGroup`'s `Properties` as the `Source=user`
  MODIFIED set only — the Cloud Control read returns the full effective set, so the
  ~60 inherited engine defaults would otherwise surface as first-run drift; an
  out-of-band parameter change is `Source=user` and still detected),
  `ecs:DescribeServices` (supplements an
  `AWS::ECS::Service` with its writeOnly `ServiceConnectConfiguration` /
  `VolumeConfigurations`, read from the PRIMARY deployment),
  `elasticache:DescribeUsers` + `memorydb:DescribeUsers` (supplement an
  `AWS::ElastiCache::User` / `AWS::MemoryDB::User` with its writeOnly
  `AccessString` — the Redis/Valkey ACL; an out-of-band permission grant is
  otherwise invisible to the Cloud Control read),
  `memorydb:DescribeParameters` + `memorydb:DescribeParameterGroups` (supplement an
  `AWS::MemoryDB::ParameterGroup` with its writeOnly `Parameters` — folding the
  family-default fill by diffing the managed `default.<family>` group; the MemoryDB
  provider does not apply declared parameters on CREATE, so this surfaces the
  never-applied tuning that was otherwise an invisible readGap),
  `redshift-serverless:GetWorkgroup` (supplements an
  `AWS::RedshiftServerless::Workgroup` with its writeOnly `ConfigParameters` /
  `SecurityGroupIds` / `SubnetIds`, which the Cloud Control read returns only
  inside its read-only echo attribute — an out-of-band security-group swap or
  config-parameter change is otherwise invisible),
  `kafka:DescribeConfiguration` + `kafka:DescribeConfigurationRevision`
  (supplement an `AWS::MSK::Configuration` with its writeOnly `ServerProperties`
  Kafka blob — an out-of-band `update-configuration` revision is otherwise
  invisible),
  `elasticbeanstalk:DescribeConfigurationSettings` (supplements an
  `AWS::ElasticBeanstalk::Environment` with its writeOnly `OptionSettings` — the
  full resolved option set; an out-of-band console edit to any environment option
  is otherwise invisible, and the service-filled default options fold to
  `atDefault`),
  `servicediscovery:GetNamespace` + `servicediscovery:GetService` (read a Cloud Map
  `HttpNamespace` / `PrivateDnsNamespace` / `PublicDnsNamespace` — incl. the Arn an
  ECS Service Connect namespace `Fn::GetAtt` resolves against — and a Cloud Map
  `Service`),
  `docdb:DescribeDBClusters` + `docdb:DescribeDBInstances` (read an
  `AWS::DocDB::DBCluster` / `AWS::DocDB::DBInstance` — the whole DocumentDB family is
  a Cloud Control read gap),
  `codebuild:BatchGetProjects` (reads an `AWS::CodeBuild::Project`) +
  `codebuild:BatchGetReportGroups` (reads an `AWS::CodeBuild::ReportGroup`),
  `dax:DescribeClusters` + `dax:DescribeParameterGroups` + `dax:DescribeParameters` +
  `dax:DescribeSubnetGroups` (read an `AWS::DAX::Cluster` / `ParameterGroup` /
  `SubnetGroup` — the DynamoDB Accelerator family),
  `ec2:DescribeClientVpnEndpoints` + `ec2:DescribeClientVpnAuthorizationRules` +
  `ec2:DescribeClientVpnTargetNetworks` (read an `AWS::EC2::ClientVpnEndpoint` /
  `ClientVpnAuthorizationRule` / `ClientVpnTargetNetworkAssociation`),
  `iam:ListAccessKeys` (reads an `AWS::IAM::AccessKey`'s `Status`) +
  `iam:ListEntitiesForPolicy` (enumerates a managed policy's attachments),
  `appsync:ListApiKeys` (reads an `AWS::AppSync::ApiKey` — a Cloud Control gap),
  `cognito-sync:GetCognitoEvents` (enriches the Cloud Control read of an
  `AWS::Cognito::IdentityPool` with its writeOnly `CognitoEvents` Sync trigger),
  `glue:GetClassifier` + `glue:GetWorkflow` + `glue:GetConnection`
  (`glue:GetConnection` is issued with `HidePassword` so NO credential enters the
  baseline — read an `AWS::Glue::Classifier` / `Workflow` / `Connection`, the rest
  of the Glue family that has no Cloud Control handler),
  `rds:DescribeOptionGroupOptions` (reads an `AWS::RDS::OptionGroup`'s option-default
  catalog — the `DefaultValue` AWS materializes for every plugin setting the template
  did not declare — so the service default-fill folds to `atDefault` instead of
  flooding a clean first check with undeclared settings; equality-gated, so an
  out-of-band setting change is still detected. Without the permission cdkrd warns
  once and those default-fill settings surface as first-run drift)
- Optional: `elasticloadbalancing:GetTrustStoreCaCertificatesBundle` records a
  content hash of an `AWS::ElasticLoadBalancingV2::TrustStore`'s live mTLS CA
  bundle (`CaCertificatesBundleSha256`) so an out-of-band CA-bundle swap
  re-surfaces as drift — otherwise invisible (the bundle location is write-only).
  It fetches the presigned S3 URL the API returns; without the permission (or on
  any fetch failure) the signal is skipped, never false-flagged.
- Optional: `kms:ListAliases` enables strict verification that a declared
  `alias/aws/*` key was not swapped for a customer-managed key. Without it that case
  is conservatively suppressed AND cdkrd prints a one-line warning per region (the
  swap would otherwise go undetected), so the reduced coverage is never silent.
- **`added` tier (out-of-band resource detection).** The `added` tier — cdkrd's
  detection of live child resources that exist in AWS but were never declared in
  your template (a headline differentiator) — enumerates each declared parent's
  live children with per-service list/describe calls. **These are NOT covered by
  the entries above; a scoped policy that omits them silently degrades every
  `added` finding to `skipped` and makes `--strict` exit 1 permanently.** If you
  want this differentiator, include them; if not, that is the tradeoff. By
  declared parent type:
  - `AWS::ApiGateway::RestApi` + `AWS::ApiGatewayV2::Api`: `apigateway:GET`
    (REST `GetResources` / `GetAuthorizers` / `GetModels` /
    `GetRequestValidators` / `GetGatewayResponses`; HTTP `GetRoutes` /
    `GetIntegrations` / `GetAuthorizers` / `GetStages` — every API Gateway read
    resolves to the single `apigateway:GET` action)
  - `AWS::SNS::Topic`: `sns:ListSubscriptionsByTopic`
  - `AWS::Lambda::Function`: `lambda:ListEventSourceMappings`,
    `lambda:ListFunctionUrlConfigs`, `lambda:ListAliases`,
    `lambda:ListVersionsByFunction`
  - `AWS::Events::EventBus`: `events:ListRules`
  - `AWS::Cognito::UserPool`: `cognito-idp:ListUserPoolClients`,
    `cognito-idp:ListGroups`, `cognito-idp:ListResourceServers`
  - `AWS::AppSync::GraphQLApi`: `appsync:ListDataSources`, `appsync:ListResolvers`,
    `appsync:ListFunctions`, `appsync:ListTypes`
  - `AWS::Logs::LogGroup`: `logs:DescribeSubscriptionFilters` (plus
    `logs:DescribeMetricFilters`, already listed above)
  - `AWS::ElasticLoadBalancingV2::LoadBalancer` + `::Listener`:
    `elasticloadbalancing:DescribeListeners`, `elasticloadbalancing:DescribeRules`
  - `AWS::EC2::VPC` + `AWS::EC2::RouteTable`: `ec2:DescribeSubnets`,
    `ec2:DescribeRouteTables`
  - `AWS::ECS::Cluster`: `ecs:ListServices` (distinct from the
    `ecs:DescribeServices` override reader listed above)
  - `AWS::KMS::Key`: `kms:ListAliases` (the same action listed as optional
    above — here it enumerates a key's aliases as child resources, so it is
    required, not optional, for the `added` tier)
  - `AWS::AppConfig::Application`: `appconfig:ListEnvironments`,
    `appconfig:ListConfigurationProfiles`
  - `AWS::EFS::FileSystem`: `elasticfilesystem:DescribeMountTargets`
  - `AWS::RDS::DBCluster`: `rds:DescribeDBClusters`, `rds:DescribeDBInstances`

  The `added` tier also needs `cloudformation:DescribeStackResources` (grouped with
  the other CloudFormation actions above): before flagging a live child as
  out-of-band `added` — which offers a destructive `DeleteResource` revert — cdkrd
  confirms the child is not owned by a DIFFERENT (sibling) stack. Without it a
  cross-stack child is false-flagged `added`.

</details>

<details>
<summary>Additional write permissions (revert)</summary>

`cloudcontrol:UpdateResource` (which resolves to each type's own update
permissions), `cloudcontrol:DeleteResource` (to delete an out-of-band `added`
resource), and `cloudcontrol:GetResourceRequestStatus` (to poll the async Cloud
Control request to completion). Plus, for the SDK-written types:
`s3:PutBucketPolicy` /
`s3:DeleteBucketPolicy`, `sns:SetTopicAttributes`, `sqs:SetQueueAttributes`,
`events:PutPermission` (reverts an `AWS::Events::EventBusPolicy`),
`iam:PutRolePolicy` / `DeleteRolePolicy` / `PutUserPolicy` / `PutGroupPolicy`,
`iam:CreatePolicyVersion` / `DeletePolicyVersion` / `ListPolicyVersions`,
`elasticloadbalancing:ModifyLoadBalancerAttributes` / `ModifyTargetGroupAttributes`,
`glue:UpdateTable`, `glue:UpdateConnection` (reverts an `AWS::Glue::Connection` —
the whole `ConnectionInput` is re-supplied; a connection with an inline password
is refused, never overwritten, so the un-read credential is never cleared),
`logs:PutMetricFilter`, `route53:ChangeResourceRecordSets`,
`elasticache:ModifyCacheParameterGroup` / `ResetCacheParameterGroup` (revert an
`AWS::ElastiCache::ParameterGroup` — a changed declared parameter is modified back
to its desired value; an out-of-band-added undeclared parameter is reset to the
family default),
`memorydb:UpdateParameterGroup` / `ResetParameterGroup` (revert an
`AWS::MemoryDB::ParameterGroup` — a declared parameter is applied to its desired
value, which also materializes tuning the provider never applied on CREATE; an
out-of-band-added undeclared parameter is reset to the family default),
`ses:UpdateReceiptRule` (reverts an `AWS::SES::ReceiptRule` — the whole rule is
re-supplied in place, since Cloud Control has no handler for the type),
`cloudwatch:PutAnomalyDetector` (reverts an `AWS::CloudWatch::AnomalyDetector`
`Configuration` drift — an upsert keyed on the detector's createOnly identity),
`dlm:UpdateLifecyclePolicy` (reverts an `AWS::DLM::LifecyclePolicy` — the same
Description / State / ExecutionRoleArn / PolicyDetails shape is re-supplied in
place, since Cloud Control has no handler for the type),
`docdb:ModifyDBCluster` / `ModifyDBInstance`,
`config:DescribeConfigRules` / `config:PutConfigRule`,
`ecs:UpdateService` (reverts an `AWS::ECS::Service` `ServiceConnectConfiguration` /
`VolumeConfigurations` drift — the whole writeOnly prop is re-supplied, since Cloud
Control cannot sub-path patch it),
`elasticbeanstalk:UpdateApplication` / `elasticbeanstalk:UpdateEnvironment`
(revert an `AWS::ElasticBeanstalk::Application` / `Environment`),
`codebuild:UpdateReportGroup` (reverts an `AWS::CodeBuild::ReportGroup`),
`dax:UpdateCluster` / `dax:UpdateParameterGroup` (revert an `AWS::DAX::Cluster` /
`ParameterGroup`),
`ec2:ModifyClientVpnEndpoint` (reverts an `AWS::EC2::ClientVpnEndpoint`),
`opensearch:UpdateDomainConfig` (reverts an `AWS::OpenSearchService::Domain`),
`cloudfront:GetDistributionConfig` / `cloudfront:UpdateDistribution` (revert an
`AWS::CloudFront::Distribution`),
`wafv2:GetWebACL` / `wafv2:UpdateWebACL` (revert an `AWS::WAFv2::WebACL`),
`glue:UpdateJob` / `glue:UpdateClassifier` / `glue:UpdateWorkflow` (revert an
`AWS::Glue::Job` / `Classifier` / `Workflow`),
`servicediscovery:UpdateHttpNamespace` (reverts an
`AWS::ServiceDiscovery::HttpNamespace` `Description`),
`cognito-sync:SetCognitoEvents` (reverts an `AWS::Cognito::IdentityPool`'s
writeOnly `CognitoEvents`),
`kinesisvideo:UpdateDataRetention` / `kinesisvideo:UpdateSignalingChannel` /
`kinesisvideo:UpdateStreamStorageConfiguration` (revert an `AWS::KinesisVideo::Stream`
`DataRetentionInHours` / `StreamStorageConfiguration` and an
`AWS::KinesisVideo::SignalingChannel` `MessageTtlSeconds`),
`kafka:UpdateConfiguration` (reverts an `AWS::MSK::Configuration` `ServerProperties`
— append-only, a new revision carrying the desired properties),
`logs:PutBearerTokenAuthentication` (reverts an `AWS::Logs::LogGroup`
`BearerTokenAuthenticationEnabled`),
`iam:AttachRolePolicy` / `DetachRolePolicy` / `AttachUserPolicy` /
`DetachUserPolicy` /
`AttachGroupPolicy` / `DetachGroupPolicy` / `ListEntitiesForPolicy` (revert an
`AWS::IAM::ManagedPolicy`'s attachments alongside the `CreatePolicyVersion` above),
the `lexv2models:*` write family
(`CreateIntent` / `UpdateIntent` / `DeleteIntent`, `CreateSlot` / `UpdateSlot` /
`DeleteSlot`, `CreateSlotType` / `UpdateSlotType` / `DeleteSlotType`,
`UpdateBotLocale` / `BuildBotLocale`, plus the `Describe*` / `List*` reads they
build on) to revert an `AWS::Lex::Bot` `BotLocales` drift,
`apigateway:PATCH` (the single IAM action API Gateway maps its update operations
to — reverts an `AWS::ApiGatewayV2::Stage`, where an `autoDeploy` stage rejects the
`DeploymentId` the Cloud Control handler injects so only the drifted stage
properties are written directly, and an `AWS::ApiGateway::RestApi` `Policy`, where
the whole desired resource policy is re-serialized and replaced since Cloud Control
holds the policy as a JSON string it cannot sub-path patch, and an
`AWS::ApiGateway::Method`'s
nested integration/response knobs) plus `apigateway:DELETE` (clearing a stage's
access-log / route settings back to unset).

</details>

## Limitations

`cdkrd` is **fail-closed**: anything it can't confidently compare is reported as
informational, never guessed (zero false drift). For the full list of what it does
not do (revert's boundaries, nested stacks, per-type read gaps, stack-state
handling), see [docs/limitations.md](docs/limitations.md).

The exception to zero-false-drift is the **`[Potential Drift]`** tier: with no
baseline yet, cdkrd can't confirm those live-only values, so it strips the noise
it recognizes and shows the rest as a best-effort guess — which can occasionally
surface an AWS-managed default or noise it hasn't catalogued (a false positive).

## Reporting issues

Found a false positive in `[Potential Drift]` (an AWS-managed default or noise
that should have been folded), a missed detection, or any other bug? Please
[open an issue](https://github.com/go-to-k/cdk-real-drift/issues) — noise reports
turn directly into fold-table fixes and make the next run quieter for everyone.

## FAQ

How `cdkrd` differs from `cdk deploy --revert-drift`, why the baseline is a
committed file, why `ignore` rules live in `.cdkrd/ignore.yaml`, and more:
[docs/faq.md](docs/faq.md).

## Contributing

```bash
pnpm install
vp run test         # unit tests        vp run typecheck
vp run check        # lint + format     vp run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Integration tests (real AWS, self-cleaning)
live under [tests/integration/](tests/integration/README.md). Design rationale:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [DESIGN.md](DESIGN.md).

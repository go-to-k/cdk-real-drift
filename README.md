# cdk-real-drift (`cdkrd`)

Drift detection for AWS CDK that sees what your template can't — including the
**properties you never declared**. Detect it, record it, or revert it.

<!-- badges (enable on publish):
[![npm](https://img.shields.io/npm/v/cdk-real-drift)](https://www.npmjs.com/package/cdk-real-drift)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
-->

> **Day to day you run one command: `cdkrd check`.** On a TTY it finds drift and
> then offers **Record / Revert / Ignore** right there on what it found — so you
> never invoke the other verbs by hand. `record` / `ignore` / `revert` exist as
> standalone commands only for non-TTY use (scripting / CI, with `--yes`). In CI
> you run `cdkrd check --fail`. That's the whole workflow.

## Why

Someone attaches an extra inline policy to one of your roles from the console.
CloudFormation drift detection only compares properties that **appear in your
template**, so it reports nothing:

```bash
$ npx cdk drift
✨  Number of resources with drift: 0
```

`cdkrd` reads the **full** live resource model and subtracts everything
explainable — the same change shows up:

![cdkrd finds an out-of-band inline policy that `cdk drift` reports as zero](demo/demo.gif)

```console
$ npx cdkrd check
=== cdkrd check: ApiStack (us-east-1) ===
[CFn-Undeclared Drift: 1] (live-only (not in your CloudFormation template), changed from your .cdkrd baseline — the differentiator)
  ApiStack/ApiRole.Policies (AWS::IAM::Role) — appeared since record = [{"PolicyName":"manual-debug-access", ...}]

result: 1 drift(s) (undeclared=1)
```

_The GIF is regenerated with [`demo/`](demo/) (`bash demo/setup.sh` → `vhs demo/cdkrd.tape`)._

| Capability                                                          | `cdkrd` | `cdk drift` / CFn drift detection |
| ------------------------------------------------------------------- | :-----: | :-------------------------------: |
| Detect drift on **declared** properties (incl. out-of-band deletes) |   ✅    |                ✅                 |
| Detect drift on **undeclared** properties                           |   ✅    |                ❌                 |
| Detect **added** out-of-band resources (not in template)            |   ✅    |                ❌                 |
| **Revert** declared drift                                           |   ✅    |  ✅ `cdk deploy --revert-drift`   |
| **Revert** undeclared drift                                         |   ✅    |                ❌                 |
| **Ignore / accept** a drift — incl. a **declared** one              |   ✅    |                ❌                 |
| **Record** undeclared / added state as a reviewed git baseline      |   ✅    |                ❌                 |

## Quick start

_Not yet on npm — coming with the first public release._

```bash
npm install -D cdk-real-drift   # in your CDK project
npx cdkrd check                 # checks every stack your app defines
```

Then act on what `check` prints, from its own interactive prompt:

1. **First run** — record a baseline (one prompt; writes a git file, nothing to
   AWS). This is the switch that arms undeclared / added detection.
2. **Day to day** — when `check` finds drift, pick **Record / Revert / Ignore**
   inline.
3. **In CI** — `npx cdkrd check --fail` (read-only, never prompts, exits 1 on
   drift).

Requirements: Node.js >= 20, AWS credentials via the standard SDK chain
(env vars, `--profile`, SSO).

### First run: record a baseline

Your template never pins every live value (AWS defaults, generated names), so the
first `check` lists the live-only values it found, then offers to record them:

```console
=== cdkrd check: ApiStack (us-east-1) ===
[Not Recorded: 2] (not drift — a live-only value not yet in your .cdkrd baseline; run cdkrd record to track it)
  ApiStack/Topic.DisplayName (AWS::SNS::Topic) = "test"
  ApiStack/Role.Policies (AWS::IAM::Role) = [{"PolicyName":"adhoc", ...}]

result: CLEAN — 42 unrecorded value(s) await a baseline (2 shown, 40 folded; run cdkrd record)

ApiStack: unrecorded values found — what do you want to do?
  ❯ Nothing (decide later)
    Record undeclared (live-only) — snapshot into the .cdkrd baseline (keeps watching)
    Ignore — stop reporting it (writes .cdkrd/config.json)
    Decide per finding — assign a different action to each
```

A few things to know about that first run:

- **A `Not Recorded` value is expected, not a bug or false positive.** It just
  means cdkrd can't yet prove the value is an AWS default and it isn't in your
  baseline. You don't "fix" it — you `record` it once to accept it.
- **The count is the complete inventory; only standouts are listed.** AWS
  defaults, auto-generated names, and untouched nested sub-keys fold into the
  `info:` footer (`atDefault=` / `generated=` / `undeclared-subkey=`; `--show-all`
  expands them). The report prints **before** the prompt, so you never bulk-record
  blind.
- **Recording writes only a git file** — `.cdkrd/ApiStack.<account>.<region>.json`,
  nothing to AWS. Commit it; from then on `check` is CLEAN until reality changes.
- **Declared drift needs no baseline** — it's detected from the very first run.

Even a fully clean fresh deploy still prompts to record, so the day-1 baseline is
always established through `check` itself:

```console
result: CLEAN

ApiStack: no .cdkrd baseline yet — record the current state as your baseline?
  ❯ Nothing (decide later)
    Record current state as the .cdkrd baseline (marks this stack reviewed)
```

`Nothing` is only the cursor default so Enter is always a harmless no-op — it's
not the recommendation. Until you record, undeclared / added drift on the stack is
unwatched. (CI's `check --fail` never writes a baseline; you record locally and
commit the file.)

### Day to day: act on drift

Someone changes something from the console; the next `check` reports it and asks
right there:

```console
ApiStack: drift found — what do you want to do?
  ❯ Nothing (decide later)
    Record undeclared (live-only) — snapshot into the .cdkrd baseline (keeps watching)
    Revert — write the desired values back to AWS
    Ignore — stop reporting it (writes .cdkrd/config.json)
    Decide per finding — assign a different action to each
```

| choice                 | does                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Record**             | snapshot the undeclared values / added resources — `check` stays CLEAN until they change again. **Keeps watching.**                  |
| **Revert**             | write the desired values back to AWS (shows a plan, opt in per op, confirms).                                                        |
| **Ignore**             | write a path rule to `.cdkrd/config.json` — the drift (declared, undeclared, **or** added) stops being reported. **Stops watching.** |
| **Decide per finding** | assign a _different_ action to each finding (the only path that mixes actions).                                                      |
| **Nothing**            | the default; Enter keeps plain-check behavior, writes nothing.                                                                       |

Each of Record / Revert / Ignore applies that one action, then a multiselect lets
you narrow **which** findings it touches. After a Record or Ignore, the menu
re-appears for any drift that action couldn't resolve (e.g. a declared drift still
standing after you recorded the undeclared values), so you finish in one run.

A reverted plan looks like this:

```console
=== cdkrd revert: ApiStack (us-east-1) ===

  ApiStack/ApiRole (AWS::IAM::Role)
    - Policies -> remove (undeclared, not in baseline)

Apply 1 revert op(s) to ApiStack? This WRITES to AWS. · yes
  reverted: ApiStack/ApiRole

verifying convergence (re-reading 1 resource(s))...
ApiStack: CLEAN after revert.
```

## The model: one verb you run, three it offers

`cdkrd check` is the entry point. The other three verbs are the **actions it
offers from the prompt** — and the same actions as standalone commands for
non-TTY use:

| verb           | meaning                                                               | writes                     |
| -------------- | --------------------------------------------------------------------- | -------------------------- |
| `cdkrd check`  | find drift (the one you run)                                          | nothing                    |
| `cdkrd record` | "this undeclared / added state is the norm — tell me if it _changes_" | a git file (baseline)      |
| `cdkrd ignore` | "stop reporting this property, ever"                                  | a git file (`config.json`) |
| `cdkrd revert` | "this state is WRONG" — write the desired value back                  | AWS (plan + confirm)       |

The one distinction to keep straight:

- **`record` keeps watching** — it snapshots the undeclared value (or added
  resource) and re-surfaces drift if it later changes. Undeclared / added only.
- **`ignore` stops watching** — it writes a path rule (declared, undeclared, _or_
  added) and the finding is never reported again. It's the only in-tool way to
  accept a **declared** drift without editing code or reverting.

`check`, `record`, and `ignore` never write to AWS. `revert` is the one mutating
verb and always confirms first (`--dry-run` to preview, `--yes` to skip the
prompt). Baselines stay a reviewed, git-committed artifact either way — CI never
writes one.

## How it works

cdkrd compares the **live AWS resource** against your **CloudFormation template**
(the one you DEPLOYED by default; the local synth with `--pre-deploy`). It does
**not** read your CDK code — it's reality vs intent, not `cdk diff`, so undeployed
code changes never show up as drift (see [`--pre-deploy`](#--pre-deploy) for the
opt-in inversion).

### The vocabulary

Three sources, named so "declared" is never ambiguous:

| term                           | source                                        | meaning                                                 |
| ------------------------------ | --------------------------------------------- | ------------------------------------------------------- |
| **CFn-declared**               | your CloudFormation template                  | the property IS in the template; the live value drifted |
| **CFn-undeclared** (live-only) | the live resource                             | the property is on the resource but NOT in the template |
| **Added Resource**             | the live resource                             | a whole resource exists live but is NOT in the template |
| **recorded / unrecorded**      | your `.cdkrd` baseline file (a separate axis) | whether you have snapshotted that live-only value yet   |

So `CFn-declared` ≠ "declared in my CDK code" and ≠ "in my `.cdkrd` baseline" — it
means the deployed **CloudFormation** template. `CFn-undeclared` and `unrecorded`
are different axes (template vs baseline file), not synonyms.

### How each kind of drift is judged

- **Declared** properties are compared against the **deployed template** — no
  baseline involved, drift is detected from the first run.
- **Undeclared** (live-only) properties are compared against the **baseline** you
  record: a JSON file at `.cdkrd/<stack>.<accountId>.<region>.json`, committed to
  git, where a PR that changes it is a reviewable change to "what real state we
  record". Account id + region are in the filename, so the same stack in several
  accounts never collides.
- **Recording the baseline is the switch that arms undeclared / added detection.**
  With no baseline, a live-only value or added resource is `unrecorded`
  (informational, CLEAN, never fails `--fail`) — there's nothing to compare it to.
  Once recorded, a later out-of-band change to it is failing drift. So the headline
  feature is inert until a stack's first `record`; declared-property and
  out-of-band-delete detection need no baseline.
- **There is no watch-list to maintain.** Every `check` snapshots the full live
  model (Cloud Control API + SDK readers for the gap types) and subtracts
  everything explainable — schema read-only/write-only/defaults, AWS-managed
  fields, `aws:*` tags, policy-document and ordering noise. What survives is signal.
- **Anything not confidently comparable is reported honestly** as informational
  (`readGap` / `unresolved` / `skipped`), never guessed — so no false drift.
- **A resource deleted out of band** — the most blatant drift there is — is
  reported in the `deleted` tier and always fails under `--fail`.

### Added out-of-band resources

A whole child resource that exists live but isn't in your template (e.g. an API
Gateway `ANY` method added on `/` via the console) is the resource-level sibling
of an undeclared property, and is reconciled the same way against your baseline:

| state                       | reported as                             |
| --------------------------- | --------------------------------------- |
| added, **not** recorded     | **Not Recorded** (inventory, not drift) |
| recorded, unchanged         | suppressed                              |
| recorded, **changed** since | failing drift                           |

`cdk drift` / CFn drift detection compare only template-declared resources, so an
out-of-band addition is invisible to them. Decide it like any finding: `record`
snapshots its full live model and watches it, `ignore` accepts it, or `revert`
**deletes** it (Cloud Control `DeleteResource`, behind the usual confirm /
`--dry-run` / picker; an unrecorded one needs `--remove-unrecorded`).

<details>
<summary>Covered parent types (the <code>CHILD_ENUMERATORS</code> registry, growing per type)</summary>

- **API Gateway REST** — resources, methods, authorizers, models, request
  validators, gateway responses
- **API Gateway V2** (HTTP / WebSocket) — routes, integrations, authorizers, stages
- **SNS** — topic subscriptions
- **Lambda** — event source mappings, function URLs, aliases, versions
- **EventBridge** — bus rules
- **Cognito** — user pool clients, groups, resource servers
- **AppSync** — data sources, resolvers, functions
- **CloudWatch Logs** — metric filters, subscription filters
- **ELBv2** — listeners, listener rules
- **EC2** — VPC subnets, route table routes
- **ECS** — cluster services
- **KMS** — key aliases
- **AppConfig** — application environments, configuration profiles
- **EFS** — file system mount targets
- **RDS** — database cluster instances

</details>

Full design and rationale: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Selecting stacks

| invocation            | what is checked                                               |
| --------------------- | ------------------------------------------------------------- |
| `cdkrd check`         | every stack the CDK app defines, each in its own `env.region` |
| `cdkrd check 'Dev*'`  | glob, matched against the app's stack names                   |
| `cdkrd check MyStack` | one stack, selected by name from the app                      |

`cdkrd` is **CDK-only**: it always resolves your CDK app to discover which stacks
exist and to label findings by construct path. The app comes from `cdk.json` (when
run in the project directory) or from `--app`: a command (`--app "node bin/app.js"`)
or a pre-synthesized assembly (`--app cdk.out` — read, not executed); `$CDKRD_APP`
also works. The drift comparison still reads each stack's **deployed** template +
live state from AWS — synth only tells cdkrd which stacks to look at.

## Commands & options

| command                     | does                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| `cdkrd check [<stack>...]`  | compare live state vs template (declared) + baseline (undeclared)      |
| `cdkrd record [<stack>...]` | snapshot undeclared + added state into the baseline (CI: `--yes`)      |
| `cdkrd ignore [<stack>...]` | stop reporting chosen drift via `.cdkrd/config.json` (CI: `--yes`)     |
| `cdkrd revert [<stack>...]` | write the desired value back to AWS (confirms; `--dry-run` to preview) |

Day to day you run only `cdkrd check` and act from its prompt; the standalone
`record` / `ignore` / `revert` are the **same actions** for scripting / non-TTY /
CI (with `--yes`).

### Exit codes

- `check` is **report-only by default** — drift prints but exits `0` (a note names
  the flag).
- **`--fail`** (the `cdk diff --fail` / `cdk drift --fail` convention) exits `1` on
  drift and suppresses all prompts — the one flag for scripts and CI.
- **`--strict`** is the orthogonal **coverage** axis: it exits `1` when a run was
  incomplete (any resource skipped, or a nested stack not recursed into). The gap
  is always surfaced regardless — as the `skipped=N` footer line / a loud
  `warning:` — `--strict` only decides whether it fails the build.
- Errors always exit `2`; `revert` exits `1` when drift remains after it.

```yaml
- run: npm ci # cdkrd resolves the CDK app, so its deps must be installed
- run: npx cdkrd check --fail --region us-east-1 # fails the job on drift
# or point at a prebuilt assembly artifact instead of synthesizing:
# - run: npx cdkrd check --fail --app cdk.out --region us-east-1
```

### Options

| option                     | meaning                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--region <r>`             | AWS region (or `$AWS_REGION` / `$AWS_DEFAULT_REGION`); stacks with explicit `env.region` are auto-detected                                      |
| `--profile <p>`            | AWS profile (or `$AWS_PROFILE`)                                                                                                                 |
| `-a, --app <cmd\|cdk.out>` | CDK app command or pre-synthesized assembly dir (or `$CDKRD_APP` / cdk.json `"app"`) — stack auto-discovery + construct paths                   |
| `-c, --context key=value`  | context for synth (repeatable; cdk.json is the base layer)                                                                                      |
| `--all`                    | target EVERY stack the app defines (the default when no `<stack>` is named; overrides any positional names)                                     |
| `--json`                   | machine-readable output (see [JSON contract](#json-output-contract))                                                                            |
| `--fail`                   | (check) exit 1 on drift + never prompt — for scripts/CI; without it, check reports drift but exits 0                                            |
| `--strict`                 | (check) exit 1 when COVERAGE is incomplete. A coverage gap is always surfaced loudly; `--strict` makes it CI-failing. Orthogonal to `--fail`    |
| `--show-all`               | inventory mode: show ALL current undeclared state, ignoring the baseline                                                                        |
| `--verbose` / `-v`         | (check) expand the `info:` footer tiers / (revert) expand the per-reason NOT-revertable summary — to full lists                                 |
| `--pre-deploy`             | (check) compare live vs the LOCAL synth template — the declared drift your next `cdk deploy` would silently overwrite                           |
| `--undeclared-only`        | (check) undeclared drift only — pair cdkrd with `cdk drift` for the declared side                                                               |
| `--declared-only`          | (check) declared drift vs the DEPLOYED template only (undeclared tier skipped; baseline untouched). Not `--pre-deploy`                          |
| `--dry-run`                | (revert) print the plan; make no changes                                                                                                        |
| `--remove-unrecorded`      | (revert) REMOVE unrecorded values + DELETE unrecorded added resources in a NO-PROMPT run (`--yes`/CI); an interactive revert already lists them |
| `--yes` / `-y`             | skip confirmations (revert apply; record records all without the multiselect)                                                                   |

Unknown options (`--apq`) and options missing their value (`--app` at the end of
the line) are errors (exit `2`) — a typo'd flag never silently becomes a stack name.

### Interactive prompts (TTY only — CI is never prompted)

Every option runs exactly the same code as the standalone commands. Prompts are
skipped under `--json`, `--show-all`, `--pre-deploy`, and `--fail`. A non-TTY run
never prompts: a required write decision without `--yes` errors with exit 2 (the
safe side); `--yes` alone in a TTY auto-approves confirmations only (select prompts
still show).

- **`check` with drift** offers `Record / Revert / Ignore / Decide per finding /
Nothing` (see [Day to day](#day-to-day-act-on-drift)). Each option appears only
  when it applies (no Revert if nothing is revertable; "Decide per finding" only
  with >1 finding). Aborting the Revert confirmation writes nothing.
- **`revert`** shows the plan, then a multiselect of the op(s) to write. **Every op
  starts unselected** — it's the one command that writes to AWS, so you opt in to
  each write. REMOVE ops (deleting a live value not in your template) are labeled
  `(REMOVE)`. **space** toggles · **→** selects all · **←** clears all · **enter**
  confirms. `--yes` applies the full plan.
- **`record`** shows a multiselect of only the **delta** from the existing baseline
  (new + changed values, pre-selected); already-recorded unchanged values are
  auto-kept. Deselect a suspicious one and it stays reported by `check`. Only the
  **standout** values are listed; the folded nested sub-keys (`undeclared-subkey`)
  are **always recorded** and the picker header discloses their count (`--verbose`
  itemizes each). `record` writes only undeclared + added state — any declared /
  deleted drift is NOT written and `record` prints a note that it still stands
  (resolve with `revert` or `cdk deploy`).
- **`Decide per finding`** assigns a different action to each finding. On a busy
  stack, **just start typing to filter** the rows (↑↓ move · space cycles a row's
  actions · → applies the focused action to every visible row · enter applies).
- **Folded inventory** — if `check` folded undeclared values out of the report,
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
=== cdkrd check: ApiStack (us-east-1) ===
[CFn-Declared Drift: 1]
  ApiStack/Api/Handler.MemorySize (AWS::Lambda::Function)
      desired=1024
      actual =2048

result: 1 drift(s) (declared=1)
```

`desired` is what your local code is about to set; `actual` is live now — someone
bumped memory to 2048 out of band. Port it into code (or decide it should go away)
before deploying. As a pipeline gate:

```yaml
- run: npx cdkrd check --pre-deploy --fail # block the deploy on clobber risk
- run: npx cdk deploy --all --require-approval never
```

`--pre-deploy` reports **declared** drift only (the undeclared tier is defined
against the _deployed_ template) and never touches the baseline.

### Ignoring externally-managed properties

Some properties are _legitimately_ rewritten by another system — Application Auto
Scaling moving an ECS Service `DesiredCount`, autoscaled DynamoDB capacity. A
recorded snapshot would re-flag every move. Run **`cdkrd ignore`** to pick the
drift to suppress, or hand-edit the git-committed `.cdkrd/config.json` (strict
JSON — no comments / trailing commas, unknown keys rejected):

```json
{
  "ignore": [
    { "path": "*.DesiredCount" },
    { "path": "Fn*.ReservedConcurrentExecutions", "stack": "Prod*" },
    { "path": "*.DesiredCount", "region": "us-*" }
  ]
}
```

- Every rule is an object `{ "path", "stack"?, "region"? }`. `cdkrd ignore` writes
  the unscoped form — `path` is an exact `<constructPath>.<path>` (or
  `<logicalId>.<path>` on a non-CDK stack); the optional `stack` / `region` scopes
  are a hand-edit.
- All three fields accept the same `*` / `?` glob, and a parent `path` covers child
  paths. **Region is an independent axis** from stack name — the same stack in
  several regions may drift in only one.
- Matching findings move to the informational `ignored` tier — visible under
  `--verbose`, never exit-affecting, excluded from `revert` and `record`. A
  **deleted resource is never ignorable**.

## Output

Two parts: the **drift sections** in full detail, then a one-line `info:` footer
that folds everything informational.

```console
=== cdkrd check: ApiStack (us-east-1) ===
[CFn-Declared Drift: 1]
  ApiStack/UploadBucket.VersioningConfiguration.Status (AWS::S3::Bucket)
      desired="Enabled"
      actual ="Suspended"

result: 1 drift(s) (declared=1)
info:
  - readGap=1 (declared but unverifiable — AWS doesn't return them on read, not drift: 1 write-only)
  - skipped=2 (custom resource 2)
  run with --verbose for the list
```

- **Drift tiers** — `deleted` / `declared` / `undeclared` — are always listed in
  full and drive the `--fail` exit. They are the point.
- **`[Not Recorded: N]`** — undeclared values you haven't recorded yet. Listed in
  full, but not drift; `result:` points you at `cdkrd record`. Once a resource is
  fully snapshotted, a value that _appears_ later is real drift (`appeared since
record`).
- **`info:` footer** folds the informational tiers to per-reason counts
  (`--verbose` expands them):

| tier                                             | what it folds                                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `atDefault`                                      | undeclared values sitting at a known AWS default (a Lambda `TracingConfig: PassThrough`, default Block Public Access). Equality-gated — a change away from the default still surfaces. Applies at any depth. |
| `generated`                                      | undeclared values that are the name/identifier AWS/CDK minted (a topic's auto `TopicName`, a default `LoggingConfig`). Keyed off the physical id; equality-gated; never recorded.                            |
| `nested`                                         | undeclared values living as a sub-key inside a property you _did_ declare (a CloudFront `Origins[<id>]` gaining a `ConnectionTimeout`). `record` records them; `--show-all` lists them.                      |
| `readGap` / `unresolved` / `skipped` / `ignored` | values cdkrd can't confidently compare, reported honestly rather than guessed (never false drift).                                                                                                           |

`^result:` is the greppable verdict. Colorized on a TTY (`NO_COLOR` respected);
piped / CI / `--json` output is plain text.

### JSON output contract

`--json` emits
`{ "stack": "<name> (<region>)", "drifted": <n>, "findings": [...] }`.
Each finding has a stable shape: `tier` (`deleted` | `declared` | `undeclared` |
`readGap` | `unresolved` | `skipped` | `ignored`), `logicalId`, `resourceType`,
`path`, `desired`, `actual`, `note`, `physicalId`, `constructPath`. An unrecorded
value keeps `tier: "undeclared"` and carries `"unrecorded": true`; `drifted`
excludes it. The output always carries every finding regardless of `--verbose`.
After publication this shape is a backward-compatible API.

## IAM permissions

`check` / `record` are **read-only** — the AWS managed `ReadOnlyAccess` policy
covers them. **If you never run `revert`, cdkrd needs no write permissions at all.**

<details>
<summary>Minimal read permissions (check / record)</summary>

- `cloudformation:GetTemplate`, `ListStackResources`, `DescribeStacks`,
  `DescribeType`; `ListExports` (only for templates using `Fn::ImportValue`)
- `cloudcontrol:GetResource` — Cloud Control invokes each type's own read handler,
  so it needs that type's read permissions (this is why `ReadOnlyAccess` is the
  simple answer)
- SDK readers for the Cloud-Control-gap types: `s3:GetBucketPolicy`,
  `sns:GetTopicAttributes`, `sqs:GetQueueAttributes`, `iam:GetRolePolicy`,
  `iam:GetUserPolicy`, `iam:GetGroupPolicy`, `iam:GetPolicy`, `iam:GetPolicyVersion`,
  `lambda:GetPolicy`, `budgets:ViewBudget`, `ec2:DescribeAddresses`,
  `route53:ListResourceRecordSets`, `glue:GetTable`, `logs:DescribeMetricFilters`,
  `scheduler:GetSchedule`
- Optional: `kms:ListAliases` — enables strict verification that a declared
  `alias/aws/*` key was not swapped for a customer-managed key. Without it that case
  is conservatively suppressed AND cdkrd prints a one-line warning per region (the
  swap would otherwise go undetected), so the reduced coverage is never silent.

</details>

<details>
<summary>Additional write permissions (revert)</summary>

`cloudcontrol:UpdateResource` (which resolves to each type's own update
permissions), plus, for the SDK-written types: `s3:PutBucketPolicy` /
`s3:DeleteBucketPolicy`, `sns:SetTopicAttributes`, `sqs:SetQueueAttributes`,
`iam:PutRolePolicy` / `DeleteRolePolicy` / `PutUserPolicy` / `PutGroupPolicy`,
`iam:CreatePolicyVersion` / `DeletePolicyVersion` / `ListPolicyVersions`,
`elasticloadbalancing:ModifyLoadBalancerAttributes` / `ModifyTargetGroupAttributes`.

</details>

## Limitations

`cdkrd` is **fail-closed**: anything it can't confidently compare is reported as
informational, never guessed (zero false drift). The full list of what it does not
do — revert's boundaries, nested stacks, per-type read gaps (Lambda Permission,
IAM ManagedPolicy attachments, AppSync schema), stack-state handling — is in
[docs/limitations.md](docs/limitations.md).

## FAQ

How `cdkrd` differs from `cdk deploy --revert-drift`, why the baseline is a
committed file, why `ignore` rules live in `.cdkrd/config.json`, and more:
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

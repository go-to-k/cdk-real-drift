# cdk-real-drift (`cdkrd`)

[![npm](https://img.shields.io/npm/v/cdk-real-drift)](https://www.npmjs.com/package/cdk-real-drift)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Drift detection for AWS CDK that sees what your template can't, including the
**properties you never declared**. Detect it, record it, or revert it.

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
=== cdkrd check: ApiStack (us-east-1) ===
[CFn-Undeclared Drift: 1] (live-only (not in your CloudFormation template), changed from your .cdkrd baseline — the differentiator)
  ApiStack/ApiRole.Policies (AWS::IAM::Role) — appeared since record = [{"PolicyName":"manual-debug-access", ...}]

result: 1 drift(s) (undeclared=1)
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

```bash
npm install -D cdk-real-drift   # in your CDK project
npx cdkrd check                 # checks every stack your app defines
```

`check` is the only command you run by hand, with nothing to set up first: it
finds drift and offers **Record**, **Revert**, and **Ignore** inline on what it
turns up.

## How to use

### Your first run needs no baseline

The first time you run `check` on a stack, before recording anything:

```console
=== cdkrd check: ApiStack (us-east-1) ===
No baseline yet — live-only values can't be confirmed as drift, but declared drift and out-of-band deletes always can.

[CFn-Declared Drift: 1] (declared in your CloudFormation template — the live value differs)
  ApiStack/Topic.DisplayName (AWS::SNS::Topic)
      desired="prod-alerts"
      actual ="test"

[Potential Drift: 2] (live-only and not yet in your .cdkrd baseline, so cdkrd can't tell whether it's intended or an out-of-band change — Record to accept it, or Revert to remove it)
  ApiStack/Queue.RedrivePolicy (AWS::SQS::Queue) = {"maxReceiveCount":5}
  ApiStack/Role.Policies (AWS::IAM::Role) = [{"PolicyName":"adhoc", ...}]

result: 3 findings — 1 drift (declared=1) + 2 potential drift

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
  real drift. They're only _potential_ because there's no baseline yet.

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
=== cdkrd check: ApiStack (us-east-1) ===
[CFn-Undeclared Drift: 1] (live-only (not in your CloudFormation template), changed from your .cdkrd baseline — the differentiator)
  ApiStack/Role.Policies (AWS::IAM::Role) — changed since record = [{"PolicyName":"adhoc", ...}, {"PolicyName":"manual-debug-access", ...}]

result: 1 drift(s) (undeclared=1)
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
=== cdkrd revert: ApiStack (us-east-1) ===

  ApiStack/ApiRole (AWS::IAM::Role)
    - Policies -> remove (undeclared, not in baseline)

Apply 1 revert op(s) to ApiStack? This WRITES to AWS. · yes
  reverted: ApiStack/ApiRole

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
  validators, gateway responses
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
| `cdkrd check MyStack` | one stack, selected by name from the app                      |

cdkrd resolves your CDK app to discover which stacks exist and to label findings by
construct path. The app comes from `cdk.json` (when run in the project directory) or
from `--app`: a command (`--app "node bin/app.js"`) or a pre-synthesized assembly
(`--app cdk.out`, read not executed); `$CDKRD_APP` also works. The drift
comparison still reads each stack's **deployed** template + live state from AWS;
synth only tells cdkrd which stacks to look at.

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
  incomplete (any resource skipped, or a nested stack not recursed into). The gap
  is always surfaced regardless (as the `skipped=N` footer line or a loud
  `warning:`); `--strict` only decides whether it fails the build.
- Errors always exit `2`; `revert` exits `1` when drift remains after it.

```yaml
- run: npm ci # cdkrd resolves the CDK app, so its deps must be installed
- run: npx cdkrd check --fail --region us-east-1 # fails the job on drift
# or point at a prebuilt assembly artifact instead of synthesizing:
# - run: npx cdkrd check --fail --app cdk.out --region us-east-1
```

### Options

| option                     | meaning                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--region <r>`             | AWS region (or `$AWS_REGION` / `$AWS_DEFAULT_REGION`); else `env.region` per stack, else the `--profile`'s region                                                                          |
| `--profile <p>`            | AWS profile (or `$AWS_PROFILE`)                                                                                                                                                            |
| `-a, --app <cmd\|cdk.out>` | CDK app command or pre-synthesized assembly dir (or `$CDKRD_APP` / cdk.json `"app"`); stack auto-discovery + construct paths                                                               |
| `-c, --context key=value`  | context for synth (repeatable; cdk.json is the base layer)                                                                                                                                 |
| `--all`                    | target every stack the app defines (the default when no `<stack>` is named; overrides any positional names)                                                                                |
| `--json`                   | machine-readable output (see [JSON contract](#json-output-contract))                                                                                                                       |
| `--fail`                   | (check) exit 1 on drift and never prompt; for scripts/CI. Without it, check reports drift but exits 0                                                                                      |
| `--strict`                 | (check) exit 1 when coverage is incomplete. A coverage gap is always surfaced loudly; `--strict` makes it CI-failing. Orthogonal to `--fail`                                               |
| `--show-all`               | inventory mode: show all current undeclared state, ignoring the baseline                                                                                                                   |
| `--verbose` / `-v`         | (check) expand the `info:` footer tiers / (revert) expand the per-reason not-revertable summary to full lists                                                                              |
| `--pre-deploy`             | (check) compare live vs the LOCAL synth template: the declared drift your next `cdk deploy` would silently overwrite                                                                       |
| `--undeclared-only`        | (check) undeclared drift only: pair cdkrd with `cdk drift` for the declared side                                                                                                           |
| `--declared-only`          | (check) declared drift vs the deployed template only (undeclared tier skipped; baseline untouched). Not `--pre-deploy`                                                                     |
| `--dry-run`                | (revert) print the plan; make no changes                                                                                                                                                   |
| `--wait[=DURATION]`        | (revert) on a transient "resource is mid-update" error (e.g. Route53Resolver `RSLVR-00705`) keep retrying until it settles, up to DURATION (default `10m`; e.g. `--wait=5m`, `--wait=90s`) |
| `--remove-unrecorded`      | (revert) REMOVE unrecorded values + DELETE unrecorded added resources in a no-prompt run (`--yes`/CI); an interactive revert already lists them                                            |
| `--yes` / `-y`             | skip confirmations (revert apply; record records all without the multiselect)                                                                                                              |

Unknown options (`--apq`) and options missing their value (`--app` at the end of
the line) are errors (exit `2`): a typo'd flag never silently becomes a stack name.

### Interactive prompts (TTY only, CI is never prompted)

Every option runs exactly the same code as the standalone commands. Prompts are
skipped under `--json`, `--show-all`, `--pre-deploy`, and `--fail`. A non-TTY run
never prompts: a required write decision without `--yes` errors with exit 2 (the
safe side); `--yes` alone in a TTY auto-approves confirmations only (select prompts
still show).

- **`check` with drift** offers `Record / Revert / Ignore / Decide per finding /
Nothing` (see [The model](#the-model-one-verb-you-run-three-it-offers)). Each
  option appears only when it applies (no Revert if nothing is revertable; "Decide per finding" only
  with >1 finding). Aborting the Revert confirmation writes nothing.
- **`revert`** shows the plan, then a multiselect of the op(s) to write. **Every op
  starts unselected**: it's the one command that writes to AWS, so you opt in to
  each write. REMOVE ops (deleting a live value not in your template) are labeled
  `(REMOVE)`. **space** toggles · **→** selects all · **←** clears all · **enter**
  confirms. `--yes` applies the full plan.
- **`record`** shows a multiselect of only the **delta** from the existing baseline
  (new + changed values, pre-selected); already-recorded unchanged values are
  auto-kept. Deselect a suspicious one and it stays reported by `check`. Nested
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
=== cdkrd check: ApiStack (us-east-1) ===
[CFn-Declared Drift: 1]
  ApiStack/Api/Handler.MemorySize (AWS::Lambda::Function)
      desired=1024
      actual =2048

result: 1 drift(s) (declared=1)
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
  writes the unscoped form (and is **comment-preserving and append-only**: it keeps
  your existing comments and layout, and appends new rules at the end — you own the
  order). `path` is an exact `<constructPath>.<path>` (or `<logicalId>.<path>` on a
  non-CDK stack); the optional `stack` / `account` / `region` scopes are a hand-edit.
- All four fields accept the same `*` / `?` glob, and a parent `path` covers child
  paths. The three scope axes — **stack, account, region** — are exactly the
  baseline file's identity axes. **Account** keeps a `stack: "Prod*"` rule from
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
  policy, typically enabled account-wide, not per-resource) — a dim `↳` line names
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

`check` / `record` are **read-only**: the AWS managed `ReadOnlyAccess` policy
covers them. **If you never run `revert`, cdkrd needs no write permissions at all.**

<details>
<summary>Minimal read permissions (check / record)</summary>

- `cloudformation:GetTemplate`, `ListStackResources`, `DescribeStacks`,
  `DescribeType`; `ListExports` (only for templates using `Fn::ImportValue`)
- `cloudcontrol:GetResource`: Cloud Control invokes each type's own read handler,
  so it needs that type's read permissions (this is why `ReadOnlyAccess` is the
  simple answer)
- SDK readers for the Cloud-Control-gap types: `s3:GetBucketPolicy`,
  `sns:GetTopicAttributes`, `sqs:GetQueueAttributes`, `iam:GetRolePolicy`,
  `iam:GetUserPolicy`, `iam:GetGroupPolicy`, `iam:GetPolicy`, `iam:GetPolicyVersion`,
  `lambda:GetPolicy`, `budgets:ViewBudget`, `ec2:DescribeAddresses`,
  `ec2:DescribeLaunchTemplateVersions`, `ec2:DescribeNetworkAcls`,
  `route53:ListResourceRecordSets`,
  `ses:DescribeReceiptRuleSet`, `ses:DescribeReceiptRule`, `ses:ListReceiptFilters`
  (the SES inbound receipt-rule family — `ReceiptRuleSet` / `ReceiptRule` /
  `ReceiptFilter` — has no Cloud Control handlers),
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
  from the member cache cluster), `ecs:DescribeServices` (supplements an
  `AWS::ECS::Service` with its writeOnly `ServiceConnectConfiguration` /
  `VolumeConfigurations`, read from the PRIMARY deployment),
  `elasticache:DescribeUsers` + `memorydb:DescribeUsers` (supplement an
  `AWS::ElastiCache::User` / `AWS::MemoryDB::User` with its writeOnly
  `AccessString` — the Redis/Valkey ACL; an out-of-band permission grant is
  otherwise invisible to the Cloud Control read),
  `redshift-serverless:GetWorkgroup` (supplements an
  `AWS::RedshiftServerless::Workgroup` with its writeOnly `ConfigParameters` /
  `SecurityGroupIds` / `SubnetIds`, which the Cloud Control read returns only
  inside its read-only echo attribute — an out-of-band security-group swap or
  config-parameter change is otherwise invisible),
  `kafka:DescribeConfiguration` + `kafka:DescribeConfigurationRevision`
  (supplement an `AWS::MSK::Configuration` with its writeOnly `ServerProperties`
  Kafka blob — an out-of-band `update-configuration` revision is otherwise
  invisible),
  `servicediscovery:GetNamespace` (reads a Cloud Map
  `HttpNamespace` / `PrivateDnsNamespace` / `PublicDnsNamespace` — incl. the Arn an
  ECS Service Connect namespace `Fn::GetAtt` resolves against)
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

</details>

<details>
<summary>Additional write permissions (revert)</summary>

`cloudcontrol:UpdateResource` (which resolves to each type's own update
permissions), plus, for the SDK-written types: `s3:PutBucketPolicy` /
`s3:DeleteBucketPolicy`, `sns:SetTopicAttributes`, `sqs:SetQueueAttributes`,
`iam:PutRolePolicy` / `DeleteRolePolicy` / `PutUserPolicy` / `PutGroupPolicy`,
`iam:CreatePolicyVersion` / `DeletePolicyVersion` / `ListPolicyVersions`,
`elasticloadbalancing:ModifyLoadBalancerAttributes` / `ModifyTargetGroupAttributes`,
`glue:UpdateTable`, `glue:UpdateConnection` (reverts an `AWS::Glue::Connection` —
the whole `ConnectionInput` is re-supplied; a connection with an inline password
is refused, never overwritten, so the un-read credential is never cleared),
`logs:PutMetricFilter`, `route53:ChangeResourceRecordSets`,
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
Control cannot sub-path patch it).

</details>

## Limitations

`cdkrd` is **fail-closed**: anything it can't confidently compare is reported as
informational, never guessed (zero false drift). For the full list of what it does
not do (revert's boundaries, nested stacks, per-type read gaps, stack-state
handling), see [docs/limitations.md](docs/limitations.md).

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

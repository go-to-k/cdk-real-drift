# cdk-real-drift (`cdkrd`)

Drift detection for AWS CDK — including the **undeclared properties `cdk drift`
can't see**. Detect it, record it, or revert it.

<!-- badges (enable on publish):
[![npm](https://img.shields.io/npm/v/cdk-real-drift)](https://www.npmjs.com/package/cdk-real-drift)
[![CI](https://github.com/go-to-k/cdk-real-drift/actions/workflows/ci.yml/badge.svg)](https://github.com/go-to-k/cdk-real-drift/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
-->

## Why

Someone attaches an extra inline policy to one of your roles from the console.
CloudFormation drift detection only compares properties that **appear in your
template**, so:

```bash
$ npx cdk drift ApiStack
✨  Number of resources with drift: 0
```

`cdkrd` reads the **full** live resource model and subtracts everything
explainable — the same change shows up:

<!-- demo GIF (record on publish):
     cdk drift (clean) -> console change -> cdkrd check finds it -> revert -->

```console
$ npx cdkrd check ApiStack
=== cdkrd check: ApiStack (us-east-1) ===
[UNDECLARED DRIFT: 1] (not declared in your template — the differentiator)
  ApiStack/ApiRole.Policies (AWS::IAM::Role) = [{"PolicyName":"manual-debug-access", ...}]

result: 1 drift(s) (undeclared=1)
```

| Capability                                                          | `cdkrd` | `cdk drift` / CFn drift detection |
| ------------------------------------------------------------------- | :-----: | :-------------------------------: |
| Detect drift on **declared** properties (incl. out-of-band deletes) |   ✅    |                ✅                 |
| Detect drift on **undeclared** properties                           |   ✅    |                ❌                 |
| **Revert** declared drift                                           |   ✅    |  ✅ `cdk deploy --revert-drift`   |
| **Revert** undeclared drift                                         |   ✅    |                ❌                 |
| **Record** drift into a git-committed file, reviewed like any PR    |   ✅    |                ❌                 |

## Quick start

_Not yet on npm — coming with the first public release._

```bash
npm install -D cdk-real-drift   # in your CDK project
npx cdkrd check                 # checks every stack your app defines
```

**First run** — your template never pins every live value (AWS defaults,
generated names), so the report lists the UNRECORDED values (they are not drift —
there is nothing to compare them to yet), then offers to record a baseline:

```console
=== cdkrd check: ApiStack (us-east-1) ===
[UNRECORDED: 2] (not drift — undeclared and not in the baseline yet; record to record)
  ApiStack/Topic.DisplayName (AWS::SNS::Topic) = "test"
  ApiStack/Role.Policies (AWS::IAM::Role) = [{"PolicyName":"adhoc", ...}]

result: CLEAN — 42 unrecorded value(s) await a baseline (2 shown, 40 folded; run cdkrd record)
info:
  - atDefault=40 (undeclared values matching a known AWS default — not drift)
  ...

ApiStack: unrecorded values found — what do you want to do?
  ❯ Nothing (decide later)
    Record — record current state into the baseline
```

The report always prints **first**, so you see the standout values before deciding
(no blind bulk-record). The count is the **complete** undeclared inventory, but
only the handful that **stand out** are listed — AWS defaults, auto-generated
names/identifiers, and nested sub-keys you never touched fold into the `info:`
footer (`atDefault=` / `generated=` / `nested=`, `--show-all` expands them).
Choosing Record opens a checklist (everything pre-selected — Enter to record all,
or deselect what you want to keep visible) and writes
`.cdkrd/ApiStack.<account>.<region>.json` — **a git file, nothing written to
AWS** — commit it; from here on `check` reports CLEAN until reality changes.
(Declared drift is detected from the very first run, baseline or not.)

**Day to day** — someone changes something from the console; the next `check`
reports it and asks right there:

```console
ApiStack: drift found — what do you want to do?
  ❯ Nothing (decide later)
    Record — record current state into the baseline (a git file; nothing written to AWS)
    Revert — write the desired value back to AWS
```

- **Record** records the value in the baseline, so `check` stays CLEAN until it
  changes again (a multiselect lets you record some and keep reporting others).
- **Revert** shows a plan, lets you pick which op(s) to write, confirms, then
  writes the desired values back to AWS:

```console
=== cdkrd revert: ApiStack (us-east-1) ===

  ApiStack/ApiRole (AWS::IAM::Role)
    - Policies -> remove (undeclared, not in baseline)

Apply 1 revert op(s) to ApiStack? This WRITES to AWS. · yes
  reverted: ApiStack/ApiRole

verifying convergence (re-reading 1 resource(s))...
ApiStack: CLEAN after revert.
```

`record` and `revert` also exist as standalone commands; in CI, run
`npx cdkrd check --fail`.

Requirements: Node.js >= 20, AWS credentials via the standard SDK chain
(env vars, `--profile`, SSO).

## How it works

After `check` finds drift, the human decision is binary, and the verbs mirror it:

| verb           | meaning                                                | writes               |
| -------------- | ------------------------------------------------------ | -------------------- |
| `cdkrd check`  | find drift                                             | nothing              |
| `cdkrd record` | "this state is RIGHT" — record it in the baseline file | a git file only      |
| `cdkrd revert` | "this state is WRONG" — write the desired value back   | AWS (plan + confirm) |

- **Declared** properties are compared against the **deployed template** — no
  baseline involved, drift is detected from the first run.
- **Undeclared** properties are compared against a **baseline** you record with
  `record`: a JSON file at `.cdkrd/<stack>.<accountId>.<region>.json`, committed
  to git. A PR that changes it is a visible, reviewable change to "what real
  state we record". Account id and region are part of the filename, so the same
  stack deployed to several accounts never collides (gitignore personal-account
  baselines if you prefer).
- There is **no watch-list to maintain**. Every `check` snapshots the full live
  model (Cloud Control API + SDK readers for the gap types) and subtracts
  everything explainable — schema read-only/write-only/defaults, AWS-managed
  fields, `aws:*` tags, policy-document and ordering noise. What survives is
  signal.
- Anything not confidently comparable is reported honestly as informational
  (`readGap` / `unresolved` / `skipped`) — **never** guessed, so no false drift.
- A resource **deleted out of band** — the most blatant drift there is — is
  reported in the `deleted` tier and always counts as failing drift under
  `--fail`.

`cdkrd` is **reality vs intent**, not code vs template: it deliberately does not
reimplement `cdk diff`, so undeployed code changes never show up as drift
(see [`--pre-deploy`](#commands--options) for the opt-in inversion).

Full design and rationale: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Selecting stacks

| invocation            | what is checked                                               |
| --------------------- | ------------------------------------------------------------- |
| `cdkrd check`         | every stack the CDK app defines, each in its own `env.region` |
| `cdkrd check 'Dev*'`  | glob, matched against the app's stack names                   |
| `cdkrd check MyStack` | one stack, selected by name from the app                      |

`cdkrd` is **CDK-only**: it always resolves your CDK app to discover which
stacks exist and to label findings by construct path. The app comes from
`cdk.json` when you run in the project directory, or from `--app`: a command
(`--app "node bin/app.js"`) or a pre-synthesized assembly (`--app cdk.out` —
read, not executed); `$CDKRD_APP` also works. The drift comparison itself still
reads each stack's **deployed** template + live state from AWS — synth only
tells cdkrd which stacks to look at.

## Commands & options

| command                     | does                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| `cdkrd check [<stack>...]`  | compare live state vs template (declared) + baseline (undeclared)      |
| `cdkrd record [<stack>...]` | snapshot undeclared state into the baseline (CI / non-TTY: `--yes`)    |
| `cdkrd revert [<stack>...]` | write the desired value back to AWS (confirms; `--dry-run` to preview) |

**Exit codes:** `check` is **report-only by default** — drift prints but exits
`0` (a note names the flag). Pass **`--fail`** (the `cdk diff --fail` /
`cdk drift --fail` convention) to exit `1` on drift and suppress all prompts —
the one flag for scripts and CI. Errors always exit `2`; `revert` exits `1`
when drift remains after it.

```yaml
- run: npm ci # cdkrd resolves the CDK app, so its deps must be installed
- run: npx cdkrd check --fail --region us-east-1 # fails the job on drift
# or point at a prebuilt assembly artifact instead of synthesizing:
# - run: npx cdkrd check --fail --app cdk.out --region us-east-1
```

| option                     | meaning                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--region <r>`             | AWS region (or `$AWS_REGION` / `$AWS_DEFAULT_REGION`); CDK stacks with explicit `env.region` are auto-detected                |
| `--profile <p>`            | AWS profile (or `$AWS_PROFILE`)                                                                                               |
| `-a, --app <cmd\|cdk.out>` | CDK app command or pre-synthesized assembly dir (or `$CDKRD_APP` / cdk.json `"app"`) — stack auto-discovery + construct paths |
| `-c, --context key=value`  | context for synth (repeatable; cdk.json is the base layer)                                                                    |
| `--json`                   | machine-readable output (see [JSON contract](#json-output-contract))                                                          |
| `--fail`                   | (check) exit 1 on drift + never prompt — for scripts/CI; without it, check reports drift but exits 0                          |
| `--show-all`               | inventory mode: show ALL current undeclared state, ignoring the baseline                                                      |
| `--verbose` / `-v`         | (check) expand informational tiers from the `info:` footer / (revert) the per-reason NOT-revertable summary — to full lists   |
| `--pre-deploy`             | (check) compare live vs the LOCAL synth template — the declared drift your next `cdk deploy` would silently overwrite         |
| `--undeclared-only`        | (check) undeclared drift only — pair cdkrd with `cdk drift` / CFn drift detection for the declared side                       |
| `--declared-only`          | (check) declared drift vs the DEPLOYED template only (undeclared tier skipped; baseline untouched). Not `--pre-deploy`        |
| `--dry-run`                | (revert) print the plan; make no changes                                                                                      |
| `--remove-unrecorded`      | (revert) REMOVE unrecorded values in a NO-PROMPT run (`--yes`/CI); an interactive revert already lists them as opt-in REMOVE  |
| `--yes` / `-y`             | skip confirmations (revert apply; record records all without the multiselect)                                                 |

Unknown options (`--apq`) and options missing their value (`--app` at the end of
the line) are errors (exit `2`) — a typo'd flag never silently becomes a stack name.

### Interactive prompts (TTY only — CI is never prompted)

- **`check` with drift** offers `Nothing / Record / Revert` inline (shown above).
  `Nothing` is the default; Enter keeps plain-check behavior. Record and Revert
  run exactly the same code as the standalone commands. Skipped under `--json`,
  `--show-all`, `--pre-deploy`, and `--fail`. Aborting the Revert confirmation
  writes nothing — the drift still stands and stays reported.
- **`revert`** shows the plan, then a multiselect of the op(s) to write:
  RESTORE ops (template / baseline values) are pre-selected, while REMOVE ops
  (deleting a live value not in your template — a standout `[UNRECORDED]` value, or
  one not in the baseline) start **unselected** and are labeled `(REMOVE)` —
  removal is an explicit per-item choice (R113: no `--remove-unrecorded` needed in a
  prompt, since the unselected row IS the consent). In the multiselect, **space**
  toggles the row, **→** selects all, **←** clears all, **enter** confirms. A final
  confirm states exactly how many selected op(s) will be written. `--yes`
  skips both and applies the full plan.
- **`record`** shows a multiselect of only the **delta** from the existing
  baseline (new + changed undeclared values, all pre-selected); already-recorded
  unchanged values are auto-kept and surfaced with a
  `keeping N already-recorded unchanged value(s)` note. Deselect a suspicious one
  and it stays reported by `check` — record the intentional changes without
  rubber-stamping the rest. With no baseline yet, the full set is shown.
  `record` records **undeclared** state only — it does not "approve everything".
  Any **declared / deleted** drift (divergence from your template intent) is NOT
  written to the baseline and cannot be silenced by it; `record` prints a note
  that it still stands, to be resolved with `revert` or `cdk deploy`.
- **`check` with no baseline yet** asks what to do with the N undeclared values
  it found: **record ALL of them** into the baseline (the default — the common
  first-run choice; it writes only a git-tracked file, nothing to AWS), or
  **show them first** (the report prints, and a selective record is offered
  right after it). With zero undeclared values there is nothing to decide, so
  no prompt. After an interactive record, a closing note states what remains:
  a PARTIAL record is a success — unselected values simply stay reported as
  UNRECORDED from the next `check` on (recording one value never flips the
  rest into drift) — and any remaining declared/deleted drift is named —
  record cannot address it (fix the code or choose Revert).
- A non-TTY run (CI, cron, pipes) never prompts: required write **decisions**
  without `--yes` error with exit 2 (the safe side). `--yes` alone in a TTY
  auto-approves confirmations only (select prompts still show).

### Catching what your next deploy would overwrite (`--pre-deploy`)

Normal `check` asks "did reality drift from what I deployed?". `--pre-deploy`
asks the inverse, **right before a deploy**: "which LIVE values would my local
code overwrite?" It compares live state against your **local synth** template
(instead of the deployed one), so a console hot-fix someone made during an
incident shows up before `cdk deploy` silently reverts it:

```console
$ npx cdkrd check --pre-deploy
(--pre-deploy) comparing live state against the LOCAL synth template
=== cdkrd check: ApiStack (us-east-1) ===
[DECLARED DRIFT: 1]
  ApiStack/Api/Handler.MemorySize (AWS::Lambda::Function)
      desired=1024
      actual =2048

result: 1 drift(s) (declared=1)
```

Here `desired` is what your local code is about to set; `actual` is live right
now — someone bumped the memory to 2048 out of band. Deploying without porting
that into code would silently undo it: port it (or decide it should go away),
then deploy. As a pipeline gate, run it right before the deploy step:

```yaml
- run: npx cdkrd check --pre-deploy --fail # block the deploy on clobber risk
- run: npx cdk deploy --all --require-approval never
```

`--pre-deploy` reports **declared** drift only (the undeclared tier is defined
against the _deployed_ template, so it is excluded here) and never touches the
baseline.

### Ignoring externally-managed properties

Some properties are _legitimately_ rewritten by another system — Application
Auto Scaling moving an ECS Service `DesiredCount`, autoscaled DynamoDB capacity.
An recorded snapshot would re-flag every move. List those paths in a git-committed
`.cdkrd/config.json` instead (strict JSON — no comments or trailing commas, and
unknown keys are rejected so a typo can't silently disable your rules):

```json
{
  "ignore": ["*.DesiredCount", "Prod*:Fn*.ReservedConcurrentExecutions"]
}
```

Rules glob (`*` / `?`) against either `<logicalId>.<path>` or the friendly
`<constructPath>.<path>` (e.g. `MyStack/ApiRole.Policies`); prefix with
`<stack glob>:` to scope to matching stacks; a parent rule covers child paths.
Matching findings move to the informational `ignored` tier — still visible under
`--verbose`, never exit-affecting, and excluded from `revert` plans and `record`.
A **deleted resource is never ignorable**.

## Output

Two parts: the **drift sections** in full detail, then a one-line `info:` footer
that folds everything informational.

- **Drift tiers** — `deleted` / `declared` / `undeclared` — are always listed in
  full and drive the `--fail` exit. They are the point.
- **`[UNRECORDED: N]`** — undeclared values you have not recorded yet. Listed in
  full, but not drift (there is nothing to compare them to): they never fail the
  build, and `result:` points you at `cdkrd record`. Once a resource is fully
  snapshotted, a value that _appears_ later is real drift (`appeared since record`).
- **`info:` footer** folds the informational tiers to per-reason counts
  (`--verbose` expands them):
  - **`atDefault`** — undeclared values sitting at a known AWS default (a Lambda's
    `TracingConfig: PassThrough`, a bucket's default Block Public Access). The bulk
    of a first run, folded to a count so the body shows only what actually
    diverges. Equality-gated: a change away from the default still surfaces, and
    `--show-all` lists them. Applies at **any depth** — a value nested inside a
    declared property that equals the schema's `default` for that path folds here
    too (so config-dense types like CloudFront, whose schema annotates dozens of
    nested defaults, don't drown the report in `nested` inventory).
  - **`generated`** — undeclared values that are the **name or identifier AWS/CDK
    minted for the resource**, not anything you set: a topic's auto-generated
    `TopicName`, a Lambda's default `LoggingConfig` whose `LogGroup` is named after
    the generated function name. Keyed off the resource's physical id, so they
    appear on every first run yet you never chose (and often cannot edit) them.
    Folded to a count like `atDefault`, equality-gated against the physical-id
    template (change one out of band — say a `LogFormat: JSON` — and it re-surfaces
    as real undeclared drift); never recorded by `record`. `--verbose` lists them.
  - **`nested`** — undeclared values that live as a **sub-key inside a property
    you _did_ declare** (e.g. you set a cache behavior but never its
    `SmoothStreaming`, which AWS materializes underneath) — including inside the
    elements of an identity-keyed array you declared (a CloudFront `Origins[<id>]`
    gaining a `ConnectionTimeout`, a DynamoDB GSI gaining `WarmThroughput`). The
    live model carries many of these, so they fold to a count; `record` records
    them like any undeclared value (so a later out-of-band change to one surfaces),
    and `--show-all` / `--verbose` list them.
  - **`readGap` / `unresolved` / `skipped` / `ignored`** — values cdkrd can't
    confidently compare, reported honestly rather than guessed (never false drift).

`^result:` is the greppable verdict; `--json` is the formal machine contract.
Colorized on a TTY (`NO_COLOR` respected); piped / CI / `--json` output is plain
text.

```console
=== cdkrd check: ApiStack (us-east-1) ===
[DECLARED DRIFT: 1]
  ApiStack/UploadBucket.VersioningConfiguration.Status (AWS::S3::Bucket)
      desired="Enabled"
      actual ="Suspended"

result: 1 drift(s) (declared=1)
info:
  - readGap=1 (declared but unverifiable — AWS doesn't return them on read, not drift: 1 write-only)
  - skipped=2 (custom resource 2)
  run with --verbose for the list
```

### JSON output contract

`--json` emits
`{ "stack": "<name> (<region>)", "drifted": <n>, "findings": [...] }`.
Each finding has a stable shape: `tier` (`deleted` | `declared` | `undeclared` |
`readGap` | `unresolved` | `skipped` | `ignored`), `logicalId`, `resourceType`,
`path`, `desired`, `actual`, `note`, `physicalId`, `constructPath`. An
unrecorded value keeps `tier: "undeclared"` and carries `"unrecorded": true`;
`drifted` excludes it. The output always carries every finding regardless of
`--verbose`. After publication this shape is treated as a backward-compatible
API.

## IAM permissions

`check` / `record` are **read-only**. The AWS managed `ReadOnlyAccess` policy
covers them. If you scope tighter, the calls are:

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
  `alias/aws/*` key was not swapped for a customer-managed key. Without it that
  case is conservatively suppressed AND cdkrd prints a one-line warning per region
  (the swap would otherwise go undetected), so the reduced coverage is never silent

</details>

`revert` additionally needs write access to the resources you revert:
`cloudcontrol:UpdateResource` (which resolves to each type's own update permissions),
plus, for the SDK-written types: `s3:PutBucketPolicy` / `s3:DeleteBucketPolicy`,
`sns:SetTopicAttributes`, `sqs:SetQueueAttributes`, `iam:PutRolePolicy` /
`DeleteRolePolicy` / `PutUserPolicy` / `PutGroupPolicy`,
`iam:CreatePolicyVersion` / `DeletePolicyVersion` / `ListPolicyVersions`,
`elasticloadbalancing:ModifyLoadBalancerAttributes` /
`ModifyTargetGroupAttributes`.

**If you never run `revert`, cdkrd needs no write permissions at all.**

## Limitations

- **Fail-closed by design.** A property `cdkrd` cannot confidently compare (an
  exotic intrinsic, a write-only value, a Cloud-Control-unreadable type) is
  reported as informational, never guessed. You trade a little coverage for zero
  false drift.
- **Revert cannot do everything.** Not revertable, and reported as such:
  - **UNRECORDED values** (never recorded — including everything undeclared on
    a stack with no baseline yet) — there is no recorded state to write back,
    so `revert` refuses: record them if the live values are right, or opt into
    removal with `--remove-unrecorded`;
  - a `deleted` resource (recreate it with `cdk deploy`);
  - **nested undeclared values** (a sub-key inside a property you declared, incl.
    inside an identity-keyed array element) — detect/record-only: a flat patch
    can't safely target a deep sub-field, so fix any real divergence in your IaC
    or re-record the live value;
  - **create-only** properties (changing them requires resource replacement);
  - toggle-style properties with no "absent" state (e.g. S3 transfer acceleration
    is only `Enabled`/`Suspended`);
  - `AWS::Lambda::Permission` and `AWS::Budgets::Budget` (their write APIs cannot
    safely reconstruct the desired state from what is readable).

  Not-revertable findings fold into a one-line-per-reason summary (`--verbose`
  for the full list). When findings exist but **nothing** is revertable, `revert`
  prints a `nothing revertable — ... remain.` summary (drift and unrecorded
  values counted separately) and exits 1 (they still stand); exit 0 means there
  was no drift to revert at all.

- **Revert writes the canonical form** of the desired value — semantically equal
  to your template, but statement/tag ordering or scalar-vs-array may differ
  textually.
- **Custom resources** (`Custom::*`) have no cloud-side model and are always
  `skipped` (without an API call).
- **Lambda Permission:** if only the specific statement was removed out of band
  (while the function's policy still exists), it is reported as `skipped`, not
  `deleted` — identifying the exact statement would need its `StatementId`.

## FAQ

**How is this different from `cdk deploy --revert-drift`?**
Two axes. **Coverage:** `--revert-drift` (aws-cdk ≥ v2.1110.0) is built on
CloudFormation drift detection, so it only sees properties in your template —
undeclared drift is invisible to it, and is exactly what `cdkrd` exists to
catch. **Mechanism:** `--revert-drift` reconciles to the **synth** template as
part of a `cdk deploy`, so any pending local code changes ship in the same
operation. `cdkrd revert` is drift-only and per-finding: it reverts to the
**deployed** template / baseline (never your un-deployed code), touches just the
divergence, and previews with `--dry-run`.

**Why a committed baseline file — isn't the CloudFormation schema enough?**
A stateless schema comparison gives each property only two modes: report forever
(noise) or ignore forever (blind). The baseline adds the third one drift
detection actually needs: _this value is OK — alarm only when it changes_.
Example: account-level "EBS encryption by default" makes every volume
`Encrypted: true`. The schema is no help — it declares no default for
`Encrypted` at all, like ~99% of CloudFormation properties — so without a
recorded value the only choices are "report `true` forever" or "ignore the
property forever". The baseline pins `true` and alarms only when it changes.
Full rationale (with measurements):
[docs/why-a-baseline-file.md](docs/why-a-baseline-file.md).

**How can `cdkrd` catch a change to a property that is in neither my template
nor the baseline?**
The baseline is not a watch-list. Every `check` reads the _full_ live model,
then subtracts template + schema + baseline. A property that newly appears (or
changes) with a meaningful value survives the subtraction and is reported.
Why neither the schema nor `.cdkrd/config.json` can play the baseline's role is
covered in [docs/why-a-baseline-file.md](docs/why-a-baseline-file.md).

**Why doesn't `--show-all` list a feature that is explicitly OFF?**
Undeclared values that are `false`/empty are suppressed — AWS returns an
"off/empty" value for nearly every unset option, and keeping them would flood
the output. The case that matters is still caught: an recorded value that later
flips to `false`/empty out of band is reported via baseline removal-detection.

**A property keeps drifting because an autoscaler manages it — do I have to
re-record forever?**
No — list it in `.cdkrd/config.json`
(see [Ignoring externally-managed properties](#ignoring-externally-managed-properties)).

**Is it safe to run in CI / on production accounts?**
`check` and `record` make read-only AWS calls (plus a local baseline file write
for `record`). `revert` is the only mutating command; it never runs without
`--yes` or an interactive confirmation, and `--dry-run` shows the plan without
changes.

## Contributing

```bash
pnpm install
vp run test         # unit tests        vp run typecheck
vp run check        # lint + format     vp run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Integration tests (real AWS, self-cleaning)
live under [tests/integration/](tests/integration/README.md). Design rationale:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [DESIGN.md](DESIGN.md).

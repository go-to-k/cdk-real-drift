# cdk-real-drift (`cdkrd`)

Drift detection for AWS CDK — including the **undeclared properties `cdk drift`
can't see**. Detect it, accept it, or revert it.

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

[UNDECLARED DRIFT (the differentiator)] 1
  ApiStack/ApiRole.Policies (AWS::IAM::Role) = [{"PolicyName":"manual-debug-access", ...}]
result: 1 drift(s) (undeclared=1)
```

| Capability                                                          | `cdkrd` | `cdk drift` / CFn drift detection |
| ------------------------------------------------------------------- | :-----: | :-------------------------------: |
| Detect drift on **declared** properties (incl. out-of-band deletes) |   ✅    |                ✅                 |
| Detect drift on **undeclared** properties                           |   ✅    |                ❌                 |
| **Revert** declared drift                                           |   ✅    |  ✅ `cdk deploy --revert-drift`   |
| **Revert** undeclared drift                                         |   ✅    |                ❌                 |
| **Accept** drift into a git-committed file, reviewed like any PR    |   ✅    |                ❌                 |

## Quick start

_Not yet on npm — coming with the first public release._

```bash
npm install -D cdk-real-drift   # in your CDK project
npx cdkrd check                 # checks every stack your app defines
```

`check` is the only command you run day to day. When it finds drift in a
terminal, it asks what to do right there:

```console
ApiStack: drift found — what do you want to do?
  ❯ Nothing (keep exit code 1)
    Accept — bless current state into the baseline (a git file; nothing written to AWS)
    Revert — write the desired value back to AWS
```

- **Accept** records the value in a git-committed baseline, so `check` stays
  CLEAN until it changes again (a multiselect lets you bless some and keep
  reporting others).
- **Revert** shows a plan, confirms, then writes the desired value back to AWS:

```console
=== cdkrd revert: ApiStack (us-east-1) ===

  ApiStack/ApiRole (AWS::IAM::Role)
    - Policies -> remove (undeclared, not in baseline)

Apply 1 revert op(s) to ApiStack? This WRITES to AWS. · yes
  reverted: ApiStack/ApiRole
ApiStack: CLEAN after revert.
```

**Declared drift is detected from the very first `check`** — the deployed
template is the reference, no setup needed. `accept` and `revert` also exist as
standalone commands for CI / scripting.

Requirements: Node.js >= 20, AWS credentials via the standard SDK chain
(env vars, `--profile`, SSO).

## How it works

After `check` finds drift, the human decision is binary, and the verbs mirror it:

| verb           | meaning                                                 | writes               |
| -------------- | ------------------------------------------------------- | -------------------- |
| `cdkrd check`  | find drift                                              | nothing              |
| `cdkrd accept` | "this state is RIGHT" — bless it into the baseline file | a git file only      |
| `cdkrd revert` | "this state is WRONG" — write the desired value back    | AWS (plan + confirm) |

- **Declared** properties are compared against the **deployed template** — no
  baseline involved, drift is detected from the first run.
- **Undeclared** properties are compared against a **baseline** you bless with
  `accept`: a JSON file at `.cdkrd/<stack>.<accountId>.<region>.json`, committed
  to git. A PR that changes it is a visible, reviewable change to "what real
  state we accept". Account id and region are part of the filename, so the same
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
  reported in the `deleted` tier and always sets exit 1, regardless of
  `--fail-on`.

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
| `cdkrd accept [<stack>...]` | snapshot undeclared state into the baseline (CI / non-TTY: `--yes`)    |
| `cdkrd revert [<stack>...]` | write the desired value back to AWS (confirms; `--dry-run` to preview) |

**Exit codes:** `0` clean · `1` drift · `2` error — so `check` drops straight
into CI:

```yaml
- run: npm ci # cdkrd resolves the CDK app, so its deps must be installed
- run: npx cdkrd check --region us-east-1 # fails the job on drift
# or point at a prebuilt assembly artifact instead of synthesizing:
# - run: npx cdkrd check --app cdk.out --region us-east-1
```

| option                           | meaning                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--region <r>`                   | AWS region (or `$AWS_REGION` / `$AWS_DEFAULT_REGION`); CDK stacks with explicit `env.region` are auto-detected                |
| `--profile <p>`                  | AWS profile (or `$AWS_PROFILE`)                                                                                               |
| `-a, --app <cmd\|cdk.out>`       | CDK app command or pre-synthesized assembly dir (or `$CDKRD_APP` / cdk.json `"app"`) — stack auto-discovery + construct paths |
| `-c, --context key=value`        | context for synth (repeatable; cdk.json is the base layer)                                                                    |
| `--json`                         | machine-readable output (see [JSON contract](#json-output-contract))                                                          |
| `--fail-on declared\|undeclared` | which tier sets exit 1 (default `undeclared` = both; `deleted` always fails)                                                  |
| `--show-all`                     | inventory mode: show ALL current undeclared state, ignoring the baseline                                                      |
| `--verbose` / `-v`               | (check) expand informational tiers from the `info:` footer / (revert) the per-reason NOT-revertable summary — to full lists   |
| `--pre-deploy`                   | (check) compare live vs the LOCAL synth template — the declared drift your next `cdk deploy` would silently overwrite         |
| `--dry-run`                      | (revert) print the plan; make no changes                                                                                      |
| `--remove-unblessed`             | (revert) on a stack with NO baseline, REMOVE undeclared drift (default: refuse — run `accept` first)                          |
| `--yes` / `-y`                   | skip confirmations (revert apply; accept blesses all without the multiselect)                                                 |
| `--no-interactive`               | never prompt: optional prompts are skipped, required-decision prompts error (exit 2). `accept` then needs `--yes` to bless    |

Unknown options (`--apq`) and options missing their value (`--app` at the end of
the line) are errors (exit `2`) — a typo'd flag never silently becomes a stack name.

### Interactive prompts (TTY only — CI is never prompted)

- **`check` with drift** offers `Nothing / Accept / Revert` inline (shown above).
  `Nothing` is the default; Enter keeps plain-check behavior. Accept and Revert
  run exactly the same code as the standalone commands. Skipped under `--json`,
  `--show-all`, and `--pre-deploy`. Aborting the Revert confirmation keeps the
  exit code at 1 — nothing was written, the drift still stands.
- **`accept`** shows a multiselect of only the **delta** from the existing
  baseline (new + changed undeclared values, all pre-selected); already-blessed
  unchanged values are auto-kept and surfaced with a
  `keeping N already-blessed unchanged value(s)` note. Deselect a suspicious one
  and it stays reported by `check` — bless the intentional changes without
  rubber-stamping the rest. With no baseline yet, the full set is shown.
- **`check` with no baseline yet** offers to bless the current state on the spot.
- Flag combinations: `--no-interactive` alone = the read side completes but
  write **decisions** are refused with exit 2 (the safe side);
  `--no-interactive --yes` = full automation; `--yes` alone in a TTY
  auto-approves confirmations only (select prompts still show).

### Ignoring externally-managed properties

Some properties are _legitimately_ rewritten by another system — Application
Auto Scaling moving an ECS Service `DesiredCount`, autoscaled DynamoDB capacity.
A blessed snapshot would re-flag every move. List those paths in a git-committed
`.cdkrd/config.json` instead (strict JSON — no comments or trailing commas):

```json
{
  "ignore": ["*.DesiredCount", "Prod*:Fn*.ReservedConcurrentExecutions"]
}
```

Rules glob (`*` / `?`) against either `<logicalId>.<path>` or the friendly
`<constructPath>.<path>` (e.g. `MyStack/ApiRole.Policies`); prefix with
`<stack glob>:` to scope to matching stacks; a parent rule covers child paths.
Matching findings move to the informational `ignored` tier — still visible under
`--verbose`, never exit-affecting, and excluded from `revert` plans and `accept`.
A **deleted resource is never ignorable**.

## Output

Drift tiers (`deleted` / `declared` / `undeclared`) are always printed in full —
they are the point. Informational tiers (`readGap` / `unresolved` / `skipped` /
`ignored`) fold into an `info:` footer with per-reason counts; `--verbose`
expands them to full lists. Greppable: `^result:` is the verdict; for machine
consumption the formal contract is `--json`.

```console
=== cdkrd check: ApiStack (us-east-1) ===

[DECLARED DRIFT] 1
  ApiStack/UploadBucket.VersioningConfiguration.Status (AWS::S3::Bucket)
      desired="Enabled"
      actual ="Suspended"
result: 1 drift(s) (declared=1)
info:
  - readGap=1 (write-only 1)
  - skipped=2 (custom resource 2)
  run with --verbose for the list
```

### JSON output contract

`--json` emits
`{ "stack": "<name> (<region>)", "drifted": <n>, "findings": [...] }`.
Each finding has a stable shape: `tier` (`deleted` | `declared` | `undeclared` |
`readGap` | `unresolved` | `skipped` | `ignored`), `logicalId`, `resourceType`,
`path`, `desired`, `actual`, `note`, `physicalId`, `constructPath`. It always
carries every finding regardless of `--verbose`. After publication this shape is
treated as a backward-compatible API.

## IAM permissions

`check` / `accept` are **read-only**. The AWS managed `ReadOnlyAccess` policy
covers them. If you scope tighter, the calls are:

<details>
<summary>Minimal read permissions (check / accept)</summary>

- `cloudformation:GetTemplate`, `ListStackResources`, `DescribeStacks`,
  `DescribeType`; `ListExports` (only for templates using `Fn::ImportValue`)
- `cloudcontrol:GetResource` — Cloud Control invokes each type's own read handler,
  so it needs that type's read permissions (this is why `ReadOnlyAccess` is the
  simple answer)
- SDK readers for the Cloud-Control-gap types: `s3:GetBucketPolicy`,
  `sns:GetTopicAttributes`, `sqs:GetQueueAttributes`, `iam:GetRolePolicy`,
  `iam:GetUserPolicy`, `iam:GetGroupPolicy`, `iam:GetPolicy`, `iam:GetPolicyVersion`,
  `lambda:GetPolicy`, `budgets:ViewBudget`, `ec2:DescribeAddresses`,
  `route53:ListResourceRecordSets`, `glue:GetTable`, `logs:DescribeMetricFilters`
- Optional: `kms:ListAliases` — enables strict verification that a declared
  `alias/aws/*` key was not swapped for a customer-managed key (without it, that
  case is conservatively suppressed)

</details>

`revert` additionally needs write access to the resources you revert:
`cloudcontrol:UpdateResource` (which resolves to each type's own update permissions),
plus, for the SDK-written types: `s3:PutBucketPolicy` / `s3:DeleteBucketPolicy`,
`sns:SetTopicAttributes`, `sqs:SetQueueAttributes`, `iam:PutRolePolicy` /
`PutUserPolicy` / `PutGroupPolicy`, `iam:CreatePolicyVersion` /
`DeletePolicyVersion` / `ListPolicyVersions`.

**If you never run `revert`, cdkrd needs no write permissions at all.**

## Limitations

- **Fail-closed by design.** A property `cdkrd` cannot confidently compare (an
  exotic intrinsic, a write-only value, a Cloud-Control-unreadable type) is
  reported as informational, never guessed. You trade a little coverage for zero
  false drift.
- **Revert cannot do everything.** Not revertable, and reported as such:
  - **undeclared drift on a stack with NO baseline** — there is no blessed value
    to write back, so `revert` refuses (run `accept` first, or opt into removal
    with `--remove-unblessed`);
  - a `deleted` resource (recreate it with `cdk deploy`);
  - **create-only** properties (changing them requires resource replacement);
  - toggle-style properties with no "absent" state (e.g. S3 transfer acceleration
    is only `Enabled`/`Suspended`);
  - `AWS::Lambda::Permission` and `AWS::Budgets::Budget` (their write APIs cannot
    safely reconstruct the desired state from what is readable).

  Not-revertable findings fold into a one-line-per-reason summary (`--verbose`
  for the full list). When drift exists but **nothing** is revertable, `revert`
  prints `nothing revertable — N drift(s) remain.` and exits 1 (the drift still
  stands); exit 0 means there was no drift to revert at all.

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
`Encrypted: true` while the schema default is `false` — the baseline pins `true`
and alarms only on `false`.

**How can `cdkrd` catch a change to a property that is in neither my template
nor the baseline?**
The baseline is not a watch-list. Every `check` reads the _full_ live model,
then subtracts template + schema + baseline. A property that newly appears (or
changes) with a meaningful value survives the subtraction and is reported.

**Why doesn't `--show-all` list a feature that is explicitly OFF?**
Undeclared values that are `false`/empty are suppressed — AWS returns an
"off/empty" value for nearly every unset option, and keeping them would flood
the output. The case that matters is still caught: a blessed value that later
flips to `false`/empty out of band is reported via baseline removal-detection.

**A property keeps drifting because an autoscaler manages it — do I have to
re-accept forever?**
No — list it in `.cdkrd/config.json`
(see [Ignoring externally-managed properties](#ignoring-externally-managed-properties)).

**Is it safe to run in CI / on production accounts?**
`check` and `accept` make read-only AWS calls (plus a local baseline file write
for `accept`). `revert` is the only mutating command; it never runs without
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

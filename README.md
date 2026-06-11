# cdk-real-drift (`cdkrd`)

> Drift detection for AWS CDK / CloudFormation that sees what other tools can't:
> **changes to properties you never declared in your template.**
> Detect it, accept it, or revert it — no AWS Config required.

<!-- badges (enable on publish):
[![npm](https://img.shields.io/npm/v/cdk-real-drift)](https://www.npmjs.com/package/cdk-real-drift)
[![CI](https://github.com/go-to-k/cdk-real-drift/actions/workflows/ci.yml/badge.svg)](https://github.com/go-to-k/cdk-real-drift/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
-->

**Status:** pre-release. `check` and `accept` never write to AWS.
`revert` is the only mutating command, and it always shows a plan and confirms first.

## The problem

Someone opens the console and attaches an extra inline policy to one of your roles:

```bash
$ npx cdk drift ApiStack
✨  Number of resources with drift: 0
```

Nothing. CloudFormation drift detection — and every tool built on it — only compares
properties that **appear in your template**. An inline policy you never declared, a
`PermissionsBoundary`, a bucket's `OwnershipControls`, encryption toggled off: all
invisible. The most dangerous drift hides in the properties you never wrote down.

`cdkrd` reads the **full** live model of every resource and subtracts what is
explainable, so the same change looks like this:

<!-- demo GIF (record on publish): cdk drift (clean) -> console change -> cdkrd check finds it -> revert -->

```console
$ npx cdkrd check ApiStack

=== cdkrd check: ApiStack (us-east-1) ===

[UNDECLARED DRIFT (the differentiator)] 1
  ApiStack/ApiRole.Policies (AWS::IAM::Role) = [{"PolicyName":"manual-debug-access","PolicyDocument":{"Statement":[{"Action":["s3:*"],"Effect":"Allow","Resource":["*"]}]}}]

result: 1 drift(s) (undeclared=1)
info: skipped=1 (custom resource 1) — run with --verbose for the list

ApiStack: drift found — what do you want to do?
  ❯ Nothing (keep exit code 1)
    Accept — bless current state into the baseline
    Revert — write the desired values back to AWS
```

Pick **Revert** and the policy is removed; pick **Accept** and the value is recorded
in a git-committed baseline so it never shows up again — until it changes.

## How it compares

| Capability                               | `cdkrd` | `cdk drift` / CFn drift detection | `driftctl`¹ | AWS Config |
| ---------------------------------------- | :-----: | :-------------------------------: | :---------: | :--------: |
| Drift on **declared** properties         |   ✅    |                ✅                 |     ✅      |    ⚠️²     |
| Drift on **undeclared** properties       |   ✅    |                ❌                 |     ❌      |    ⚠️²     |
| Out-of-band **deletion**                 |   ✅    |                ✅                 |     ✅      |     ✅     |
| **Revert** drift from the CLI            |   ✅    |                ❌                 |     ❌      |     ❌     |
| Git-reviewable "accepted state" baseline |   ✅    |                ❌                 |     ❌      |     ❌     |
| No extra AWS service to enable / pay for |   ✅    |                ✅                 |     ✅      |     ❌     |

¹ Terraform ecosystem (not CDK/CFn); in maintenance mode.
² Config records configuration changes, but has no notion of your IaC intent — it
cannot tell you "this differs from my template/baseline" out of the box.

`cdkrd` is **reality vs intent**, not code vs template: it deliberately does not
reimplement `cdk diff`. Undeployed code changes never show up as drift
(see [`--pre-deploy`](#commands--options) for the opt-in inversion).

## How it works

Three verbs. After `check` finds drift, the human decision is binary, and the verbs
mirror it:

| verb           | meaning                                                 | writes               |
| -------------- | ------------------------------------------------------- | -------------------- |
| `cdkrd check`  | find drift                                              | nothing              |
| `cdkrd accept` | "this state is RIGHT" — bless it into the baseline file | a git file only      |
| `cdkrd revert` | "this state is WRONG" — write the desired value back    | AWS (plan + confirm) |

- **Declared** properties are compared against the **deployed template** — no
  baseline involved, drift is detected from the first run.
- **Undeclared** properties are compared against a **baseline** you bless with
  `accept`: a JSON file at `.cdkrd/<stack>.<accountId>.<region>.json` that you commit.
  A PR that changes it is a visible, reviewable change to "what real state we accept".
- There is **no watch-list to maintain**. `cdkrd` snapshots the full live model
  (Cloud Control API + SDK readers for the gap types) and subtracts everything
  explainable — schema read-only/write-only/defaults, AWS-managed fields, `aws:*`
  tags, policy-document and ordering noise. What survives is signal.
- Anything not confidently comparable is reported honestly as informational
  (`readGap` / `unresolved` / `skipped`) — **never** guessed, so no false drift.

In a CDK app directory it synthesizes (via `@aws-cdk/toolkit-lib`) to auto-discover
your stacks and label findings by **construct path**. It also works on any deployed
CloudFormation stack by name, no synth needed.

Full design and rationale: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install

> Not yet on npm — coming with the first public release.

```bash
npm install -D cdk-real-drift     # in your CDK project
npx cdkrd check                   # synthesizes the app, checks every stack
```

Requirements: Node.js >= 20, AWS credentials via the standard SDK chain
(env vars, `--profile`, SSO).

## Quick start

```bash
# 1) See everything: declared drift + the full undeclared picture
npx cdkrd check MyStack --region us-east-1

# 2) Bless the undeclared values that are fine (interactive multiselect)
npx cdkrd accept MyStack --region us-east-1

# 3) From now on, check is CLEAN until something really changes
npx cdkrd check MyStack --region us-east-1
```

```console
=== cdkrd check: MyStack (us-east-1) ===

result: CLEAN
info: readGap=1 (write-only 1) · skipped=2 (custom resource 2) — run with --verbose for the list
```

On the first `check` (no baseline yet, interactive terminal), `cdkrd` offers to
bless the current state right away — so the realistic first run is just `check`.

A resource that was **deleted out of band** is the most blatant drift there is. It is
reported in the `deleted` tier and always sets exit 1, regardless of `--fail-on`:

```console
=== cdkrd check: ApiStack (us-east-1) ===

[DELETED (resource deleted out of band — always drift)] 1
  ApiStack/EventsQueue (AWS::SQS::Queue) — resource deleted out of band

result: 1 drift(s) (deleted=1)
```

**Multi-account tip:** the account id is part of the baseline filename, so the same
stack deployed to several accounts (`env: { account: PERSONAL || SHARED }`) gets one
baseline per account — they never collide. Commit the shared-environment baselines;
gitignore personal ones if you prefer (e.g. `.cdkrd/*.<personal-account>.*.json`).

## IAM permissions

`check` / `accept` are **read-only**. The AWS managed `ReadOnlyAccess` policy covers
them. If you scope tighter, the calls are:

<details>
<summary>Minimal read permissions (check / accept)</summary>

- `cloudformation:GetTemplate`, `ListStackResources`, `DescribeStacks`,
  `DescribeType`; `ListExports` (only for templates using `Fn::ImportValue`);
  `ListStacks` (only with `--all`)
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

## Commands & options

| command                             | does                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `cdkrd check [<stack>...] [--all]`  | compare live state vs template (declared) + baseline (undeclared)      |
| `cdkrd accept [<stack>...] [--all]` | snapshot current undeclared state into the baseline file               |
| `cdkrd revert [<stack>...] [--all]` | write the desired value back to AWS (confirms; `--dry-run` to preview) |

- With no stack and no `--all`, the CDK app is synthesized (`--app` / `cdk.json`)
  and every stack it defines is targeted.
- A stack argument containing `*` or `?` is a glob (`cdkrd check 'Dev*'`), matched
  against the synth-discovered stack names.
- **Exit codes:** `0` clean · `1` drift · `2` error — so `check` drops straight into
  CI:

```yaml
- run: npx cdkrd check MyStack --region us-east-1 # fails the job on drift
```

| option                           | meaning                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--region <r>`                   | AWS region (or `$AWS_REGION` / `$AWS_DEFAULT_REGION`); CDK stacks with explicit `env.region` are auto-detected                |
| `--profile <p>`                  | AWS profile (or `$AWS_PROFILE`)                                                                                               |
| `--app <cmd\|cdk.out>`           | CDK app command or pre-synthesized assembly dir (or `$CDKRD_APP` / cdk.json `"app"`) — stack auto-discovery + construct paths |
| `-c, --context key=value`        | context for synth (repeatable; cdk.json is the base layer)                                                                    |
| `--json`                         | machine-readable output (see [JSON contract](#json-output-contract))                                                          |
| `--fail-on declared\|undeclared` | which tier sets exit 1 (default `undeclared` = both; `deleted` always fails)                                                  |
| `--show-all`                     | inventory mode: show ALL current undeclared state, ignoring the baseline                                                      |
| `--verbose` / `-v`               | (check) expand the informational tiers (`readGap` / `unresolved` / `skipped`) from the `info:` summary line to full lists     |
| `--pre-deploy`                   | (check) compare live vs the LOCAL synth template — the declared drift your next `cdk deploy` would silently overwrite         |
| `--all`                          | every deployed stack in the region                                                                                            |
| `--dry-run`                      | (revert) print the plan; make no changes                                                                                      |
| `--remove-unblessed`             | (revert) on a stack with NO baseline, REMOVE undeclared drift (default: refuse — run `accept` first)                          |
| `--yes` / `-y`                   | skip confirmations (revert apply; accept blesses all without the multiselect)                                                 |

### Interactive flows (TTY only — CI is never prompted)

- **`check` with drift** offers `Nothing / Accept / Revert` inline (shown above).
  `Nothing` is the default; Enter keeps plain-check behavior. Accept and Revert run
  exactly the same code as the standalone commands. Skipped under `--json`,
  `--show-all`, and `--pre-deploy`. Aborting the Revert confirmation keeps the
  exit code at 1 (nothing was written — the drift still stands).
- **`accept`** shows a multiselect of the undeclared values, all pre-selected.
  Deselect a suspicious one and it stays reported by `check` — bless the intentional
  changes without rubber-stamping the rest.
- **`check` with no baseline yet** offers to bless the current state on the spot.

## Output

Drift tiers (`deleted` / `declared` / `undeclared`) are always printed in full —
they are the point. Informational tiers (`readGap` / `unresolved` / `skipped`) fold
into a one-line `info:` footer with per-reason counts; `--verbose` expands them.
Zero-count tiers are omitted. Greppable: `^result:` is the verdict, `^info:` the rest.

```console
=== cdkrd check: ApiStack (us-east-1) ===

[DECLARED DRIFT] 1
  ApiStack/UploadBucket.VersioningConfiguration.Status (AWS::S3::Bucket)
      desired="Enabled"
      actual ="Suspended"

result: 1 drift(s) (declared=1)
```

### JSON output contract

`--json` emits `{ "stack": "<name> (<region>)", "drifted": <n>, "findings": [...] }`.
Each finding has a stable shape: `tier` (`deleted` | `declared` | `undeclared` |
`readGap` | `unresolved` | `skipped`), `logicalId`, `resourceType`, `path`,
`desired`, `actual`, `note`, `physicalId`, `constructPath`. It always carries every
finding regardless of `--verbose`. After publication this shape is treated as a
backward-compatible API.

## Limitations

- **Fail-closed by design.** A property `cdkrd` cannot confidently compare (an
  exotic intrinsic, a write-only value, a Cloud-Control-unreadable type) is reported
  as informational, never guessed. You trade a little coverage for zero false drift.
- **Revert cannot do everything.** Not revertable, and reported as such:
  - a `deleted` resource (recreate it with `cdk deploy`);
  - **create-only** properties (changing them requires resource replacement);
  - toggle-style properties with no "absent" state (e.g. S3 transfer acceleration
    is only `Enabled`/`Suspended`);
  - `AWS::Lambda::Permission` and `AWS::Budgets::Budget` (their write APIs cannot
    safely reconstruct the desired state from what is readable).
- **Revert writes the canonical form** of the desired value — semantically equal to
  your template, but statement/tag ordering or scalar-vs-array may differ textually.
- **Custom resources** (`Custom::*`) have no cloud-side model and are always
  `skipped` (without an API call).
- **Lambda Permission:** if only the specific statement was removed out of band
  (while the function's policy still exists), it is reported as `skipped`, not
  `deleted` — identifying the exact statement would need its `StatementId`.

## FAQ

**How can `cdkrd` catch a change to a property that is in neither my template nor
the baseline?**
The baseline is not a watch-list. Every `check` reads the _full_ live model, then
subtracts template + schema + baseline. A property that newly appears (or changes)
with a meaningful value survives the subtraction and is reported — whether or not
anyone listed it anywhere first.

**Why doesn't `--show-all` list a feature that is explicitly OFF?**
Undeclared values that are `false`/empty are suppressed — AWS returns an "off/empty"
value for nearly every unset option, and keeping them would flood the output. The
case that matters is still caught: a blessed value that later flips to `false`/empty
out of band is reported via baseline removal-detection.

**Why does the reverted value not match my template character-for-character?**
Revert writes the canonical (structurally compared) form. It is semantically
identical; ordering and scalar-vs-array may differ.

**Is it safe to run in CI / on production accounts?**
`check` and `accept` make read-only AWS calls (plus a local baseline file write for
`accept`). `revert` is the only mutating command; it never runs without `--yes` or
an interactive confirmation, and `--dry-run` shows the plan without changes.

**What does it cost?**
Nothing beyond the API calls it makes (reads with bounded concurrency and adaptive
retry). No AWS Config, no recorders, nothing to enable or pay for per-resource.

## Contributing

```bash
pnpm install
vp run test         # unit tests        vp run typecheck
vp run check        # lint + format     vp run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Integration tests (real AWS, self-cleaning)
live under [tests/integration/](tests/integration/README.md). Design rationale:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [DESIGN.md](DESIGN.md).

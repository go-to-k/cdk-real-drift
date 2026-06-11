# cdk-real-drift (`cdkrd`)

> Detect when your **real** AWS resources drift from your CDK / CloudFormation IaC —
> **including properties you never declared**: the gap that `cdk drift`,
> CloudFormation drift detection, `driftctl`, and `terraform plan` all miss.
> **No AWS Config required.**

**Status:** pre-release / experimental. Not yet published. `check` / `accept` never
write to AWS; `revert` is the one AWS-mutating command (always confirms first).

## Why

`cdk drift` and CloudFormation drift detection only compare properties that appear
in your template. If someone changes a setting you never declared — a bucket's
`OwnershipControls`, a role's `PermissionsBoundary`, encryption toggled off, an
extra inline policy — it is **invisible** to those tools.

`cdkrd` reads the **full** live resource state and reports the divergence —
declared and undeclared alike — against a baseline you bless and commit to git,
and can **revert** it back to the desired value.

It does NOT reimplement `cdk diff` (code-vs-template). It is a drift tool:
**reality vs intent** — find it, accept it, or revert it.

Run it in a CDK app and it synthesizes (via `@aws-cdk/toolkit-lib`) to auto-discover
your stacks and show findings by **construct path**; it also works on any deployed
CloudFormation stack by name (no synth needed).

## Install / build

```bash
pnpm install && vp run build      # produces dist/cli.js (bin: cdkrd)
node dist/cli.js --help
```

Built with [Vite+](https://vite.plus) (`vp`) — same toolchain as `cdk-local`.

## Quick start

```bash
# 1) bless the current real state as the baseline (writes a git file only, no AWS writes)
node dist/cli.js accept MyStack --region us-east-1

# 2) later / in CI: detect drift since the baseline
node dist/cli.js check MyStack --region us-east-1
```

Example output when someone enabled S3 transfer acceleration out-of-band — a change
CloudFormation drift would never surface:

```
=== cdkrd check: MyStack (us-east-1) ===

[DELETED ...] 0
[DECLARED DRIFT] 0
[UNDECLARED DRIFT (the differentiator)] 1
  Data.AccelerateConfiguration (AWS::S3::Bucket) = {"AccelerationStatus":"Enabled"}
[READ GAP ...] 0
[UNRESOLVED ...] 0
[SKIPPED ...] 0

result: 1 drift(s) (deleted=0 declared=0 undeclared=1 readGap=0 unresolved=0 skipped=0; fail-on=undeclared)
```

A resource the template still declares but that has been deleted out of band
(released via the console, another tool, …) is reported in the `deleted` tier and
**always** sets exit 1, regardless of `--fail-on` — it is the most blatant drift
there is. It is reported as `not revertable` (recreate it with `cdk deploy`).

Run `check` before `cdk deploy` (catch drift), `accept` after (re-bless). The
baseline lives at `.cdkrd/<stack>.<region>.json` — commit it; a PR that changes it
is a visible, reviewable change to "what real state we accept".

## Commands & options

| command                             | does                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `cdkrd check [<stack>...] [--all]`  | compare live state vs template (declared) + baseline (undeclared)      |
| `cdkrd accept [<stack>...] [--all]` | snapshot current undeclared state into the baseline file               |
| `cdkrd revert [<stack>...] [--all]` | write the desired value back to AWS (confirms; `--dry-run` to preview) |

With no stack and no `--all`, the CDK app is synthesized (`--app` / `cdk.json`) and
every stack it defines is targeted. A stack argument containing `*` or `?` is a glob
(e.g. `cdkrd check 'Dev*'`) — matched against the synth-discovered stack names.

| option                           | meaning                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--region <r>`                   | AWS region (or `$AWS_REGION` / `$AWS_DEFAULT_REGION`); CDK stacks with explicit `env.region` are auto-detected                |
| `--profile <p>`                  | AWS profile (or `$AWS_PROFILE`)                                                                                               |
| `--app <cmd\|cdk.out>`           | CDK app command or pre-synthesized assembly dir (or `$CDKRD_APP` / cdk.json `"app"`) — stack auto-discovery + construct paths |
| `-c, --context key=value`        | context for synth (repeatable; cdk.json is the base layer)                                                                    |
| `--json`                         | machine-readable output                                                                                                       |
| `--fail-on declared\|undeclared` | which tier sets exit 1 (default `undeclared` = both)                                                                          |
| `--show-all`                     | inventory mode: show ALL current undeclared state                                                                             |
| `--pre-deploy`                   | (check) compare live vs the LOCAL synth template — the declared drift your next `cdk deploy` would overwrite                  |
| `--all`                          | every deployed stack in the region                                                                                            |
| `--dry-run`                      | (revert) print the plan; make no changes                                                                                      |
| `--yes`/`-y`                     | skip confirmation (revert) / baseline-overwrite notice (accept)                                                               |

**Exit codes:** `0` clean · `1` drift detected · `2` error. Use in CI:

```yaml
- run: node dist/cli.js check MyStack --region us-east-1 # fails the job on drift
```

## How it stays low-noise

- **Read source:** Cloud Control API (auto-follows new types) → **SDK overrides** for
  common types Cloud Control can't read → skip + log.
- **Schema-driven noise strip:** read-only / write-only properties are removed using
  the CloudFormation resource schema (`describe-type`), at nested paths too.
- **Reusable normalizers:** IAM-style policy canonicalization (Version / scalar-vs-array
  / statement order / account-id↔root-ARN), embedded JSON-text, `aws:*` tags
  (list + map), AWS-enriched array sub-fields (`declared ⊆ actual`).
- **Fail-closed resolver:** anything not confidently resolvable (e.g. `Fn::GetAtt`,
  a condition over an unknown) is reported as `unresolved` (skipped) — **never** a
  fabricated value that would show as false drift.

### CC-gap types read via SDK overrides

`AWS::S3::BucketPolicy`, `AWS::SNS::TopicPolicy`, `AWS::SQS::QueuePolicy`,
`AWS::IAM::Policy`, `AWS::IAM::ManagedPolicy`, `AWS::Lambda::Permission`,
`AWS::Budgets::Budget`, `AWS::EC2::EIP` (CC `GetResource` throws
`ValidationException`; read via EC2 `DescribeAddresses`). Other
Cloud-Control-unreadable types are reported as `skipped` (never silently dropped).

## Known limitations

- Declared comparison uses a focused intrinsic resolver; exotic templates may show
  some declared properties as `unresolved` (skipped, not false drift — by design).
- Cloud Control API only for reads beyond the SDK overrides above; unreadable types
  are `skipped`.
- **revert** writes via Cloud Control `UpdateResource`. It restores declared drift
  to the deployed-template value and undeclared drift to the blessed baseline value.
  Reverting an undeclared _addition_ that was never blessed is done by removal —
  which is not possible for toggle-style properties (e.g. S3 transfer acceleration
  has no "absent" state, only Enabled/Suspended); such props are reported and left.
  Cloud-Control-unwritable types revert via a type-specific SDK writer (read current
  model -> apply ops -> SDK write): the policy-document types (`AWS::S3::BucketPolicy`,
  `AWS::SNS::TopicPolicy`, `AWS::SQS::QueuePolicy`, `AWS::IAM::Policy`) and
  `AWS::IAM::ManagedPolicy` (revert the default version's document via
  `CreatePolicyVersion`, pruning the oldest version when the 5-version cap is hit).
  CC-gap types without a writer (`AWS::Lambda::Permission` — an add/remove statement
  model keyed by StatementId, not a settable document; `AWS::Budgets::Budget` —
  `UpdateBudget` needs a full NewBudget the reader can't reconstruct) are reported as
  `not revertable`.
- `check --pre-deploy` compares live state against the LOCAL synth template (not the
  deployed one), surfacing the declared drift your next `cdk deploy` would silently
  overwrite. New resources in the synth that aren't deployed yet show as `skipped`
  (no physical id); resources removed from code are simply not compared.

## Develop

```bash
vp run test         # unit tests (vitest under Vite+)
vp run typecheck    # tsgo --noEmit
vp run check        # lint + format (oxc); `vp check --fix` to autofix
vp run build        # bundle to dist/ (tsdown)
```

Integration tests (real AWS, self-cleaning) live under `tests/integration/` — see
[tests/integration/README.md](tests/integration/README.md). Architecture +
rationale: [DESIGN.md](DESIGN.md).

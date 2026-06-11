# cdk-real-drift (`cdkrd`)

> Detect when your **real** AWS resources drift from your CDK / CloudFormation IaC —
> **including properties you never declared**: the gap that `cdk drift`,
> CloudFormation drift detection, `driftctl`, and `terraform plan` all miss.
> **No AWS Config required.**

**Status:** pre-release / experimental. Not yet published. Detect-only (never writes to AWS).

## Why

`cdk drift` and CloudFormation drift detection only compare properties that appear
in your template. If someone changes a setting you never declared — a bucket's
`OwnershipControls`, a role's `PermissionsBoundary`, encryption toggled off, an
extra inline policy — it is **invisible** to those tools.

`cdkrd` reads the **full** live resource state and reports the divergence —
declared and undeclared alike — against a baseline you bless and commit to git.

It does NOT reimplement `cdk diff` (code-vs-template). It is purely a drift tool:
**reality vs intent.**

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

[DECLARED DRIFT] 0
[UNDECLARED DRIFT (the differentiator)] 1
  Data.AccelerateConfiguration (AWS::S3::Bucket) = {"AccelerationStatus":"Enabled"}
[READ GAP ...] 0
[UNRESOLVED ...] 0
[SKIPPED ...] 0

result: 1 drift(s) (declared=0 undeclared=1 readGap=0 unresolved=0 skipped=0; fail-on=undeclared)
```

Run `check` before `cdk deploy` (catch drift), `accept` after (re-bless). The
baseline lives at `.cdkrd/<stack>.<region>.json` — commit it; a PR that changes it
is a visible, reviewable change to "what real state we accept".

## Commands & options

| command                            | does                                                              |
| ---------------------------------- | ----------------------------------------------------------------- |
| `cdkrd check <stack>... \| --all`  | compare live state vs template (declared) + baseline (undeclared) |
| `cdkrd accept <stack>... \| --all` | snapshot current undeclared state into the baseline file          |
| `cdkrd init <stack>`               | first-time baseline (alias of `accept`)                           |

| option                           | meaning                                                |
| -------------------------------- | ------------------------------------------------------ |
| `--region <r>`                   | AWS region (default `$AWS_REGION` or `us-east-1`)      |
| `--json`                         | machine-readable output                                |
| `--fail-on declared\|undeclared` | which tier sets exit 1 (default `undeclared` = both)   |
| `--no-baseline`                  | ignore baseline; show all non-default undeclared state |
| `--all`                          | every deployed stack in the region                     |
| `--yes`/`-y`                     | skip the baseline-overwrite notice                     |

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
`AWS::Budgets::Budget`. Other Cloud-Control-unreadable types are reported as
`skipped` (never silently dropped).

## Known limitations

- Declared comparison uses a focused intrinsic resolver; exotic templates may show
  some declared properties as `unresolved` (skipped, not false drift — by design).
- Cloud Control API only for reads beyond the SDK overrides above; unreadable types
  are `skipped`.
- `clobber` / `--pre-deploy` (flag a drift your next deploy would overwrite) is on
  the roadmap; it requires synthesizing the app and is intentionally not in the
  detect-only MVP.

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

# cdk-real-drift (private, pre-release) — command: `cdkrd`

> Detect when real AWS resources drift from your CDK/CloudFormation IaC —
> **including properties you never declared**, the gap that `cdk drift`,
> CloudFormation drift detection, driftctl, and `terraform plan` all miss.
> **No AWS Config required.**

**Status:** experimental, private until first public launch. Not production-ready.

## Why

`cdk drift` / CloudFormation drift only compare properties that appear in your
template. If someone changes a setting you never declared (bucket
`OwnershipControls`, an undeclared SG rule, encryption toggled off), it is
invisible to those tools. cdk-real-drift reads the **full** live resource state and
shows the divergence — declared and undeclared alike.

It does NOT do `cdk diff`'s job (code-vs-template). It is purely a drift tool:
**reality vs intent.**

## Commands (MVP, detect-only — no AWS writes)

| command | does |
|---|---|
| `cdkrd check <stack>`  | compare live AWS state vs template (declared) + baseline (undeclared); exit 0/1/2 |
| `cdkrd accept <stack>` | snapshot current state into the baseline FILE (git-committed) |
| `cdkrd init <stack>`   | first-time baseline creation |

Run `check` before `cdk deploy` (catch drift), `accept` after (re-bless).

## Quick start

```bash
npm install && npm run build

# first time: bless the current real state as the baseline (writes a git file only)
node dist/cli.js accept MyStack --region us-east-1

# later / in CI: detect drift since the baseline
node dist/cli.js check MyStack --region us-east-1
#   exit 0 = clean, 1 = drift, 2 = error
#   --json                       machine-readable output
#   --fail-on declared|undeclared   which tier fails CI (default: undeclared = both)
#   --no-baseline                show all non-default undeclared state (ignore baseline)
```

The baseline lives at `.cdkrd/<stack>.<region>.json` — commit it; a PR that
changes it is a visible, reviewable change to "what real state we accept".

## Known limitations (MVP)

- **Declared-property comparison uses a minimal intrinsic resolver.** Complex
  `Fn::If` / account-principal IAM trust policies (e.g. the CDK bootstrap stack)
  can show false declared-drift. The differentiator — undeclared detection — is
  unaffected. (Planned: swap in cdkd's full resolver.)
- **AWS enriches some declared structures** with sub-fields it didn't ask for
  (e.g. S3 `BucketEncryption.BucketKeyEnabled`); these can surface as declared
  drift until per-type sub-field normalization lands.
- **Schema-based read-only/write-only stripping is top-level only** (nested-path
  stripping is a follow-up).
- **Cloud Control API only** for reads — types CC can't read (e.g.
  `AWS::SNS::TopicPolicy`, `AWS::Budgets::Budget`) are reported as `skipped`, not
  checked. SDK-override reads are a follow-up.
- **Sibling-managed inline resources** (a separate `AWS::IAM::Policy` attaching to
  a role) can surface as undeclared on the role.
- `Fn::GetAtt`-bearing declared values are reported as `unresolved` (skipped, not
  drift).

## How it stays low-noise

- Read source: Cloud Control API (auto-follows new types) → SDK override for
  gaps → skip+log.
- Noise auto-stripped from the CloudFormation **resource schema**
  (`describe-type` → `readOnlyProperties` / `writeOnlyProperties`, at nested
  paths too).
- A few reusable normalizers (intrinsic resolution, policy-doc canonicalization,
  `aws:*` tags, scalar defaults).
- Baseline is a git-committed JSON file (`.cdkrd/<stack>.<region>.json`) —
  zero extra infra, PR-diffable.

See [DESIGN.md](DESIGN.md) for the full architecture and rationale.

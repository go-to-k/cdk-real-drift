# cdkdrift (working name — private, pre-release)

> Detect when real AWS resources drift from your CDK/CloudFormation IaC —
> **including properties you never declared**, the gap that `cdk drift`,
> CloudFormation drift detection, driftctl, and `terraform plan` all miss.
> **No AWS Config required.**

**Status:** experimental, private until first public launch. Not production-ready.

## Why

`cdk drift` / CloudFormation drift only compare properties that appear in your
template. If someone changes a setting you never declared (bucket
`OwnershipControls`, an undeclared SG rule, encryption toggled off), it is
invisible to those tools. cdkdrift reads the **full** live resource state and
shows the divergence — declared and undeclared alike.

It does NOT do `cdk diff`'s job (code-vs-template). It is purely a drift tool:
**reality vs intent.**

## Commands (MVP, detect-only — no AWS writes)

| command | does |
|---|---|
| `cdkdrift check <stack>`  | compare live AWS state vs template (declared) + baseline (undeclared); exit 0/1/2 |
| `cdkdrift accept <stack>` | snapshot current state into the baseline FILE (git-committed) |
| `cdkdrift init <stack>`   | first-time baseline creation |

Run `check` before `cdk deploy` (catch drift), `accept` after (re-bless).

## How it stays low-noise

- Read source: Cloud Control API (auto-follows new types) → SDK override for
  gaps → skip+log.
- Noise auto-stripped from the CloudFormation **resource schema**
  (`describe-type` → `readOnlyProperties` / `writeOnlyProperties`, at nested
  paths too).
- A few reusable normalizers (intrinsic resolution, policy-doc canonicalization,
  `aws:*` tags, scalar defaults).
- Baseline is a git-committed JSON file (`.cdkdrift/<stack>.<region>.json`) —
  zero extra infra, PR-diffable.

See [DESIGN.md](DESIGN.md) for the full architecture and rationale.

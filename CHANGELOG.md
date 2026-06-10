# Changelog

All notable changes to cdk-realdrift. Pre-release; private until first public launch.

## [Unreleased] — detect-only MVP

### Added

- `check` command — compares live AWS resource state against the deployed
  CloudFormation template (declared) and the baseline file (undeclared), and
  reports drift in tiers: `declared`, `undeclared` (the differentiator),
  `readGap`, `unresolved`, `skipped`. Exit 0 clean / 1 drift / 2 error.
- `accept` / `init` commands — write the current undeclared state to the
  git-committed baseline file (`.cdkrd/<stack>.<region>.json`). No AWS writes.
- `--json`, `--fail-on declared|undeclared`, `--region`, `--no-baseline` flags.
- Reads via Cloud Control API `GetResource`; full-state including undeclared
  properties. Read-only/write-only noise stripped from the CloudFormation
  resource schema (`describe-type`).
- Noise normalizers: AWS-managed field strip, trivial-empty/off suppression,
  `aws:*` tag suppression (list + map shapes), schema + known-default
  suppression, identity (physical-id) suppression, IAM-style **policy-document
  canonicalization** (Version fill, scalar/array unify, statement sort,
  account-id ↔ root-ARN principal equivalence), embedded JSON-text
  canonicalization.
- JSON and CloudFormation YAML templates (shorthand intrinsics preserved).
- Intrinsic resolution for declared comparison: `Ref` / `Fn::Sub` / `Fn::If` /
  `Fn::Join` / `Fn::Select` (+ condition evaluation); `Fn::GetAtt` and
  unsupported intrinsics resolve to `unresolved` (skipped, never false drift).

### Known limitations

See README "Known limitations (MVP)".

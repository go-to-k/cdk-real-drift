# Changelog

All notable changes to cdk-real-drift. Pre-release; private until first public launch.

## [Unreleased] — detect-only MVP

### Added (community-readiness pass)

- **SDK overrides** for common Cloud-Control-unreadable types: `AWS::S3::BucketPolicy`,
  `AWS::SNS::TopicPolicy`, `AWS::SQS::QueuePolicy`, `AWS::IAM::Policy`,
  `AWS::IAM::ManagedPolicy`, `AWS::Lambda::Permission`, `AWS::Budgets::Budget`
  (read off resolved declared properties; unit-tested with aws-sdk-client-mock).
- **Fail-closed resolver**: CommaDelimitedList / `List<>` params resolve to arrays;
  `Fn::If` / `Fn::Equals` / `Fn::And` / `Fn::Or` / `Fn::Not` / conditions return
  `unresolved` when not cleanly evaluable instead of guessing a branch — prevents
  fabricated values surfacing as false declared drift.
- **Nested-path schema strip** (read-only / write-only at any depth incl `*`).
- **Sibling IAM inline-policy suppression** (a role's live `Policies` managed by a
  separate `AWS::IAM::Policy` is no longer false-undeclared).
- **Multi-stack**: positional `<stack>...` and `--all`; worst exit code across stacks.
- **removed-undeclared detection**: a blessed value that disappears is reported.
- `--help` / `-h`, `--version` / `-v`; `accept` baseline-overwrite notice / `--yes`.
- Friendly top-level errors (no creds / stack-not-found / access-denied).
- LICENSE (MIT), GitHub Actions CI, biome lint/format, npm publish config.
- Test coverage: 71 unit tests; 3 real-AWS integ fixtures (S3 / IAM / Lambda).

### Added (initial MVP)

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

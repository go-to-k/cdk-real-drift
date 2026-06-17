# cdk-real-drift — design

## Identity

A CDK-ecosystem drift detector. Superset of `cdk drift`: it also sees
**undeclared** properties. Reality-vs-intent only; it does NOT take on
`cdk diff` (code-vs-template). No AWS Config dependency.

## What `check` compares (three "desired" sources)

| source                                           | used for                                   |
| ------------------------------------------------ | ------------------------------------------ |
| deployed CloudFormation template (`GetTemplate`) | declared-property drift                    |
| baseline snapshot file (last `record`)           | undeclared-property + added-resource drift |
| code synth (`--pre-deploy` only)                 | clobber annotation (optional)              |

Declared drift compares against the **deployed** template (not code synth) — else
un-deployed code edits would show as false "drift".

## check pipeline

```
1. baseline file load            .cdkrd/<stack>.<accountId>.<region>.json
2. desired (declared):           GetTemplate + DescribeStackResources (phys-id map)
                                 → intrinsic resolution
3. live full state per resource: CC API GetResource (default)
                                 → SDK override (gap types) → skip+log
4. normalize / subtract noise:
     - schema strip   (describe-type readOnly/writeOnly, nested paths incl '*')
     - cc-api strip   (timestamps, revision ids, ...)
     - policy canonical (Action/Resource/Principal scalar-vs-array unify, statement
       sort, account-id<->root-ARN; Version kept only when declared — never fabricated)
     - aws:* tags (list + map); schema-defaults (at ANY depth, via $ref-resolved
       nested `default` extraction; R103) + per-type known-defaults are NOT dropped
       but tagged `atDefault` (folded, never drift; R86); auto-generated identifiers
       AWS assigns at deploy and absent from the template, keyed by the resource's
       physical id (a topic's minted TopicName, a Lambda's default LoggingConfig log
       group) are tagged `generated` (R104)
     - sibling AWS::IAM::Policy entries filtered BY NAME from a role's live
       Policies (an out-of-band inline policy next to them still reports)
5. classify (tag):  declared | undeclared | atDefault | generated | readGap | unresolved | skipped
5b. enumerate added (out-of-band whole resources): per declared PARENT type, list its
    live child resources via the service SDK and flag any absent from the template →
    `added` tier (CHILD_ENUMERATORS; API GW REST resources + methods + authorizers, API GW V2 routes + integrations + authorizers, SNS topic subs, Lambda ESMs + function URLs + aliases, EventBridge bus rules, Cognito user pool clients + groups + resource servers, AppSync data sources + resolvers + functions, CloudWatch Logs metric filters + subscription filters, ELBv2 listeners, ELBv2 listener rules, EC2 VPC subnets, EC2 route table routes, ECS cluster services, KMS key aliases, AppConfig environments + configuration profiles, EFS mount targets, RDS DB cluster instances). Resource-granularity
    sibling of undeclared, reconciled against the baseline the same way: each added
    child is read in FULL (CC GetResource) + normalized, so `record` snapshots it and a
    later CHANGE surfaces as drift; an UNRECORDED added resource is Not-Recorded
    inventory (not drift), a recorded+unchanged one is suppressed (PR4). Not a
    per-property compare, so it runs outside classify. Revertable by Cloud Control
    DeleteResource (no per-type writer; an unrecorded one needs --remove-unrecorded).
6. report + exit code (report-only by default; --fail → 1 on drift; --strict → 1 on incomplete coverage; 2 error)
```

cdkrd is **CDK-only**: every run resolves the CDK app (synth, or a pre-synthesized
`cdk.out`) to discover which stacks to check. The drift comparison still reads each
stack's deployed template + live state from AWS — synth only decides scope + labels
construct paths (and, in `--pre-deploy`, becomes the declared source). Output is plain
text + JSON (CI-greppable; no TUI/panes; ANSI color on a TTY only — piped/`NO_COLOR`
output stays byte-identical plain text).

## Subtractive noise model

Do NOT hand-maintain a watch allow-list (explodes). Snapshot full state, subtract
what existing tools explain:

```
all live changes
  − declared (vs template)        → "declared drift" tag
  − intended (vs --pre-deploy synth) → "clobber" / suppressed
  = undeclared residual           → the unique signal
```

PoC-confirmed (CDKToolkit S3 + IAM, us-east-1): biggest noise (readOnly/writeOnly
attrs) is auto-strippable from the resource schema; residual undeclared signal was
tiny + meaningful (S3 `AbacStatus`, `OwnershipControls`).

## Reuse from cdkd

COPY (low coupling, verified):

- `analyzer/drift-calculator.ts` — `calculateResourceDrift(state, aws, {ignorePaths, unionWalkObjects})`, pure
- `analyzer/cc-api-strip.ts` — `stripCcApiAwsManagedFields`, pure
- `analyzer/drift-cc-api-deny-list.ts` — `CC_API_FALLBACK_DENY_LIST`, data
- (NOT copied) `deployment/intrinsic-function-resolver.ts` — we wrote our OWN focused, fail-closed resolver (`src/normalize/intrinsic-resolver.ts`) instead; swapping in cdkd's full resolver is a later candidate
- `provisioning/cloud-control-provider.ts` readCurrentState — CC GetResource wrapper
- a FEW SDK-override readCurrentState (s3 / iam-role / lambda) — ONLY for CC-gap types
- `types/resource.ts` + `types/state.ts`; `utils/logger` + `utils/aws-clients` (optional)

NEW (cdkd does NOT have these):

- **schema-strip** — `describe-type` readOnly/writeOnly → strip set (cdkd hand-codes per-provider instead; this is our differentiator: less per-type code)
- **policy canonicalizer** — scalar/array unify + statement sort + account-id↔root-ARN + Condition value-set canonicalize (scalar/array unify + sort) (no Version fabrication); cdkd only URL-decodes + JSON.parse, raw-compares → tolerates false positives
- **desired-adapter** — GetTemplate + DescribeStackResources → resolved declared
- **baseline file I/O** — git-committed JSON (the `record` verb; KEEPS watching)
- **config ignore rules** — git-committed `.cdkrd/config.json`; the `ignore` verb
  appends path rules (declared, undeclared, OR an out-of-band `added` resource)
  that re-tag findings to `ignored` and STOP watching (the `.driftignore` /
  `ignore_changes` analogue)
- **report** — tiered text + JSON
- **golden corpus** — recorded real pipeline inputs+findings, replayed offline in CI (R63)

## Roadmap (private until Phase 4)

- Phase 2: build MVP here (private repo). DONE.
- Phase 3 (current): dogfood broadly on varied real stacks; tune normalizers;
  land revert. See [redesign-notes.md](redesign-notes.md) for the
  check/record/ignore/revert model adopted before publication.
- Phase 4: publish + blog announce (the single public launch).

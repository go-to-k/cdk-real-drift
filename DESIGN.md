# cdk-real-drift — design

## Identity

A CDK-ecosystem drift detector. Superset of `cdk drift`: it also sees
**undeclared** properties. Reality-vs-intent only; it does NOT take on
`cdk diff` (code-vs-template). No AWS Config dependency.

## What `check` compares (three "desired" sources)

| source                                           | used for                      |
| ------------------------------------------------ | ----------------------------- |
| deployed CloudFormation template (`GetTemplate`) | declared-property drift       |
| baseline snapshot file (last `accept`)           | undeclared-property drift     |
| code synth (`--pre-deploy` only)                 | clobber annotation (optional) |

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
     - aws:* tags (list + map), scalar schema-defaults + per-type known-defaults
     - sibling AWS::IAM::Policy entries filtered BY NAME from a role's live
       Policies (an out-of-band inline policy next to them still reports)
5. classify (tag):  declared | undeclared | readGap | unresolved | skipped
6. report + exit code (0 clean / 1 drift / 2 error) + --fail-on <tier>
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
- **policy canonicalizer** — scalar/array unify + statement sort + account-id↔root-ARN (no Version fabrication); cdkd only URL-decodes + JSON.parse, raw-compares → tolerates false positives
- **desired-adapter** — GetTemplate + DescribeStackResources → resolved declared
- **baseline file I/O** — git-committed JSON
- **report** — tiered text + JSON

## Roadmap (private until Phase 4)

- Phase 2: build MVP here (private repo). DONE.
- Phase 3 (current): dogfood broadly on varied real stacks; tune normalizers;
  land revert. See [redesign-notes.md](redesign-notes.md) for the check/accept/
  revert model adopted before publication.
- Phase 4: publish + blog announce (the single public launch).

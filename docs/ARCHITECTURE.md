# cdk-real-drift (`cdkrd`) — full architecture & design review

> Audience: a reviewer doing a **spec + design review** before the Phase 4 public
> launch. This document is the single self-contained map of the whole tool: what it
> is, every moving part, the design decisions and their rationale, the current
> state, and the open questions worth challenging. It is accurate to the code as of
> 40 local commits (125 unit tests green, build clean). Companion docs:
> [DESIGN.md](../DESIGN.md) (terse design), [redesign-notes.md](redesign-notes.md)
> (pre-publication decisions), [README.md](../README.md) (end-user).

---

## 1. What it is (and is not)

`cdkrd` detects — and reverts — drift between your **real deployed AWS resources**
and your CDK / CloudFormation intent, **including properties you never declared** in
the template. That undeclared-property dimension is the differentiator: `cdk drift`,
CloudFormation drift detection, `driftctl`, and `terraform plan` all compare only
properties that appear in the template, so a change to a setting you never declared
(a bucket's `OwnershipControls`, a role's `PermissionsBoundary`, encryption toggled
off, an extra inline policy, transfer acceleration enabled out-of-band) is invisible
to them. `cdkrd` reads the **full** live resource model and reports the divergence.

- **Reality vs intent**, not code vs template. It deliberately does NOT reimplement
  `cdk diff` (which is code-vs-deployed-template). It is a drift tool.
- **No AWS Config dependency** (Config is off in many accounts; cost + setup).
- **CDK-native**: it synthesizes the app via `@aws-cdk/toolkit-lib` for stack
  discovery + construct-path display, but the drift _comparison_ is
  CloudFormation-generic and runs synth-free by stack name (CI / cron / fleet).

## 1a. The core thesis & the bets to validate (read this first)

**The problem.** Infrastructure drifts. Someone clicks the console, a script runs, an
incident gets a hot-fix — and the real resource no longer matches the IaC. Every
existing drift tool (`cdk drift`, CloudFormation drift detection, `driftctl`,
`terraform plan`) answers only "do the properties I _declared_ still match?" But the
most dangerous drift is often in properties you never declared at all — security
posture (public-access blocks, encryption, ownership controls, permission
boundaries, extra inline policies) lives in defaults you never wrote down, so when it
changes, no tool tells you. **The thesis of `cdkrd`: the declared/undeclared
boundary is the wrong place to stop looking, and the gap is exactly where the
security-relevant drift hides.**

**The approach.** Read the _full_ live model of each resource (not just the declared
subset), and report everything that diverges — then make the noise tractable by
_subtracting_ what's explainable (the template, the resource schema, AWS-managed
fields, canonicalization) rather than by maintaining a hand-curated allow-list of
"things worth watching." Give the result a baseline you bless and commit to git, so
"what undeclared state we accept" becomes a reviewable artifact, and let the user
`revert` the rest.

**The bets a reviewer should pressure-test** (is this the right approach?):

1. **Subtractive > additive noise control.** We bet that snapshot-everything-minus-
   explainable converges to a small, meaningful signal, and that a watch-list would
   instead explode and rot. Evidence: PoC + 8-fixture dogfood reduced undeclared
   noise to single digits of real signal. Risk: long-tail resource types whose
   "explainable" defaults aren't in any schema → residual noise. _Is the subtractive
   model sound, or will the residual grow unbounded across the full AWS surface?_
2. **Fail-closed beats best-effort.** We never fabricate a value to compare; if an
   intrinsic or a schema gap makes a property unknowable, we mark it `unresolved`/
   `skipped` and exclude it from the pass/fail signal. This trades coverage for
   zero false positives. _Is "never cry wolf" the right default for a drift tool, or
   should it surface uncertain cases louder?_
3. **Cloud Control API as the universal reader.** CC API auto-covers new resource
   types without per-type code; SDK overrides fill only the gaps. _Does CC API's
   coverage + model fidelity hold up across the breadth users will throw at it, or
   does the SDK-override list grow until the "generic" claim breaks?_
4. **The deployed template, not synth, is the declared baseline.** So un-deployed
   code edits never masquerade as drift; `--pre-deploy` is the opt-in inversion.
   _Right call, or do users actually expect code-vs-reality by default?_
5. **Git-committed baseline as the undeclared contract.** Undeclared "drift" is only
   drift relative to a human-blessed snapshot. _Is a committed file the right control
   surface, or does it become a rubber-stamp that hides real change?_
6. **Revert via the same generic CC write path** (UpdateResource) + thin SDK writers,
   not a per-type provider fleet. _Is generic revert safe/complete enough, or are the
   not-revertable gaps (toggle props, add/remove-statement types) too sharp an edge?_

If these six bets are right, the tool is right. The rest of this document is how each
is realized in code.

## 2. The three-verb model

Detect-only is not the identity. After `check`, the human decision is binary, and
the verbs mirror it (see [redesign-notes.md](redesign-notes.md) Decision 1):

| verb           | meaning                                                            | writes          |
| -------------- | ------------------------------------------------------------------ | --------------- |
| `cdkrd check`  | find drift (declared vs deployed template, undeclared vs baseline) | nothing         |
| `cdkrd accept` | "current state is RIGHT" — bless it into the baseline file         | git file only   |
| `cdkrd revert` | "current state is WRONG" — write the desired value back to AWS     | AWS (confirmed) |

Flags (all parsed in [src/cli-args.ts](../src/cli-args.ts)): `--region` (no silent
default — resolves via SDK chain, errors if absent), `--profile`, `--app <cmd|cdk.out>`
(+ `$CDKRD_APP` / cdk.json `"app"`), `-c/--context key=value` (repeatable),
`--json`, `--fail-on declared|undeclared`, `--show-all` (inventory mode: ignore
baseline, show ALL undeclared), `--pre-deploy` (check vs local synth template),
`--all` (every deployed stack in region), `--dry-run` (revert preview),
`--yes/-y`. Stack args support globs: `cdkrd check 'Dev*'`.

Exit codes: `0` clean · `1` drift detected · `2` error.

## 3. The `check` pipeline

Entry: [src/commands/check.ts](../src/commands/check.ts) → shared gather in
[src/commands/gather.ts](../src/commands/gather.ts).

```
1. resolve stacks        resolve-stacks.ts: explicit names | globs | --all | synth-discover
2. desired (declared)    template-adapter.ts: GetTemplate + DescribeStackResources
                         (phys-id map) + DescribeStacks (params) → intrinsic resolution
                         (--pre-deploy: LOCAL synth template replaces GetTemplate)
3. live full state       read/router.ts: SDK override (gap types) FIRST, else
                         CC API GetResource; not-found → deleted; unreadable → skipped
   --- PASS 1: read ALL resources first, populate ResolverContext.liveAttrs ---
   --- PASS 2: re-resolve declared (GetAtt now resolvable) + classify ---
4. normalize / subtract  classify.ts orchestrates the normalizers (section 6)
5. classify (tier)       deleted | declared | undeclared | readGap | unresolved | skipped
6. baseline filter       applyBaseline(): undeclared findings already blessed → drop
7. report + exit code    report.ts: tiered text or --json; worst exit across stacks
```

The two-pass structure (PR "resolve Fn::GetAtt against live attributes") is what
lets a declared `Fn::GetAtt(Role, Arn)` resolve to the referenced role's _real_
live ARN instead of falling to `unresolved` — see section 5.

## 4. Module map (`src/`)

- **cli.ts** — entry; dispatch check/accept/revert (+ help/version). **cli-args.ts** —
  zero-dep arg parser → `CommonArgs`.
- **commands/**
  - **check.ts / accept.ts / revert.ts** — the three verbs.
  - **gather.ts** — shared read+classify pipeline (the 2-pass GetAtt resolution lives here).
  - **resolve-stacks.ts** — turn args into `{stackName, region}[]` (exact / glob / `--all` / synth-discovery).
  - **glob-match.ts** — pure `*`/`?` matcher (`isGlob` / `globToRegExp` / `matchesGlob`).
- **desired/** — the "intent" side
  - **template-adapter.ts** — `loadDesired()`: deployed (or `--pre-deploy` synth) template + phys-ids + params → resolved `DesiredResource[]`. Builds `ResolverContext`.
  - **yaml-cfn.ts** — CFn-flavored YAML/JSON template parser.
  - **list-stacks.ts** — `--all` deployed-stack enumeration.
- **read/** — the "reality" side
  - **router.ts** — `readLive()`: SDK_OVERRIDES first, else CC API GetResource; classifies skip reasons.
  - **overrides.ts** — `SDK_OVERRIDES` readers for CC-gap types (S3/SNS/SQS BucketPolicy/TopicPolicy/QueuePolicy, IAM Policy/ManagedPolicy, Lambda Permission, Budgets, **EC2 EIP** via DescribeAddresses).
- **normalize/** — noise subtraction (section 6)
  - **intrinsic-resolver.ts** — fail-closed CFn intrinsic resolver (section 5).
  - **noise.ts** — `isTrivialEmpty`, `isAllAwsTags`, `stripAwsTagsDeep`, `KNOWN_DEFAULTS`, **`canonicalizeTagListsDeep`**, **`canonicalizeIdArraysDeep`**.
  - **arn-identity.ts** — **`isArnNameMatch`** (bare name ↔ ARN), **`isManagedKmsAliasMatch`** (`alias/aws/*` ↔ key ARN).
  - **policy-canonical.ts** — IAM policy-doc canonicalization. **cc-api-strip.ts** — strip AWS-managed fields. **path-strip.ts** — schema readOnly/writeOnly path stripping (incl `*`).
- **schema/schema-strip.ts** — `describe-type` → readOnly/writeOnly/defaults `SchemaInfo` (cached).
- **diff/**
  - **classify.ts** — the heart: normalize both sides, then tag each difference into a tier.
  - **drift-calculator.ts** — pure structural diff (`calculateResourceDrift`), copied from cdkd.
- **baseline/baseline-file.ts** — git-committed baseline I/O (`.cdkrd/<stack>.<region>.json`), `applyBaseline`, `blessStack`.
- **revert/** — the write path (section 7): **plan.ts**, **apply.ts** (CC UpdateResource + poll), **apply-ops.ts** (pure RFC6902 apply), **writers.ts** (SDK writers).
- **synth/** — **synth.ts** (`@aws-cdk/toolkit-lib` synth + `discoverStacks`), **resolve-app.ts**, **io-host.ts** (`QuietIoHost`).
- **report/report.ts** — tiered text + JSON + exit code. **aws-errors.ts** — `isStackNotDeployed` etc. **types.ts** — shared types.

## 5. Intrinsic resolver (fail-closed + live-attr GetAtt)

[src/normalize/intrinsic-resolver.ts](../src/normalize/intrinsic-resolver.ts).
Resolves `Ref` / `Fn::Sub` / `Fn::If` (+ condition eval: Equals/And/Or/Not) /
`Fn::Join` / `Fn::Select` / `Fn::GetAtt` / `Fn::FindInMap` / `Fn::Split` /
`Fn::ImportValue` / `AWS::NoValue`, plus the `Fn::Sub` `${!Literal}` escape.
`Fn::FindInMap` resolves against `ctx.mappings` (from `template.Mappings`);
`Fn::ImportValue` against `ctx.exports` (CFn cross-stack exports — see below);
`Fn::Select` returns `UNRESOLVED` (not `undefined`) for an out-of-range index. All
of these are fail-closed: a missing mapping / export / non-string key → `UNRESOLVED`.

**Design rule: fail-closed.** Anything not _confidently_ resolvable returns the
`UNRESOLVED` sentinel, and the consuming property is reported in the `unresolved`
tier (skipped) — **never** a fabricated value that would show as false drift. A
condition that can't be cleanly evaluated does NOT guess a branch. This was a
load-bearing decision (it cut CDKToolkit's declared findings 11→2 in the PoC by
refusing to fabricate).

**`Fn::GetAtt` resolution (the 2-pass design).** GetAtt needs the referenced
resource's attributes, which aren't known at template-load time. So `gather`:
(pass 1) reads every resource's live model and populates
`ResolverContext.liveAttrs` (logicalId → live model); (pass 2) re-resolves each
resource's `declaredRaw`, so `Fn::GetAtt(X, Attr)` (and `${X.Attr}` Sub form,
dotted paths supported) resolves to X's **real live attribute** — not a guessed ARN
format. If X wasn't read or the attribute is absent → stays `UNRESOLVED`. This is
still real drift detection: it checks whether the consuming resource actually points
at that attribute's current value.

**`Fn::ImportValue` (cross-stack).** The resolver is synchronous, so exports can't be
fetched mid-resolve. `loadDesired` prefetches them — but ONLY when the template body
references `Fn::ImportValue` (a substring check), so a normal single-stack run pays
nothing — via paginated CFn `ListExports`, account+region-scoped, cached in a
module-level per-region Map. `Fn::ImportValue` then resolves a known export name to
its value, else `UNRESOLVED`.

> Trade-off to review: cdkd has a fuller `IntrinsicFunctionResolver`. We
> deliberately wrote a focused, fail-closed one. The remaining `unresolved`
> residual is exotic intrinsics — reported honestly, never false drift.

## 6. Noise model (why it stays low-noise)

The core insight (DESIGN.md): do NOT hand-maintain a watch allow-list (it explodes).
Snapshot full live state and **subtract** what existing tools / schema explain:

```
all live changes
  − declared (vs template)            → tagged "declared drift"
  − schema readOnly/writeOnly         → stripped (describe-type, nested + '*')
  − cc-api managed fields             → stripped (timestamps, revision ids)
  − policy-doc representational noise  → canonicalized (scalar/array, stmt order, acct-id↔root-ARN)
  − aws:* tags (list + map)           → stripped
  − schema defaults + known defaults  → suppressed
  − tag-list / id-array ORDER         → canonicalized (see below)
  − name↔ARN, alias/aws/*↔key-ARN     → collapsed (see below)
  − sibling AWS::IAM::Policy on a role → suppressed
  = undeclared residual                → the unique signal
```

**The four false-positive classes found by dogfooding** (8 real cdkd fixtures —
vpc-lambda / sns-sqs / rds / iam / s3-cloudfront / ecs-fargate / appsync / a mixed
stack) and fixed, each with paired regression tests asserting _noise suppressed_ AND
_real change still detected_ ([tests/classify.test.ts](../tests/classify.test.ts)):

1. **Tag-list order** — CFn `Tags` (`{Key,Value}[]`) are unordered sets; positional
   diff flagged every CDK-tagged resource. Fix: `canonicalizeTagListsDeep` (sort by Key).
2. **resource-id/ARN array order** — `SubnetIds` / `SecurityGroupIds` are unordered;
   positional diff flagged them. Fix: `canonicalizeIdArraysDeep` (sort arrays whose
   every element is an AWS id `subnet-…`/`sg-…` or ARN; plain scalar lists untouched).
3. **name ↔ ARN** — CDK declares a bare name (Lambda EventSourceMapping/Permission
   `FunctionName`, ECS `Service.Cluster`), AWS returns the full ARN. Fix:
   `isArnNameMatch` (value-shape: actual is ARN, desired non-ARN, ARN's final
   `:`/`/` segment == desired; never hides drift to a _different_ name). When the
   stack's account + region are known they are also required to match the ARN's
   region/account segments (when non-empty), so a same-named resource swapped to a
   _different account or region_ is reported as genuine drift; empty-segment ARNs
   (e.g. S3) stay suffix-only.
4. **managed-default KMS alias** — `alias/aws/rds` declared vs resolved key ARN. Fix:
   `isManagedKmsAliasMatch` (only collapses `alias/aws/*`, not custom aliases).

> Classes 1 & 3 are a latent risk in any AWS-snapshot diff; they were also
> back-ported to **cdkd** (PR #802, merged) since cdkd's `drift-calculator` shared
> the same positional comparison. See section 11.

**The `isTrivialEmpty` asymmetry (intentional trade-off).** An undeclared value that
is `false`, `''`, `[]`, or `{}` is suppressed (`isTrivialEmpty` in noise.ts) — AWS
returns a "feature off / empty" value for almost every unset option, so without this
the undeclared residual would be dominated by `X: false` noise on every resource.
The cost: on the FIRST run / under `--show-all` (inventory), an explicitly-OFF
feature is **not shown** (you can't see "encryption is false" in the inventory). The
asymmetry is one-directional and self-correcting for the case that matters: once a
non-trivial value is blessed and then changes to `false`/empty out of band, the
baseline removal-detection (§8) DOES surface it. We deliberately do NOT skip
`isTrivialEmpty` under `--show-all` — that would re-flood inventory with the very
`false`/empty noise the subtractive model exists to remove. (Considered and rejected;
see [redesign-notes.md](redesign-notes.md).)

## 7. Revert (the only AWS-mutating path)

[src/revert/](../src/revert/). `revert` builds a plan, prints it (per finding: path,
current → target), asks for confirmation (`@clack`; `--yes` skips; non-TTY refuses;
`--dry-run` previews), applies, then **re-checks for convergence**.

- **Targets**: declared drift → the **deployed-template** value; undeclared drift →
  the **baseline** value (an un-blessed out-of-band _addition_ reverts by REMOVAL).
- **No-baseline safety guard**: on a stack that has never been `accept`ed, undeclared
  drift is reported as `notRevertable` (`no baseline — run cdkrd accept first, or
pass --remove-unblessed`) rather than removed. The subtractive noise model's
  failure mode in `check` is "the report is noisy"; the un-guarded revert mirror of
  that would be **destructive** (a bulk REMOVE of every undeclared value that slipped
  through subtraction). `--remove-unblessed` opts back into removal. Declared drift is
  always revertable (the template is its source, independent of any baseline).
- **Write mechanism** (`plan.ts` chooses `kind`):
  - `kind: 'cc'` — generic Cloud Control `UpdateResource` RFC6902 PatchDocument,
    polled via `GetResourceRequestStatus` ([apply.ts](../src/revert/apply.ts)).
  - `kind: 'sdk'` — type-specific SDK writer for CC-unwritable types
    ([writers.ts](../src/revert/writers.ts)): reads current model → `applyOps`
    ([apply-ops.ts](../src/revert/apply-ops.ts), pure) → SDK `Put*`. Covers
    `AWS::S3::BucketPolicy`, `AWS::SNS::TopicPolicy`, `AWS::SQS::QueuePolicy`,
    `AWS::IAM::Policy`, and `AWS::IAM::ManagedPolicy` (`CreatePolicyVersion` +
    SetAsDefault, pruning the oldest version at the 5-version cap).
- **Not revertable (reported honestly, never silently skipped)**:
  `AWS::Lambda::Permission` (add/remove statement model keyed by StatementId, not a
  settable document), `AWS::Budgets::Budget` (`UpdateBudget` needs a full NewBudget
  the reader can't reconstruct), a `deleted` resource (`deleted — recreate via cdk
deploy`: a patch can't recreate a resource), a **create-only** property (drift on a
  `createOnlyProperties` / `conditionalCreateOnlyProperties` field needs a resource
  replacement, which an in-place `UpdateResource` can't do — caught from the schema
  at plan time, not at apply time), plus any `readGap` / `unresolved` / `skipped`
  finding. KMS keys need no SDK writer — they revert via the generic CC path.
- **Canonical-form write**: a declared-drift revert target (`finding.desired`) is the
  _normalized_ value (policy statements sorted, scalar-vs-array collapsed, tag / id
  arrays sorted), not the template verbatim. It is semantically equal to the template
  but the written value may differ **textually** (ordering, scalar-vs-array) from
  what you wrote in code. This is expected — the comparison is structural, so the
  revert writes the structural form.
- **Known limitation**: toggle-style props with no "absent" state (e.g. S3 transfer
  acceleration is only Enabled/Suspended) can't be reverted by removal.

## 8. Baseline model

`accept` snapshots the current undeclared state into a **git-committed** file
`.cdkrd/<stack>.<region>.json` ([baseline-file.ts](../src/baseline/baseline-file.ts)):

```jsonc
{ "schemaVersion": 1, "stackName": "...", "region": "...",
  "accountId": "<aws account the baseline was captured in>",
  "capturedAt": "<iso>", "templateHash": "<hash of deployed template>",
  "accepted": [ { "logicalId", "resourceType", "path", "value" }, ... ] }
```

`accountId` is a **per-account guard**: the same stack name deployed to dev + prod
must not share one baseline (comparing prod's real state against dev's blessed state
is false drift — or worse, hides real drift). `check` / `revert` refuse (exit 2) when
the loaded baseline's `accountId` differs from the account being queried. A
pre-release file with no `accountId` only warns and is stamped on the next `accept`
(the filename stays `<stack>.<region>.json`; the field, not the path, is the guard).

Committing it makes "what real state we accept" a visible, reviewable PR change.
With revert it is also the _source of the undeclared target value_, so it is
structural, not optional. `check` filters undeclared findings against it
(`applyBaseline`), so a blessed stack reports CLEAN; `--show-all` ignores it.

**Promotion into the template.** The recommended way to resolve undeclared drift is
to _declare_ it in the CDK code. After that, the blessed path is no longer undeclared,
so the naive removal check would mis-report it as "blessed value removed since
accept". `applyBaseline` is passed the set of currently-declared keys per resource
(`declaredKeysByLogical`) and suppresses that false removal, emitting a one-line
stderr note ("now declared in the template — re-run `cdkrd accept`") instead. So the
behavior we recommend is never punished as drift.

**Stale-baseline warning.** `templateHash` (sha256 of the deployed template at
capture) is verified on load (`warnTemplateHashDrift`): a mismatch prints a non-fatal
note suggesting a re-`accept` (the blessed set may be stale). Skipped under
`--pre-deploy`, where the synth template legitimately differs from the deployed one.

## 9. Tier semantics (the output contract)

| tier         | meaning                                                             | exit-affecting |
| ------------ | ------------------------------------------------------------------- | -------------- |
| `deleted`    | a resource present in the template but gone from AWS (deleted OOB)  | yes (always)   |
| `declared`   | a declared property whose live value differs from the template      | yes (always)   |
| `undeclared` | a live property not in the template, after noise subtraction        | yes (default)  |
| `readGap`    | a declared property the live read can't return (CC can't read back) | no             |
| `unresolved` | a declared property whose intrinsics couldn't be resolved (skipped) | no             |
| `skipped`    | resource unreadable (CC unsupported / no physical id)               | no             |

`deleted` is the most blatant drift — a resource the template still declares no
longer exists in AWS (released/deleted via the console, another tool, etc.). The
live read returns a not-found error (`ResourceNotFoundException` from Cloud
Control; `NoSuchBucket` / `QueueDoesNotExist` / `NoSuchEntity` / `InvalidAllocationID.NotFound` /
… from the SDK overrides), which the router maps to `deleted`. It **always** sets
exit 1 regardless of `--fail-on` (CloudFormation's own drift detection reports
DELETED too — a drift tool that returned exit 0 on a deleted resource would be
defective). It is reported as `not revertable` (reason: `deleted — recreate via
cdk deploy`) — a patch cannot recreate a resource.

`--fail-on declared` makes only `deleted` + `declared` set exit 1; default
`undeclared` = all three of `deleted` / `declared` / `undeclared`. `readGap` /
`unresolved` / `skipped` are informational — surfaced, never silently dropped, but
never false drift.

A declared **top-level write-only** property (e.g. an IAM Role's
`AssumeRolePolicyDocument`) is surfaced as a `readGap` (note: `write-only — cannot
be read back`) rather than silently dropped — honoring the "never silently dropped"
invariant. Nested write-only path stripping stays silent on purpose (too granular to
report meaningfully per path).

## 10. Synth integration

[src/synth/](../src/synth/) wraps `@aws-cdk/toolkit-lib` (same dep as cdk-local):
`synthApp()` returns per-stack `{stackName, region, template}`; `discoverStacks()`
feeds stack auto-discovery. Used for: (a) no-arg / glob stack discovery, (b)
construct-path display, (c) `--pre-deploy` (the synth template becomes the declared
source so `check` shows the declared drift the next `cdk deploy` would overwrite).
The drift comparison itself is unchanged and still works synth-free by stack name.

## 11. Reuse from cdkd + the cross-repo relationship

`cdkrd` is a **separate repo** that copies low-coupling pure utilities from cdkd
(`drift-calculator`, `cc-api-strip`, CC-gap deny-list, a few SDK-override readers)
and adds what cdkd lacks (schema-strip, policy canonicalizer, desired-adapter,
baseline I/O, report, the fail-closed resolver). Same toolchain as cdk-local
(Vite+ `vp`, pnpm, tsgo, oxc, semantic-release).

The shared `drift-calculator` lineage means bugs can be bi-directional: the
tag-order + id-array-order false positives found here were **back-ported to cdkd**
(PR #802, merged, verified by the `drift-revert-vpc` real-AWS integ). The name↔ARN
and KMS-alias fixes are cdkrd-only because cdkd's baseline is an AWS snapshot
(ARN-vs-ARN), not a template.

## 12. Testing & evidence

- **125 unit tests** (Vitest via `vp run test`), AWS SDK mocked with
  `aws-sdk-client-mock`. Coverage spans resolver (incl. GetAtt-via-live-attrs +
  fail-closed), all normalizers, classify (incl. the 4 dogfood regression pairs),
  baseline, revert plan + apply-ops + writers, overrides incl. EIP, glob, cli-args,
  template-adapter incl. `--pre-deploy` override, report.
- **Integration fixtures** under `tests/integration/{basic,iam,lambda,revert}` (real
  CDK apps + `verify.sh`). The revert integ proves deploy → accept → out-of-band
  change → check → `revert --yes` → CLEAN → AWS converged.
- **Dogfood evidence**: 8 real cdkd fixtures run through `check --show-all` → fix →
  `declared=0`, then `accept` → CLEAN, then destroy + orphan-verified. This is what
  surfaced the four false-positive classes.

## 13. Known limitations & open questions (review focus)

Things worth a reviewer's challenge before Phase 4:

1. **Lint (RESOLVED)**: `vp check` is now clean (0 errors, 7 warnings; CI `vp run
check` green). The earlier `TS2591 'process'` errors came from oxc's type-aware
   lint using the root `tsconfig.json` (which excludes tests) for test files; fixed by
   adding `tests/tsconfig.json` (oxc discovers the nearest per-file project), which
   includes the tests with node types. The 7 remaining are intentional `no-explicit-any`
   warnings (`Record<string, any>` in the template adapter) + `toThrow`-message vitest
   warnings — config sets `no-explicit-any` to `warn`, not `error`. _Open question for
   review: tighten these to errors before launch, or accept as warnings?_
2. **`--pre-deploy` undeclared semantics**: in pre-deploy mode the undeclared tier
   still compares against the baseline, but the _declared set_ comes from synth
   (which may add/remove props vs deployed). The primary signal is declared drift;
   undeclared-in-pre-deploy semantics are first-cut. **Open question**: should
   `--pre-deploy` restrict to declared, or define undeclared precisely?
3. **`unresolved` residual (narrowed)**: the resolver now also handles `Fn::FindInMap`
   / `Fn::Split` / `Fn::ImportValue` / out-of-range `Fn::Select` / the `${!Literal}`
   Sub escape — all deterministically and fail-closed (answer to the original open
   question: keep the focused, fail-closed resolver and add only intrinsics we can
   resolve with certainty, rather than adopting cdkd's full resolver). Truly exotic
   intrinsics still skip honestly. **Residual open question**: is the remaining
   long-tail worth more, or is "report it as unresolved" the right stopping point?
4. **Single-region per invocation**; cross-region stacks handled per-stack via env.
   Cross-stack `Fn::ImportValue` IS now resolved (exports prefetched per region; see
   §5). Two notes for review: the per-region exports cache is module-level (fine for a
   one-shot CLI; revisit if cdkrd ever runs as a long-lived / multi-account process),
   and the prefetch trigger is a substring check on the template body
   (`includes('Fn::ImportValue')`) — a YAML `!ImportValue` shorthand would need the
   same trigger if YAML resolution ever diverges from the JSON-normalized body.
5. **Not-revertable types** (Lambda Permission, Budgets) — documented; revisit if
   demand appears.
6. **YAML templates**: parsed (`yaml-cfn.ts`), but the dogfooding was JSON (CDK
   output). Worth a YAML-template pass.
7. **Governance / repo hygiene (in place)**: CI (`.github/workflows/ci.yml` =
   `vp run check` + test + build; `release.yml` semantic-release; `pr-title-check.yml`),
   `.markgate.yml` (check/docs/verify-pr), `.claude/skills/{check,check-docs,verify-pr}`,
   `.claude/hooks/check-gate.sh` (+ `.claude/settings.json`), `CLAUDE.md`,
   `CONTRIBUTING.md`. Deliberately deferred until the repo has a remote (Phase 4):
   branch/PR/merge gates and `.claude/rules` / `.claude/agents` — cdkd's heavy
   50-hook / 10-rule suite is disproportionate for a new repo. _Open question: which
   of those become worth adding once there are external contributors?_

## 14. Phase 4 readiness

DONE: Phase 2 (MVP) + Phase 3 (broad dogfood, normalizer tuning, revert landed,
GetAtt resolution, wildcard, EIP, ManagedPolicy revert, `--pre-deploy`, governance
skills, **lint clean / CI green**).

Repo hygiene (CLAUDE.md, CONTRIBUTING.md, check-gate hook, CI) is now in place too.

REMAINING before the single public launch (GitHub + npm + blog), none of which is a
code-correctness blocker:

- this design review (the artifact you are reading) → address any blocking findings.
- create the public GitHub repo + push, then `npm publish`, then the blog announce.
  These three are the deliberate, irreversible "single launch" event and are done
  last, on explicit go.

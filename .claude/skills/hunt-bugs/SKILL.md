---
name: hunt-bugs
description: Proactively hunt for cdkrd bugs by deploying real CDK stacks that exercise common-but-untested AWS resources, configs, and CloudFormation notations against real AWS, then catch false positives + missed detection and fix what breaks. Use for a periodic "find latent bugs" sweep, not for verifying a specific change.
argument-hint: "[area hint, e.g. 'rich S3' | 'CFn intrinsics' | 'console-edit detection']"
---

# cdkrd Bug Hunt

Find latent cdkrd bugs the way real users hit them: deploy a CDK stack that uses a
resource / config / CloudFormation notation **cdkrd has not exercised yet**, then
`check` it against real AWS and watch for misbehavior. cdkrd's logic is heavily
unit-tested, so the remaining bugs live in the gap between its model of AWS and the
**actual** live AWS response — only a real deploy surfaces those. Reading the source
finds _suspected_ bugs; deploying finds _real_ ones.

This is a deliberately exploratory, possibly-expensive workflow. Cost is acceptable
**only because every deployed stack is deleted and verified gone** — see "Cleanup is
non-negotiable", which is enforced by a gate, not by trust.

## Core principles

1. **Many-people-hit beats niche.** Prioritize the resources/configs a large
   fraction of CDK users deploy every day — S3 (encryption/lifecycle/CORS/
   intelligent-tiering), Lambda (arm64/env/tracing/reserved-concurrency/
   FunctionUrl/logGroup), VPC (subnets/NAT/routes/endpoints), DynamoDB, IAM, API
   Gateway, ECS/Fargate, RDS, SQS/SNS, CloudFront — over exotic edge cases. A bug
   in a daily pattern is worth ten niche ones.
2. **The two signals ARE the priority — hunt FP and FN above all else.** False
   positives (drift reported that isn't real) and false negatives (real drift
   missed) are the bug classes this hunt exists to find; they are what actually
   damages a user's trust in the tool. Prioritize provoking and confirming them over
   incidental findings (a crash, a read-gap `skipped=`, cosmetic output) — those are
   worth noting, but FP/FN are the target. A freshly deployed stack with NO
   out-of-band change is the cleanest oracle:
   - **False positive (FP)** — the most user-damaging class. After `record`, a
     `check` MUST be CLEAN. Any `declared`-tier drift on a clean recorded stack
     means cdkrd's declared template value normalizes differently from the live
     value (a normalization / default-folding bug). `record` snapshots only the
     UNDECLARED dimension, so a surviving post-record drift is necessarily a
     declared-dimension FP — exactly the class worth catching. **The invariant
     (see CLAUDE.md / DESIGN.md): a clean, un-mutated deploy must show ZERO
     `[Potential Drift]` on a `check` BEFORE `record`, too.** Every value AWS
     assigns at creation that the template never declared is an initial/default,
     not a divergence — so it MUST fold to `atDefault`. `[Potential Drift]` is only
     ever a REAL divergence (a user change, or an AWS out-of-band change AFTER
     creation like Application Signals adding IAM perms). So `check`-before-`record`
     on a fresh fixture and read the `[Potential Drift]` list: **every entry there
     is a fold gap = a bug** (the FP the check-output note + issue link ask users to
     report). When a candidate default's status is uncertain, **RESOLVE it by
     verifying** what AWS assigns to a fresh minimal config — never leave it
     surfaced as "conservative", that just ships the bug. Fold via equality-gated
     `KNOWN_DEFAULTS` (folds the default, surfaces a change away — detection kept)
     for mutable meaningful props; value-independent only for create-only /
     AWS-assigned identifiers / cosmetic values.
   - **False negative (FN) / missed detection** — `record`→`check`→CLEAN does NOT
     exercise detection. So ALSO mutate a **declared, MUTABLE** property out of band
     (the "someone changed it in the console" scenario — Lambda `MemorySize`/
     `Timeout`, SQS `VisibilityTimeout`) and assert `check` DETECTS it (exit 1),
     then `revert` restores it, then `check` is CLEAN. Pick a MUTABLE property:
     create-only/immutable ones (Subnet AZ, NAT AllocationId) can't drift.
3. **Check coverage first.** Before building anything, `grep` the existing fixtures
   so you hunt in genuinely-uncovered territory:
   ```bash
   grep -rln "Kinesis\|Dashboard\|Secret\|intelligentTiering\|FunctionUrl" tests/integration/*/app.ts
   ```
   Empty hits = untested = good hunting ground.
4. **Probe CC support BEFORE an expensive deploy — skip the CC-gap tail.** For a
   high-cost or slow stateful/niche type (RDS-family, OpenSearch, MSK, Neptune,
   DocumentDB, Cloud Map, …), first check whether Cloud Control can even READ it —
   the FP/FN hunt only has traction on **CC-readable** types (where AWS's live model
   diverges from the template by normalization). If the type's CC read throws
   `UnsupportedActionException`, every resource comes back `skipped=N` (surfaced
   transparently in the `info:` footer — NOT a false negative): a clean `record`→
   `check` is hollow and a detect is invisible because the resource was never read.
   Such a type yields **zero FP/FN bugs** and has **no regression value as a fixture**
   — it is an `SDK_OVERRIDES` reader candidate (a separate feature task), not a hunt
   target. So do NOT burn a paid deploy on it. Confirm support first:

   ```bash
   aws cloudformation describe-type --type RESOURCE --type-name AWS::Foo::Bar \
     --query 'ProvisioningType'   # FULLY_MUTABLE/IMMUTABLE = provisionable; then probe READ:
   # if you have a live instance, `cloudcontrol get-resource` — UnsupportedActionException = CC-gap
   ```

   (Confirmed CC-gap this way: ServiceDiscovery HttpNamespace+Service, DocumentDB
   DBCluster/DBInstance, AppSync ApiKey/GraphQLSchema — all `SDK_OVERRIDES` candidates,
   not hunt targets.)

   **A `read` handler being present is NOT enough — also check the
   `primaryIdentifier` ARITY.** A type can have a CC `read` handler yet still be
   silently `skipped` with a `ValidationException` (a DIFFERENT read-gap class than
   `UnsupportedActionException`) when its `primaryIdentifier` is COMPOSITE (more than
   one segment) but its CFn physical id is only the CHILD segment — Cloud Control
   `GetResource` then rejects the bare id. This is a `CC_IDENTIFIER_ADAPTERS` fix
   (derive the `parent|child` / `child|parent` composite from the resolved declared
   Ref), NOT an `SDK_OVERRIDES` one. Probe it offline before deploying:

   ```bash
   aws cloudformation describe-type --type RESOURCE --type-name AWS::Foo::Bar \
     --query 'Schema' --output text | python3 -c "import json,sys; s=json.load(sys.stdin); print(s['primaryIdentifier'])"
   ```

   `primaryIdentifier` length > 1, the type is CC-`read`-able, it is NOT already in
   `CC_IDENTIFIER_ADAPTERS` / `SDK_OVERRIDES`, and the CFn `Ref` returns only the
   child segment → a likely declared-read gap worth a (cheap) deploy to confirm the
   exact composite order (the order is unreliable to guess — verify live, e.g. with
   `aws cloudcontrol get-resource`). Confirmed this way: Logs SubscriptionFilter
   (`FilterName|LogGroupName`, PR #344).

5. **Predict FP classes from the fold allowlists, then audit them OFFLINE before any
   paid deploy.** The per-type fold tables in `src/normalize/noise.ts` ARE the inventory
   of FP classes already found — and most are CURATED, KNOWN-INCOMPLETE allowlists
   (`CASE_INSENSITIVE_PATHS`, `VERSION_PREFIX_PATHS`, `UNORDERED_ARRAY_PROPS` /
   `UNORDERED_OBJECT_ARRAY_PROPS` / `UNORDERED_NESTED_OBJECT_ARRAY_PATHS`,
   `RATE_EXPRESSION_PATHS`, `EPOCH_HOUR_PATHS`, `TRAILING_DOT_PATHS`). Each lists only
   the 1–2 types someone already hit; **any OTHER type sharing that semantic divergence
   is an unguarded gap.** So you can PREDICT where FPs hide instead of deploying blind:
   - The recurring FP-generating axes (AWS live value ≡ declared value but ≢ structurally):
     **set-like array reorder** (DNS RecordSet values, Cognito URL/OAuth lists, WAF
     sets, SG rules), **partial→concrete version** (`*Version`/`EngineVersion`/
     `KafkaVersion` a service expands), **case-insensitive enum** (`*Type`/`*Protocol`/
     `*Status`), **trailing/format normalization** (FQDN dot, ARN `:*`, rate(), epoch),
     **object↔JSON-string shape** (a `Definition`/`Content`/policy declared as object,
     read back as string). Suspect any prop named `*Version`/`*Type`/`*Protocol`/
     `*Status`/trailing-`Name`(FQDN)/`*Arn`/`Schedule*`/map-type/order-insensitive array.
   - **Audit the gap OFFLINE first (free).** For each candidate, read the allowlist to
     see what's covered, then grep `tests/corpus/*.json`: compare `resource.declared` vs
     `liveRaw` for the prop. If a recorded live read EXHIBITS the divergence and
     `expected` is clean → the trigger is already covered+guarded (`corpus-replay` proves
     it), skip it. If no corpus case exercises the trigger (e.g. a RecordSet case with
     only ONE value never tests multi-value reorder), or the service can't even produce
     the divergence (MSK rejects a partial version → declared==live, NO risk) → that
     determination is the deliverable. Only deploy the genuine, reproducible gaps. This
     ruled out a whole class and ~10 wasteful deploys in the PR #303 hunt — fan out
     parallel read-only agents (one per class) to do the audit. The fix for a confirmed
     gap is usually a one-line allowlist addition + the unit test + corpus case.
6. **Parallelize, but cap at 3–4 stacks.** Independent stacks (unique names) can
   deploy concurrently as background tasks, but more is not better — it makes logs
   and teardown hard to follow. VPC/NAT (~3 min) pace a wave; most others ~1–2 min.

## Workflow

### 1. Worktree + build

Per CLAUDE.md, never work in the main checkout:
`git worktree add .worktrees/<name> -b wt-<name> main` →
`mise trust .worktrees/<name>/.mise.toml` → `pnpm install` → `vp run build` (the CLI
runs from `dist/`).

### 2. Scaffold fixtures + ARM the cleanup gate

Add fixtures under `tests/integration/<name>/` — mirror an existing one (`app.ts` +
`cdk.json` + `package.json` + `verify.sh`). A clean-FP `verify.sh` is: deploy →
`record --yes` → `check --fail` MUST exit 0. Run `npm install` then `cdk synth` for
all fixtures in parallel FIRST (cheap, catches TS errors before any paid deploy).

**Before deploying, record every stack you are about to deploy into the sentinel —
this arms the cleanup gate:**

```bash
.claude/skills/hunt-bugs/bughunt-track.sh add CdkRealDriftIntegS3Rich CdkRealDriftIntegVpcCommon ...
```

### 3. Deploy (parallel, capped) + check

Run the `verify.sh` set in parallel (≤3–4). Each `verify.sh` MUST have a cleanup
`trap` that runs `delstack cdk -a cdk.out -r "$REGION" -f -y` (NOT `cdk destroy` —
see CLAUDE.md) on EXIT, so even a failed run deletes its stack. Triage every
`result:` that is not CLEAN, and scan the `info:` footer: a `skipped=` on a COMMON
type is a read-gap many users hit (an SDK-override candidate); an `unresolved=`
points at declared values whose intrinsics cdkrd couldn't resolve.

### 4. Test detection (the FN half)

For at least one common type, mutate a declared MUTABLE property out of band and
assert `check` detects → `revert` → `check` CLEAN → live value restored
(`lambda-rich/verify-detect.sh` is the reference).

**When your FP fix ADDS a `KNOWN_DEFAULTS` fold for a MUTABLE prop AWS assigns,
live-test the REVERT of that value too — not just detection.** Mutate the folded
prop to a NON-default (it must re-surface, proving the equality-gate still detects an
out-of-band change), then `revert` and confirm the live value actually returns to the
default. Some providers IGNORE an omitted property on update, so the default `remove`
revert is a SILENT no-op — Cloud Control reports SUCCESS yet the live value persists
(observed on Transfer `UpdateServer` / `SecurityPolicyName` #597, IAM
`MaxSessionDuration`, Lambda Alias `Description`, Cognito `AllowClassicFlow`). The fix
is to add `${resourceType}\0${path}` to `REVERT_SET_DEFAULT_PATHS`
(`src/revert/plan.ts`) so revert writes the `KNOWN_DEFAULTS` default EXPLICITLY and
converges — otherwise you ship a revert that claims success but leaves the value
unchanged.

### 5. Harvest the live read into the golden corpus (EVERY round — bug or not)

This is the asset a hunt leaves behind even when it finds no bug. Every live read
you just paid for is a real `normalize`→`classify` pipeline input; capturing it as
a golden-corpus case turns this one-time deploy into a permanent **offline**
regression that runs in plain `vp run test` (no AWS) forever — `tests/corpus/*.json`
is replayed by `tests/corpus-replay.test.ts`, which re-runs `classifyResource` on
the recorded inputs and asserts the findings reproduce exactly (R63). A future
normalization change that would silently re-introduce an FP/FN on this resource
then fails a unit test instead of waiting for the next paid hunt.

So while a tracked stack is still deployed, record the corpus by setting
`CDKRD_CORPUS_DIR` on a `check` (it writes one sanitized case per readable
resource — account ids are stripped at record time):

```bash
CDKRD_CORPUS_DIR=/tmp/corpus-<name> node "$ROOT/dist/cli.js" check "$STACK" --region "$REGION"
```

Record on the FRESH deploy BEFORE `record` (no baseline) so the case captures the
full classification — the `atDefault`/undeclared folding, not a baseline-snapshotted
clean. Then promote the cases that add coverage into `tests/corpus/`:

- Each file is named `AWS__<Service>__<Type>.<LogicalId>.json`. Copy in the cases
  for types **not already present** — `ls tests/corpus/ | grep <Type>` first.
  Genuinely-new resource types are the win; skip near-duplicates of types already
  covered (VPC/subnet/route-table boilerplate a fixture drags along is usually
  already represented — don't flood the corpus with it).
- Run `vp run test` and confirm the new `corpus-replay` cases pass. Commit the new
  corpus JSONs in the SAME PR as the fixture (and the fix, if any). An intended
  behavior change updates a case's `expected` in the same diff, making the semantic
  change reviewable.

The `*-rich` fixtures are exactly the rich configs worth pinning this way, so a
clean round still ships growing regression coverage — see the "A clean result IS a
result" gotcha.

### 5.5 First-run-noise sweep (shrink `[Not Recorded]` via KNOWN_DEFAULTS)

After promoting new corpus, run the offline first-run-noise sweep — the newly
harvested cases are exactly the fresh data it mines:

```bash
bash scripts/measure-noise.sh
```

It replays classify over `tests/corpus/*.json` and ranks every `undeclared`
`(type, path)`, flagging the constant-looking ones as `CANDIDATE`s to promote into
`KNOWN_DEFAULTS` (top-level) / `KNOWN_DEFAULT_PATHS` (nested) in
`src/normalize/noise.ts`. This matters because the CFn schema annotates a `default`
on only ~1% of properties (see `scripts/measure-schema-defaults.mjs` and
docs/ARCHITECTURE.md § 6), so these hand tables — not the schema — are what keeps a
first run's `[Not Recorded]` inventory small. Promote a candidate only when its
value is a genuine CONSTANT service default (not a per-resource id/ARN/name/AZ/window
the heuristic may over-flag); the fold is equality-gated, so a correct promotion can
never hide a real change, and a recorded value that later moves off the default
still surfaces. Add the entries + a `noise-and-strip` test in the SAME PR. This is a
quality/noise pass, not a bug — skip it on a round that ships no new corpus.

### 6. On a confirmed bug: fix it — with a unit test (mandatory)

When a finding is a real bug:

1. **Root-cause it** in `src/` (normalize / diff-classify / read-router / overrides
   / intrinsic-resolver / report — wherever the divergence-from-reality lives).
2. **Fix it in the worktree.**
3. **Add a unit test that fails without the fix and passes with it.** This is
   mandatory, not optional — a bug found by integ MUST leave behind a unit test that
   pins the corrected behavior, so the regression can never come back silently
   (integ alone is too slow/expensive to be the only guard). Re-run `vp run build` +
   `vp run test`.
4. **Re-run the live repro with the fixed binary** to confirm the real-AWS behavior
   is now correct.
5. **Keep the fixture** as a committed regression integ under
   `tests/integration/<name>/`, in the SAME PR as the fix — never defer the integ.
6. **If the bug is a CLASS, prove it's closed for EVERY affected type — don't stop
   at the one resource you happened to hit.** Most real bugs here are not specific
   to the type that surfaced them: they live in shared code keyed on a schema flag
   or a normalizer applied to many types (e.g. #252 — a property that is BOTH
   write-only and create-only was re-included into a Cloud Control patch and
   rejected; found on ElastiCache, but RDS / DynamoDB / EC2 / Redshift / S3 / EFS …
   all have such properties). When the root cause generalizes:
   - **Map the blast radius.** Enumerate which other types/properties share the
     trigger — e.g. `aws cloudformation describe-type --type RESOURCE --type-name
<T> --query Schema` and compute the relevant intersection across common types.
     Name them in the PR so the coverage is visible.
   - **Add a DATA-DRIVEN invariant test, not just a per-type one.** A hand-built
     single-type unit test proves the symptom is gone for ONE shape; it does not
     prove no oversight elsewhere. Drive the test from the golden corpus's REAL
     schemas: load every `tests/corpus/*.json` (via `reviveSchema`), reproduce the
     trigger for each, and assert the invariant holds for ALL of them. The corpus
     already spans ~17 real types, and the test self-extends as the corpus grows —
     a far stronger guard than enumerating types by hand. (`tests/revert-plan.test.ts`
     `create-only invariant over all real corpus schemas` is the reference.)
   - **Confirm it fails without the fix and passes with it**, like any regression
     test — then you have proof the whole class is closed, not just one instance.
   - This pairs with step 5's corpus harvest: harvesting rich cases during hunts is
     what makes the corpus a strong enough substrate to drive these invariants.

### 7. Cleanup — non-negotiable (see below), then ship

Delete every tracked stack, run `bughunt-track.sh verify`, then `clear`. Then
`/check` + `/check-docs` markers → commit → push → `/verify-pr` → `gh pr create`.

### 8. Merge + remove the worktree

Take it all the way to merged — do not leave a green PR hanging:

1. `gh pr merge <#> --squash --delete-branch` (the remote branch). If CI is down
   for billing, `--admin` after confirming the local gates passed.
2. **Remove the worktree** — a hunt always creates one (`.worktrees/<name>`), and a
   left-behind worktree is the silent residue of this flow. From the MAIN checkout:
   `git worktree remove .worktrees/<name>` (add `--force` if it refuses on
   leftover build artifacts), then `git branch -D wt-<name>` if the branch lingers,
   and `git worktree prune`. Confirm with `git worktree list` — only the main
   checkout should remain. (Mirror of CLAUDE.md's integrate-then-remove rule.)

### 9. Record what you learned

Save a memory for any recurring surprise (a whole _class_ of latent bug, a
verification gotcha) so the next sweep starts smarter.

## Cleanup is non-negotiable (gate-enforced)

Forgetting to delete bug-hunt stacks is the one unacceptable outcome, so it is
enforced structurally rather than by discipline:

- `bughunt-track.sh add <stacks...>` writes the deployed stack names to the
  gitignored sentinel `.markgate-bughunt-pending`.
- The `bughunt-clean-gate` PreToolUse hook (`.claude/hooks/bughunt-clean-gate.sh`)
  **blocks `git commit`, `gh pr create`, and `gh pr merge` while that sentinel is
  non-empty** — so you physically cannot land the fix PR (or any commit) until the
  bug-hunt stacks are deleted and verified gone.
- `bughunt-track.sh verify` asserts each tracked stack is GONE from CloudFormation
  AND `sweep-orphans.sh` reports SWEEP CLEAN, and on success STAMPS the verified
  pending set; `bughunt-track.sh clear` empties the sentinel (releasing the gate)
  and REFUSES without a stamp matching the current pending set — "verify passed
  first" is enforced structurally, not by shell plumbing (a piped
  `verify | tail && clear` once chained a clear onto a FAILED verify because the
  pipeline's exit was tail's). Run `verify` and `clear` as separate, un-piped
  commands from the SAME directory (the owner key is cwd-derived — a cwd that
  drifted back to the main checkout arms/clears the WRONG owner).

`delstack` only deletes stack MEMBERS. `sweep-orphans.sh` catches the
stack-EXTERNAL orphans teardown leaves behind — auto-created `/aws/lambda/*` log
groups (notably from S3 `autoDeleteObjects` custom-resource Lambdas), RETAIN
stateful resources, Secrets in recovery, KMS keys pending deletion. Do NOT delete
the sentinel by hand to bypass the gate.

## Gotchas (learned the hard way — keep current)

- **`record` hides undeclared FPs.** A `record→check→CLEAN` fixture only proves the
  DECLARED dimension is FP-free; undeclared mis-classification is snapshotted away.
  To probe it, `check` BEFORE record and read the `atDefault`/`unresolved`/`[Not
Recorded]` breakdown with `--verbose`.
- **Immutable props can't drift.** Don't treat an `unresolved`/unverifiable
  create-only property (Subnet `AvailabilityZone` via `Fn::Select(Fn::GetAZs)`, NAT
  `AllocationId` via `Fn::GetAtt` EIP) as a bug — it's correctly classified. And
  don't "fix" it by resolving `Fn::GetAZs`: AZ ordering differs from
  `DescribeAvailabilityZones`, risking an FP, for zero detection benefit.
- **`set -e` aborts inline multi-step bash.** An interactive shell with `set -e`
  stops a one-off inline script right after a `check --fail` that exits 1. Put the
  detect→revert→re-check sequence in a standalone `verify.sh` (with explicit
  `|| fail`), or guard with `set +e`.
- **Always `npm install` + `cdk synth` before deploy** — a synth-time TS error is
  free to catch; a half-failed deploy is not.
- **`example.com` / `.test` / `.example` are AWS-RESERVED for Route53 hosted zones**
  (`InvalidDomainNameException` on create). A Route53 fixture must use a non-reserved
  placeholder domain (e.g. `cdkrd-fphunt-x9z7q.com.`) — a public hosted zone for a
  domain you don't own still creates fine (it just isn't authoritative).
- **Not every type is revertable — the FN half may stop at detection.** Route53
  RecordSet, for instance, has no SDK writer (`revert` says "type not revertable
  yet"), so a detect→revert→clean cycle can't complete. Prove the FN by mutating the
  declared value out of band (e.g. `aws route53 change-resource-record-sets`) and
  asserting `check --fail` exits 1, then restore it manually; note the revert gap as a
  future `SDK_WRITERS` candidate rather than treating it as a regression.
- **A clean result IS a result — but it must still leave an asset.** "6 common+rich
  stacks, zero FPs, detection+revert verified" is a legitimate, valuable outcome. Do
  NOT manufacture a fix to have something to show. The deliverable of a bug-free
  round is the committed `*-rich` fixtures PLUS the golden-corpus cases harvested
  from their live reads (step 5) — that is how a clean round still grows permanent
  offline regression coverage instead of evaporating when the stacks are torn down.
- **Before salvaging leftover fixtures from an interrupted worktree, check for an
  already-merged duplicate.** A half-finished prior hunt can leave uncommitted
  fixtures in a stale worktree, and resuming them is tempting — but a PARALLEL
  session may have already merged the identical dirs under a differently-ordered PR
  title (this flow's `ecr-rich`/`kinesis-rich`/`secrets-rich` salvage collided with
  the already-merged `#248 "kinesis-rich, secrets-rich, ecr-rich"`). Run
  `gh pr list --state merged --search "<type-name>"` AND
  `git ls-tree -d --name-only origin/main tests/integration/ | grep <name>` for the
  fixture names FIRST — before any paid re-deploy — and abort if they already exist.
  A clean abort (remove the worktree; the AWS side was already swept) beats burning a
  deploy on a duplicate PR that will only conflict.

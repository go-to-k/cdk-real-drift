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
     declared-dimension FP — exactly the class worth catching.
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
4. **Parallelize, but cap at 3–4 stacks.** Independent stacks (unique names) can
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

### 5. On a confirmed bug: fix it — with a unit test (mandatory)

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

### 6. Cleanup — non-negotiable (see below), then ship

Delete every tracked stack, run `bughunt-track.sh verify`, then `clear`. Then
`/check` + `/check-docs` markers → commit → push → `/verify-pr` → `gh pr create`.

### 7. Merge + remove the worktree

Take it all the way to merged — do not leave a green PR hanging:

1. `gh pr merge <#> --squash --delete-branch` (the remote branch). If CI is down
   for billing, `--admin` after confirming the local gates passed.
2. **Remove the worktree** — a hunt always creates one (`.worktrees/<name>`), and a
   left-behind worktree is the silent residue of this flow. From the MAIN checkout:
   `git worktree remove .worktrees/<name>` (add `--force` if it refuses on
   leftover build artifacts), then `git branch -D wt-<name>` if the branch lingers,
   and `git worktree prune`. Confirm with `git worktree list` — only the main
   checkout should remain. (Mirror of CLAUDE.md's integrate-then-remove rule.)

### 8. Record what you learned

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
  AND `sweep-orphans.sh` reports SWEEP CLEAN; `bughunt-track.sh clear` empties the
  sentinel (releasing the gate) and is meant to be run ONLY after that passes.

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
- **A clean result IS a result.** "6 common+rich stacks, zero FPs, detection+revert
  verified" is a legitimate, valuable outcome. Do NOT manufacture a fix to have
  something to show.
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

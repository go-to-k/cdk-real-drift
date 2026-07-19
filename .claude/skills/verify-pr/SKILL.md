---
name: verify-pr
description: Comprehensive pre-release verification. Run quality checks, docs consistency, a live-test of changed behavior, and a short retrospective before tagging a release.
---

# Pre-Release Verification

Heavy verification gate — a **pre-release** readiness check, not a per-PR gate
(per-PR verification is `/check` + `/check-docs` + CI on the pull request). Run
it before cutting a release. This skill is a superset of `/check` +
`/check-docs` plus the real-AWS integration fixtures, a live-test, and a
retrospective.

## Checklist

Run each check and report pass/fail:

0. **Pre-flight**: confirm `node_modules/` exists in the cwd:

   ```bash
   [ -d node_modules ] || pnpm install
   ```

   A fresh `git worktree add` does NOT copy `node_modules`, so the quality
   checks below would fail with `tsc: command not found` / `Cannot find package
'vitest'`. Do not start step 1 until this passes.

1. **Code quality** (the `/check` logic)
   - `vp run typecheck` passes
   - `vp check --fix` passes (lint + format; use this, not `lint:fix` — see
     `/check`)
   - `vp pack` succeeds. **Invoke `vp pack` DIRECTLY, not `vp run build`** — the
     `run`-task wrapper caches and can REPLAY a stale `dist/`, which has caused a
     false-negative live-test (step 6 ran an old binary lacking the change).
   - When piping to `tail` / `head` / `grep`, check the actual output for
     `Error` / `Command failed` — `$?` after a pipeline reflects the last stage,
     not the build tool. When in doubt: `vp <cmd> > /tmp/out 2>&1; rc=$?; tail -3 /tmp/out; echo "[rc=$rc]"`.

2. **Tests**
   - `vp test run` — all unit tests pass; report file + test counts. **Invoke
     `vp test run` DIRECTLY, not `vp run test`** (same cache-replay foot-gun).
   - **Coverage of changes**: compare `git diff HEAD~5 --name-only` for `src/`
     vs `tests/`. If logic was added/changed in `src/` with no corresponding test
     added/updated, flag as **fail** and add the missing tests before proceeding.

3. **Working tree**
   - `git status` — note any uncommitted changes (lint/doc fixes from this run
     should be committed at the end).

4. **Documentation consistency** (the `/check-docs` logic)
   - Verify README.md / DESIGN.md / docs/ match the code changes: stale flag
     names, command list vs `src/cli.ts`, "not revertable" claims vs the actual
     `SDK_WRITERS` map. Fix any discrepancy.

5. **Code review**
   - `git diff HEAD~5` — read the diff. For each change: is it correct? complete?
     necessary?
   - Check for logic errors / unhandled edge cases, unnecessary changes (dead
     code, unrelated edits), and inconsistencies between changed files.
   - If a shared helper changed, list its importers (`grep -rl` under `src`/
     `tests`) and confirm the new behavior is correct for each.

6. **Live-test changed behavior (per-PR, collision-safe)**
   - Unit tests verify code correctness; this verifies _feature_ correctness
     against the runtime the user actually sees.
   - Build the latest source: `vp pack` (DIRECTLY — not `vp run build`, whose
     cache can replay a stale `dist/` and make this live-test exercise an old
     binary).
   - Scope the live-test to THIS PR's change, not the whole product:
     - CLI surface change → `node dist/cli.js <check|accept|revert> <args>` (e.g.
       `node dist/cli.js --help`, or against a synthesized `cdk.out` /
       `.cdkrd/baselines/<stack>.<region>.json` baseline fixture); verify each output mode
       (`--json` / `--show-all` / `--fail-on` / `--dry-run`).
     - Library change → run a minimal repro importing the new code path.
     - A classify / fold / FP-fix change → the real harvested **corpus** case is
       authoritative live data: `vp test run corpus-replay` reproduces the fold on
       the recorded live model offline. If the fix was **live-proven in its
       originating hunt** (the issue carries the real repro) and a committed corpus
       case pins it, that IS the live evidence — cite the case + the hunt.
     - Any FRESH real-AWS deploy uses a **UNIQUE stack name** (`…<issue>…` /
       hunt-style), NEVER a shared fixed-name fixture, so it can never collide with
       another agent's live stack or its `delstack -s <name>` teardown.
   - "Tests passed" is not "feature works." If you cannot live-test (e.g. no AWS
     credentials and no offline fixture / corpus), say so explicitly rather than skip
     silently, and DO NOT set the `verify-pr` marker — let the human decide.

7. **Shared-name CORE integration suite (real AWS) — release-window gated (R50)**
   - The core suite under `tests/integration/` (`basic/verify.sh`,
     `basic/verify-deleted-guards.sh`, `basic/verify-vs-cdk-drift.sh`, `iam`,
     `lambda`, `revert`, `policies`) uses **hardcoded stack names**
     (`CdkdriftIntegBasic`, …). Two agents running it concurrently deploy the SAME
     CloudFormation stack in one account and each teardown deletes the other's live
     stack — so it must NEVER run concurrently with another live suite.
   - **Acquire a GLOBAL CLEAN WINDOW first**: confirm no other agent is mid-live-run
     (no active hunt/verify-pr worktree, the shared core stacks absent) before
     starting. If a window can't be acquired, do NOT start — wait or defer.
   - **When it applies**: required for a change to the core `check`/`revert` HOT PATH
     that is NOT already covered by a committed corpus case (a new SDK reader/writer,
     a pipeline/normalize change with no golden replay). Each must print `INTEG PASS`.
   - **When it may be DEFERRED (log it explicitly)**: a PR whose diff is fully
     covered by unit tests + a real-corpus **replay** AND was **live-proven in its
     originating hunt** may set the `verify-pr` marker WITHOUT re-running the shared
     suite — step 6's per-PR live evidence stands in. State the deferral in the PR /
     report ("core suite deferred — offline+corpus+hunt-verified; not re-run") so the
     skip is visible, never silent. The suite still runs at the next clean-window
     release verification. If credentials are absent, say so and let the human decide.
   - **Sweep the orphans the suite ALWAYS leaves** (only when it was actually run).
     The `basic`/`revert` fixtures' S3 `autoDeleteObjects` custom-resource Lambdas
     auto-create `/aws/lambda/*CustomS3AutoDeleteObjects*` log groups that stack
     deletion does NOT remove — ~4 per run. After the fixtures pass, run:

     ```bash
     AWS_REGION=us-east-1 bash tests/integration/sweep-orphans.sh --delete
     AWS_REGION=us-east-1 bash tests/integration/sweep-orphans.sh   # must print SWEEP CLEAN
     ```

     Do not set the `verify-pr` marker while the re-run reports orphans.

8. **Retrospective + rules update**
   - Walk back over the session that produced this change. For each surprise,
     friction, or correction, ask: "one-off, or a recurring pattern?"
   - For each pattern, propose where it should be reflected so it doesn't recur:
     - **Hook** — mechanically detectable foot-gun (strongest enforcement).
     - **Skill / marker** — a checklist that must run before some action.
     - **Memory** — judgmental ("prefer X when Y"); weakest enforcement.
   - Surface the proposals out loud before finishing. Add code/skill/hook
     artifacts in the same change; memory entries land regardless.
   - This retrospective is itself covered by the `verify-pr` marker — skipping it
     means the marker is set on incomplete work.

## Output

Present results as a table:

| Check                          | Result                    |
| ------------------------------ | ------------------------- |
| typecheck                      | pass/fail                 |
| lint + format                  | pass/fail                 |
| build                          | pass/fail                 |
| tests (N files, M tests)       | pass/fail                 |
| test coverage for changes      | pass/fail                 |
| working tree                   | clean/dirty               |
| docs consistency               | pass/fail                 |
| code review                    | pass/issues found         |
| live-test changed behavior     | pass/skipped/issues found |
| shared CORE suite (7)          | pass/deferred/skipped     |
| retrospective + rule proposals | done/skipped              |

If all pass, confirm "Ready to release."
If any fail, list the issues to fix.

## Final Step

After all checks pass, record THREE markers via
[markgate](https://github.com/go-to-k/markgate). `/verify-pr` is a superset of
`/check` (code correctness) and `/check-docs` (docs consistency) plus live-test
and retrospective — so its success implies all three. cdkrd's `verify-pr` gate is
declared `requires: [check, docs]` (an AND of the two children), so set the
children first, then the parent. Use `mise exec` to avoid PATH issues:

```bash
mise exec -- markgate set check
mise exec -- markgate set docs
mise exec -- markgate set verify-pr
```

The `verify-pr` marker is intentionally settable ONLY by this skill — setting it
by hand to bypass the gate defeats the point. If a check legitimately cannot pass
right now (e.g. live-test needs AWS credentials that are absent), say so in the
report and DO NOT set the marker.

Then, if there are uncommitted changes (lint fixes, doc updates from this run),
commit them on a feature branch. Skip the marker + commit step if any check
failed.

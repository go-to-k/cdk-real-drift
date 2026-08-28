---
name: verify-pr
description: Comprehensive PR-readiness verification. Run quality checks, docs consistency, a live-test of changed behavior, and a short retrospective before opening or merging a PR.
---

# PR-Readiness Verification

Heavy verification gate, and a **pre-PR** one:
`.claude/hooks/verify-pr-gate.sh` blocks `gh pr create` and `gh pr merge` until
this skill has set the `verify-pr` marker. This skill is a superset of `/check` +
`/check-docs` plus the real-AWS integration fixtures, a live-test, and a
retrospective.

**Exemption:** a PR whose diff touches no `src/**` (docs / tooling only) carries
no runtime behavior to live-test, and the gate lets it through on the `check` +
`docs` markers alone — so `/check` + `/check-docs` + CI is the whole per-PR
requirement there. The hook computes this from the branch's diff against
`origin/main` and fails CLOSED — it exempts only when it can prove the diff is
src-free, so run this skill whenever it does ask for it.

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
   - **Coverage of changes**: compare
     `git diff --name-only "$(git merge-base origin/main HEAD)"` for `src/`
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
   - `git diff "$(git merge-base origin/main HEAD)"` — read the PR's whole diff.
     For each change: is it correct? complete? necessary?
   - Check for logic errors / unhandled edge cases, unnecessary changes (dead
     code, unrelated edits), and inconsistencies between changed files.
   - If a shared helper changed, list its importers (`grep -rl` under `src`/
     `tests`) and confirm the new behavior is correct for each.
   - **Re-derive the review DEPTH at the FINAL sha, not at the first commit.**
     Depth is a function of the diff, and the diff GROWS across fix-back rounds
     while the depth decision, made once, does not. There is no reviewer tier
     here to recompute — this repo ships no multi-agent reviewer set and no
     `/review-pr` skill (CLAUDE.md keeps `pr-review` UNPORTED because cdkrd is
     solo), and `.markgate.yml` keeps that gate INERT and UNWIRED — so what gets
     frozen is your own call: how closely to read, and which read-only
     reviewers to dispatch — not WHETHER to, which `/work-issues` §8 settles:
     an independent round is owed even when the lane already ran one, because a
     lane's reviewers inherit the premise the lane handed them (§8 also covers
     what to do when two of them contradict each other). Nothing re-opens the
     depth call mechanically. A stale marker is not that
     forcing function either, and it is easy to mistake for one: a `.claude/**`
     fix round DOES stale `check`, which covers `.claude/skills/**` and — since
     go-to-k/cdk-real-drift#1837 — `.claude/settings.json`, `.claude/hooks/**`,
     `.markgate.yml`, `scripts/**`, `.github/workflows/**` and every
     hand-written `.md` alongside `src/**` / `tests/**`. So does a docs-only
     round. But what that buys is a re-run of typecheck / lint / build / tests,
     never a re-derivation of the depth. Measured in cdk-local on 2026-08-27
     (go-to-k/cdk-local#609): tiered from its first commit at 819 LOC / 5 files
     and given ONE reviewer, its fix round took it to 1342 LOC, and it merged at
     1466 added lines across 5 files (`gh pr view 609 -R go-to-k/cdk-local
--json additions,changedFiles`, re-derived 2026-08-28). The spec and test
     reviewers added only after re-computing found a live order-blind fail-open
     in the new code plus two wrong counts in the PR body — neither inside the
     single code reviewer's remit. So re-measure with
     `git diff --stat "$(git merge-base origin/main HEAD)"` after the LAST fix
     round and re-decide, rather than carrying the first round's call forward.
   - Then say the tree is FINAL when it is, and batch the remaining findings into
     ONE round — an agent handed findings will otherwise fix, verify and hand
     back, which re-runs whatever the next step costs (here step 7's shared-name
     suite, and the `integ` gate's `hash: diff` marker, which a comment-only
     change to an in-scope file still stales). `/work-issues` §8 records what
     skipping that cost.

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

If all pass, confirm "Ready to open / merge the PR."
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

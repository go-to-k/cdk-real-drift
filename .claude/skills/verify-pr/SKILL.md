---
name: verify-pr
description: PR-readiness verification — quality checks, docs consistency, a live-test of the changed behavior, and a short retrospective before opening or merging a PR.
---

# PR-Readiness Verification

Recommended before `gh pr create` / `gh pr merge`: a superset of `/check` and
`/check-docs` plus a live-test and a retrospective. Nothing records that it ran
— the mechanical merge conditions are the `main` ruleset's required status
checks (server-side, zero bypass actors) and a clean bug-hunt sentinel
(`bughunt-clean-gate`). A PR touching no `src/**` has
nothing to live-test: `/check` + `/check-docs` + green CI is the whole
requirement.

## Checklist

0. **Pre-flight**: `[ -d node_modules ] || pnpm install` — `git worktree add`
   does NOT copy `node_modules`, and every check below then fails with
   `tsc: command not found`.

1. **Code quality** (the `/check` steps): `vp run typecheck`, `vp check --fix`
   (lint + format — not `lint:fix`, see `/check`), `vp pack`. Invoke `vp pack`
   DIRECTLY, not `vp run build`: the `run` wrapper caches and can replay a stale
   `dist/`, producing a false-negative live-test in step 6. When piping to
   `tail` / `head` / `grep`, read the OUTPUT for `Error` / `Command failed` —
   `$?` after a pipeline is the last stage's, not the build tool's.

2. **Tests**: `vp test run` (directly, not `vp run test` — same cache
   foot-gun); report file + test counts. Then **coverage of changes**: compare
   `git diff --name-only "$(git merge-base origin/main HEAD)"` for `src/` vs
   `tests/`; changed `src/` logic with no corresponding test is a **fail** —
   add them before proceeding.

3. **Working tree**: `git status` — commit any lint / doc fix this run made.

4. **Docs consistency**: run `/check-docs` ONCE PER PR, at the FINAL sha.

5. **Code review**
   - `git diff "$(git merge-base origin/main HEAD)"` — read the whole diff: is
     each change correct, complete, necessary? Look for logic errors, unhandled
     edge cases, dead code and unrelated edits. If a shared helper changed, list
     its importers (`grep -rl` under `src`/`tests`) and confirm the new behavior
     for each.
   - **Reviewer set**: one `pr-code-reviewer` by default; add
     `pr-spec-reviewer` + `pr-test-reviewer` when the `src/**` diff exceeds 400
     lines or 8 files; add `pr-security-reviewer` on credential /
     role-assumption / revert-write surfaces.
   - **Compute it from the FINAL sha, not the first commit** — the diff GROWS
     across fix-back rounds while a decision made once does not; re-measure with
     `git diff --stat "$(git merge-base origin/main HEAD)"` after the LAST fix
     round. Reviewers run ONCE on that sha, and a fix round is re-checked by
     MESSAGING the same reviewer, never by a fresh dispatch.
   - Declare the tree FINAL and batch remaining findings into ONE round;
     piecemeal findings make the lane fix, verify and hand back each time.

6. **Live-test changed behavior (per-PR, collision-safe)** — passing unit tests
   are not a working feature. Build with `vp pack`, then scope the test to THIS
   PR:
   - CLI surface → `node dist/cli.js <check|accept|revert> <args>` against a
     synthesized `cdk.out` / `.cdkrd/baselines/<stack>.<region>.json`, covering
     each output mode (`--json` / `--show-all` / `--fail-on` / `--dry-run`).
   - Library change → a minimal repro importing the new code path.
   - A classify / fold / FP-fix → the harvested **corpus** is the authoritative
     live data; `vp test run corpus-replay` replays the fold offline. A fix
     live-proven in its originating hunt and pinned by a committed corpus case
     IS live evidence — cite both.
   - Any FRESH real-AWS deploy uses a **UNIQUE stack name** (`…<issue>…` /
     hunt-style), never a shared fixed-name fixture: it must not collide with
     another agent's live stack or its `delstack -s <name>` teardown.
   - If you cannot live-test, say so explicitly rather than skip silently, and
     let the human decide.

7. **Shared-name CORE integration suite (real AWS)**
   - Scope: `tests/integration/` `basic/verify.sh`,
     `basic/verify-deleted-guards.sh`, `basic/verify-vs-cdk-drift.sh`, `iam`,
     `lambda`, `revert`, `policies` — each must print `INTEG PASS`. Required for
     a core `check` / `revert` HOT-PATH change no corpus case covers (a new SDK
     reader/writer; a pipeline / normalize change with no golden replay).
   - Its stack names are **hardcoded** (`CdkdriftIntegBasic`, …), so two
     concurrent agents deploy the SAME stack in one account, each teardown
     deleting the other's. **Acquire a GLOBAL CLEAN WINDOW first**: no other
     agent mid-live-run, shared core stacks absent; with no window, do NOT
     start.
   - **May be DEFERRED** when the PR is fully covered by unit tests + a
     real-corpus replay AND was live-proven in its originating hunt. State it in
     the PR / report so the skip is never silent; the suite runs at the next
     clean-window release verification.
   - **Sweep after any actual run**: the `basic` / `revert` fixtures' S3
     `autoDeleteObjects` Lambdas leave `/aws/lambda/*CustomS3AutoDeleteObjects*`
     log groups that stack deletion does NOT remove.

     ```bash
     AWS_REGION=us-east-1 bash tests/integration/sweep-orphans.sh --delete
     AWS_REGION=us-east-1 bash tests/integration/sweep-orphans.sh   # must print SWEEP CLEAN
     ```

     Not ready while the re-run reports orphans; `/sweep-resources` is the
     fuller path.

8. **Retrospective**: for each surprise, friction or correction, ask "one-off,
   or recurring?" A recurring pattern in the code or docs is fixed in this same
   change; one in the agent TOOLING becomes a line in
   `docs/tooling-backlog.md`, never an issue. Surface them out loud.

## Output

One row per step with a pass / fail / deferred / skipped verdict, then "Ready to
open / merge the PR" or the issues to fix. A check that cannot legitimately run
(absent credentials) is skipped, never passed.

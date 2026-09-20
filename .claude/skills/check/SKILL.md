---
name: check
description: Run local quality checks (typecheck, lint, build, tests). Quick check during development.
---

# Local Quality Check

Run all local quality checks to verify the current state quickly. This is the
LOCAL half of the flow — it runs no real-AWS deploy/destroy — and mirrors the CI
workflow (`.github/workflows/ci.yml`), which runs typecheck / lint+format /
build / unit tests on every push.

## Steps

Run these sequentially and report results:

1. `vp run typecheck` — `tsc --project tsconfig.json --noEmit`.
2. `vp check --fix` — lint + Prettier formatting, with auto-fix. **Use this, not
   `vp run lint:fix`**: CI runs `vp check` (which includes formatting) and
   `lint:fix` does NOT touch formatting, so a `lint:fix`-only run can pass
   locally while CI fails on the same branch.
3. `vp pack` (tsdown ESM bundle to `dist/`) — run it BEFORE step 4: a fresh
   worktree has no `dist/` and the tests that spawn the built CLI fail without
   it. A `dist/` nobody rebuilt is also what makes a live-test a false negative,
   because the binary under test lacks the change.
4. `vp test run` (Vitest unit tests; `tests/integration/**` is excluded by
   `vite.config.ts`). Prefer this direct form over `vp run test`.

When piping any of the above to `tail` / `head` / `grep`, **check the actual
output content** for `Error` / `Command failed` markers — `$?` after a pipeline
reflects the LAST stage (usually 0), NOT the build tool's exit. When in doubt,
capture without piping:
`vp <cmd> > /tmp/out 2>&1; rc=$?; tail -3 /tmp/out; echo "[rc=$rc]"`.

## Output

Report as a table:

| Check                            | Result    |
| -------------------------------- | --------- |
| typecheck (`vp run typecheck`)   | pass/fail |
| lint + format (`vp check --fix`) | pass/fail |
| build (`vp pack`)                | pass/fail |
| tests (N files, M tests)         | pass/fail |

If all pass, confirm "All checks passed." If any fail, show the error output
and STOP.

**Before treating a failure in a file you did NOT touch as a real (or
peer-introduced) `main` regression, rule out a stale worktree cache.** A
long-lived worktree's tsc/oxc cache can REPLAY phantom errors from an earlier
dependency/lockfile state (the inverse of a cache MASKING real ones). If CI on
`main` is green and the failure is outside your diff, REPRODUCE it in a
throwaway fresh worktree (`git worktree add … origin/main` → `pnpm install` →
`vp check`) before reporting "main is red" or opening a fix lane — a clean fresh
worktree means the error was a local cache artifact, not a regression.

---
name: check
description: Run local quality checks (typecheck, lint, build, tests). Quick check during development.
---

# Local Quality Check

Run all local quality checks. Use during development to verify the current state quickly.

cdk-real-drift (cdkrd) is a solo, local-only repo: there is no GitHub remote, no
PR workflow, and no real-AWS deploy/destroy in this gate. This skill mirrors the
CI workflow (`.github/workflows/ci.yml`), which runs typecheck / lint+format /
build / unit tests on every push.

## Steps

Run these sequentially and report results:

1. `vp run typecheck` — `tsgo --project tsconfig.json --noEmit`.
2. `vp check --fix` — lint + Prettier formatting, with auto-fix. **Use this, not
   `vp run lint:fix`**: CI runs `vp check` (which includes formatting), and
   `lint:fix` does NOT touch formatting — so a `lint:fix`-only run can pass
   locally while CI fails with formatting issues on the same branch.
3. `vp pack` (tsdown ESM bundle to `dist/`). **Invoke `vp pack` DIRECTLY, not
   `vp run build`**: the `run`-task wrapper caches and can REPLAY a stale `dist/`
   that does not reflect the current `src/` — a fresh `vp pack` always rebuilds.
   A stale `dist/` has caused a false-negative live-test (a `cdkrd check` ran an
   old binary that lacked the change under test).
4. `vp test run` (Vitest unit tests; `tests/integration/**` is excluded by
   `vite.config.ts`). **Invoke `vp test run` DIRECTLY, not `vp run test`** — same
   cache-replay foot-gun: `vp run test` can replay a stale pass.

When piping any of the above to `tail` / `head` / `grep`, **check the actual
output content** for `Error` / `Command failed` markers — `$?` after a pipeline
reflects the LAST stage (usually 0), NOT the build tool's exit. When in doubt,
capture without piping: `vp <cmd> > /tmp/out 2>&1; rc=$?; tail -3 /tmp/out; echo "[rc=$rc]"`.

## Output

Report as a table:

| Check                            | Result    |
| -------------------------------- | --------- |
| typecheck (`vp run typecheck`)   | pass/fail |
| lint + format (`vp check --fix`) | pass/fail |
| build (`vp pack`)                | pass/fail |
| tests (N files, M tests)         | pass/fail |

If all pass, confirm "All checks passed."
If any fail, show the error output and STOP — do not write the commit-gate marker.

## Commit-gate marker (on success only)

After all four checks pass, record the `check` marker so the markgate `check`
gate is satisfied. The marker captures the current working-tree state of the
gate's scope (`src/**`, `tests/**`, `package.json`, `pnpm-lock.yaml`,
`tsconfig*.json`, `vite.config.ts` — see `.markgate.yml`); any subsequent edit
in that scope invalidates it and requires re-running `/check`.

Run from the repo root (cdkrd pins markgate via mise, so use `mise exec` to
avoid PATH issues when shims aren't active):

```bash
mise exec -- markgate set check
```

Skip this step if any check failed — a stale or missing marker correctly forces
re-running `/check` after fixing the failure.

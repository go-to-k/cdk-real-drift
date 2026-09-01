<!-- Part of the /hunt-bugs skill. Stage files: principles.md (posture / goal / core principles), plan.md (workflow stages 0–2), deploy-and-detect.md (stages 3–4), harvest.md (stages 5–5.5), file-and-fix.md (stage 6), cleanup-and-ship.md (stages 7–9 + the cleanup gate), gotchas.md (appendix). READ THIS FILE IN FULL when your run enters this stage. -->

## Workflow

### 0. Opening offline audits (free — run these BEFORE picking deploy targets)

Every hunt opens with the zero-cost sweeps; they regularly dissolve whole rounds
with zero deploys (2026-07-20) or hand you a confirmed bug before the first
deploy:

- **New-pin off-flip audit over the diff window since the last hunt** — the step
  that found the Budgets CostTypes FN (go-to-k/cdk-real-drift#1675). New truthy boolean pins arrive not
  only from hunts but from READER-projection fixes (go-to-k/cdk-real-drift#1658 shipped a 9-leaf all-true
  family with no off-state gate), so scan what LANDED, not just the historical
  tables:
  ```bash
  git log --since=<last-hunt-date> --oneline -- src/normalize/noise.ts src/diff/classify.ts
  git diff <last-hunt-commit>..HEAD -- src/normalize/noise.ts | grep -E "^\+.*: true"
  ```
  For every new `true` pin (standalone bool OR all-boolean object/leaf family),
  check it is paired with a `MEANINGFUL_WHEN_OFF` / `MEANINGFUL_WHEN_OFF_NESTED`
  gate; if not, prove the FN offline first (synthesize the current reader's
  projection into a harvested corpus case's liveRaw, flip to the ALL-off shape,
  assert findings) — see the all-boolean-object gotchas below for the mechanics
  and the exclusion tests (OOB-mutability, off-state read shape).
- **Corpus-first for any "unproven" table row**: before deploying to prove a
  variant-table row or a suspect default, grep `tests/corpus/*.json` for a case
  whose liveRaw already exhibits the value with a clean `expected` — harvested
  corpus IS live evidence, and agents' "unexercised" claims are often wrong
  (grep-verify; fixtures/corpus have existed for most "gaps" every recent hunt).
- `bash scripts/measure-noise.sh` (§5.5) over the current corpus for fold
  candidates.

### 1. Worktree + build

Per CLAUDE.md, never work in the main checkout:
`git worktree add .worktrees/<name> -b wt-<name> main` →
`mise trust .worktrees/<name>/.mise.toml` → `pnpm install` → `vp run build` (the CLI
runs from `dist/`).

**That recipe is CWD-RELATIVE, so it only applies when this hunt was launched
from the MAIN checkout.** Launched from inside a linked worktree (an Orca/ADE
workspace, a stray `cd` into `.worktrees/<x>`) it NESTS a worktree inside one,
and deleting the outer workspace takes the inner directory, its uncommitted work
and its git registration with it (go-to-k/cdk-real-drift#1842). Settle the launch
mode with the probe in `.claude/skills/work-issues/references/launch-mode.md`,
the file that holds the ONLY copy of it — `/work-issues` SKILL.md points there
rather than carrying it.
IN-PLACE means create nothing and hunt on the branch already checked out here
(deps and `dist/` are usually already built), and §8 then removes nothing. The
probe reports a mode and two paths and carries no lane limit of its own; the
one-lane rule is `/work-issues` prose, and a hunt takes one fix at a time
anyway, so it costs this skill nothing.

### 2. Scaffold fixtures + ARM the cleanup gate

Add fixtures under `tests/integration/<name>/` — mirror an existing one (`app.ts` +
`cdk.json` + `package.json` + `verify.sh`). A clean-FP `verify.sh` is: deploy →
`record --yes` → `check --fail` MUST exit 0. Run `npm install` then `cdk synth` for
all fixtures in parallel FIRST (cheap, catches TS errors before any paid deploy).

**Before deploying, record every stack you are about to deploy into the sentinel —
this arms the cleanup gate. SCOPE it to THIS session** so a parallel agent's live
stacks never mix into a shared owner file (see the owner-scoping note below):

```bash
# this session's own owner (env does not persist across tool calls — re-prefix each command)
CDKRD_BUGHUNT_OWNER="session-${CLAUDE_CODE_SESSION_ID:-$$}" \
  .claude/skills/hunt-bugs/bughunt-track.sh add CdkRealDriftIntegS3Rich CdkRealDriftIntegVpcCommon ...
```

Run every later `bughunt-track.sh verify` / `clear` with the SAME
`CDKRD_BUGHUNT_OWNER="session-${CLAUDE_CODE_SESSION_ID:-$$}"` prefix, so you clear
only YOUR own pending set. (The `deploy-autoarm-gate` hook also arms a per-session
`autoarm-<session>` token on any deploy as a backstop — keyed by the SAME
`CLAUDE_CODE_SESSION_ID` — so the merge/commit block is per-session either way; the
explicit `add` gives the clearer gate message and the per-stack list.) **Tag
every fixture `cdkrd:ephemeral=1`** (`Tags.of(app).add('cdkrd:ephemeral','1')` in
`app.ts`) so the generic tag net in `sweep-orphans.sh` catches any resource type it has
no per-type rule for.

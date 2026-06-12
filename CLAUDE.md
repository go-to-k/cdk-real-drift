# CLAUDE.md

This file guides Claude Code (claude.ai/code) and human contributors working in
this repository. Keep it concise — the full design lives in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Project Overview

**cdk-real-drift** (`cdkrd`) is a drift detect/revert CLI for AWS CDK /
CloudFormation. It detects when your **real** deployed AWS resources diverge from
your IaC intent — **including properties you never declared** in the template. That
undeclared-property dimension is the differentiator: `cdk drift`, CloudFormation
drift detection, `driftctl`, and `terraform plan` all compare only properties that
appear in the template, so an out-of-band change to a setting you never declared
(a bucket's `OwnershipControls`, a role's `PermissionsBoundary`, an extra inline
policy) is invisible to them. `cdkrd` reads the **full** live resource model via
Cloud Control API (with SDK overrides for CC-gap types) and reports — and can
revert — the divergence. No AWS Config required.

It is **reality vs intent**, not code vs template: it deliberately does NOT
reimplement `cdk diff`. The full design, rationale, and pipeline are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (with [DESIGN.md](DESIGN.md) as the
terse companion and [docs/redesign-notes.md](docs/redesign-notes.md) for
pre-publication decisions).

## The 3-Verb Model

```bash
node dist/cli.js check  [<stack>...] [--all]   # detect drift (read-only)
node dist/cli.js accept [<stack>...] [--all]   # record current state into the baseline file
node dist/cli.js revert [<stack>...] [--all]   # write the desired value back to AWS (confirms)
```

- `check` and `accept` never write to AWS (`accept` writes only the baseline file).
  `revert` is the one AWS-mutating verb and always confirms first (`--dry-run` to
  preview, `--yes`/`-y` to skip the prompt).
- With no stack and no `--all`, the CDK app is synthesized (`--app` / `cdk.json`)
  and every stack it defines is targeted. A stack arg containing `*`/`?` is a glob.
- Key flags: `--region`, `--profile`, `--app`, `-c/--context key=value`, `--json`,
  `--fail[=declared|undeclared]` (check), `--show-all`, `--pre-deploy` (check), `--all`,
  `--dry-run`/`--yes` (revert). check is report-only by default; `--fail` makes
  drift exit 1 (errors always 2).
- See `src/cli.ts` `HELP` and README.md "Commands & options" for the full surface.

## State of the Repo

- **Pre-release / experimental.** Private until Phase 4; not yet published. Remote:
  <https://github.com/go-to-k/cdk-real-drift> (developed solo, PR-based).
- Baseline files live at `.cdkrd/<stack>.<accountId>.<region>.json` — git-committed.
  A PR that changes a baseline is a visible, reviewable change to "what real state
  we accept".

## Build and Test Commands

Toolchain = **Vite+ (`vp`) + pnpm + tsgo + oxc** (NOT eslint/prettier/biome) —
same as `cdk-local`. `vp` and `markgate` are pinned by `.mise.toml` (run
`mise install` once).

```bash
vp run build       # vp pack — tsdown ESM bundle to dist/ (bin: cdkrd)
vp run dev         # vp pack --watch
vp run test        # vp test run — Vitest unit tests (tests/integration/** excluded)
vp run typecheck   # tsgo --project tsconfig.json --noEmit
vp check --fix     # lint + format (oxc), with auto-fix
vp run check       # lint + format check (what CI runs)
```

The user runs cdkrd via `node dist/cli.js`, so always run `vp run build` after
source changes before telling the user to test.

## Important Implementation Details

- **ESM modules**: `package.json` is `"type": "module"`. All relative imports must
  include the `.js` extension, even in TypeScript:

  ```typescript
  import { foo } from './bar.js'; // correct
  import { foo } from './bar'; // wrong
  ```

- **Build tasks** are registered as Vite+ `run` tasks in `vite.config.ts` and
  invoked via `vp run <task>` — prefer this over ad-hoc `node` invocations or
  `package.json` "scripts".

## Architecture (src layout)

Terse per-dir map — defer to [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
detail:

- `commands/` — the 3 verb entry points (check/accept/revert) + stack resolution.
- `desired/` — declared "intent": deployed-template fetch + CFn template adapter.
- `read/` — live state read routing: Cloud Control API → SDK overrides for CC-gap
  types (`overrides.ts` / `SDK_OVERRIDES`).
- `normalize/` — noise subtraction (policy canonicalization, ARN/identity, `aws:*`
  tags, CC-API strip, path strip, intrinsic resolution).
- `diff/` — drift classification + calculation (declared / undeclared / readGap /
  unresolved / skipped).
- `revert/` — the AWS-mutating path: Cloud Control `UpdateResource` + type-specific
  SDK writers (`writers.ts` / `SDK_WRITERS`).
- `schema/` — CloudFormation resource-schema strip (readOnly/writeOnly props).
- `synth/` — CDK app synthesis (`@aws-cdk/toolkit-lib`) for stack discovery +
  construct-path display.
- `baseline/` — the `.cdkrd/<stack>.<accountId>.<region>.json` baseline file I/O.
- `report/` — text + JSON output rendering.

## Workflow Rules

- **English-only for all committed files** (this is an OSS project): source,
  scripts, comments, docs, config, commit messages. Conversation may be in another
  language; committed artifacts must be English.
- **Always add unit tests** for new behavior or bug fixes — do not wait to be asked.
- **Run `vp run build`** after modifying source, before telling the user to test.
- **Conventional commits**: use `feat:` / `fix:` / `chore:` / `docs:` / `test:`
  prefixes. A `pr-title-check` workflow enforces PR titles.
- **markgate gates** (see `.markgate.yml`) — each has a companion skill that sets
  its marker:
  - `/check` → `check` marker (typecheck / lint+format / build / unit tests).
  - `/check-docs` → `docs` marker (README / DESIGN / docs consistency with src).
  - `/verify-pr` → `verify-pr` marker (pre-RELEASE superset of check + docs plus a
    live-test + retrospective; named `verify-pr` for layout parity with cdkd).
  - A `check-gate` PreToolUse hook blocks `git commit` unless both the `check` and
    `docs` markers are fresh. Run the relevant skill before committing.
- **ALWAYS develop in a git worktree — never edit or branch in the main
  checkout, even for a single "sequential" session.** Sessions that believed
  they were alone have collided twice: a README clobber, and a branch created in
  the shared checkout that captured another session's staged R44 commit. Every
  line of work gets its OWN worktree with DISJOINT files:
  `git worktree add .worktrees/<name> -b wt-<name> main` →
  `mise trust .worktrees/<name>/.mise.toml` → `pnpm install` (worktrees have no
  `node_modules`) → work → run gates + set markers → commit on the branch. The
  orchestrator integrates by `git checkout <branch> -- <files>` (NEVER `git merge` —
  the leaked cdkd session hooks block it), then `git worktree remove`. The main
  checkout is reserved for integration: `main` checkouts, pulls, and PR plumbing
  only.
- **All changes go through a pull request — never commit directly to `main`.**
  Branch (or worktree branch) → run the gates + set markers → commit → push →
  `gh pr create`. The reviewer re-reviews the PR diff before merge. cdkd's heavier
  branch-protection / verify-pr-merge / pr-review / integ-\* gates are still not
  ported — revisit at Phase 4.

## Dependencies

- `@aws-cdk/toolkit-lib` — CDK app synthesis for stack discovery + construct paths.
- `@aws-sdk/client-*` — AWS SDK v3 (Cloud Control + per-service override readers).
- `yaml` — CFn-aware YAML codec for deployed-template parsing.

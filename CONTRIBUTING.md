# Contributing to cdk-real-drift (`cdkrd`)

Thanks for your interest in contributing! `cdkrd` is a drift detect/revert CLI for
AWS CDK / CloudFormation — including the **undeclared** properties that `cdk drift`
and CloudFormation drift detection miss. See [README.md](README.md) for an overview
and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

> **Status:** pre-release / experimental. Developed solo, but every change lands
> through a pull request on the GitHub remote — never committed directly to
> `main`.

## Prerequisites

The toolchain is **Vite+ (`vp`) + pnpm + tsc (TypeScript native) + oxc** (not eslint/prettier/biome) —
the same stack as `cdk-local`. `vp` and `markgate` are pinned in `.mise.toml`:

```bash
mise install      # installs the pinned vp + markgate
pnpm install      # installs Node dependencies
```

## Build / test / lint

```bash
vp run build       # vp pack — tsdown ESM bundle to dist/ (bin: cdkrd)
vp run test        # vp test run — Vitest unit tests
vp run typecheck   # tsc --project tsconfig.json --noEmit
vp check --fix     # lint + format (oxc), with auto-fix
vp run check       # lint + format check (what CI runs)
```

`vp run check` captures the checker's output to `node_modules/.cache/vpcheck.log`
and prints it only when the check FAILS, so a quiet run means **0 errors** — run
`vp check` directly to read the advisory warning list. The redirect works around an
upstream Vite+ panic that otherwise aborted the task with exit 134 on a clean tree
([#1761](https://github.com/go-to-k/cdk-real-drift/issues/1761)); CI applies the same
workaround.

`node dist/cli.js` runs the built CLI, so **run `vp run build` after source
changes** before testing manually. Integration tests (real AWS, self-cleaning)
live under `tests/integration/` — see
[tests/integration/README.md](tests/integration/README.md).

## Integration tests

The integration tests deploy and inspect **real AWS resources**, so running
them incurs real AWS charges. CI does not run them.

**You are not required to run them.** If your change needs integration
coverage (see below), just say so in your PR — the maintainer runs the
required tests before merging, at no cost to you. The maintainer's pre-merge
checklist requires a fresh real-AWS integration run for any PR that touches
`src/**`, and merging is blocked until it has passed, so coverage is
guaranteed either way; asking is never a burden.

You are welcome to run them yourself against your own AWS account if you
prefer — see [tests/integration/README.md](tests/integration/README.md).

### When is an integration run needed?

Which verification a PR needs is derived mechanically from the paths it
touches — the `integ` gate scope in [`.markgate.yml`](.markgate.yml) is the
source of truth. In summary: any change under `src/**` or
`tests/integration/**` needs a real-AWS integration run before merge; a
docs / tooling-only PR needs none (unit tests and CI are enough). When in
doubt, open the PR and ask.

## Conventions

- **English-only**: all committed files (source, comments, scripts, docs, config,
  commit messages, PR titles) must be in English.
- **Conventional commits**: prefix messages with `feat:` / `fix:` / `chore:` /
  `docs:` / `test:`. A `pr-title-check` workflow enforces the same on PR titles.
- **ESM imports** must include the `.js` extension, even in TypeScript:
  `import { foo } from './bar.js';`.
- **Always add a unit test** for new behavior or a bug fix (see the per-area
  reminders below).

## How to add common things

### An SDK-override reader (for a Cloud-Control-gap type)

Some resource types can't be read via Cloud Control `GetResource`. Add a reader in
[`src/read/overrides.ts`](src/read/overrides.ts) and register it in the
`SDK_OVERRIDES` map keyed by CFn type (e.g. `AWS::S3::BucketPolicy`). The reader
returns the live resource model the normalizers then strip.
**Add a unit test** in `tests/overrides.test.ts` (or a focused sibling) asserting
the model shape produced from a mocked SDK response.

### A revert SDK writer (for a Cloud-Control-unwritable type)

When a type can't be reverted via Cloud Control `UpdateResource`, add a
type-specific writer in [`src/revert/writers.ts`](src/revert/writers.ts) and
register it in the `SDK_WRITERS` map. A writer reads the current model, applies the
revert ops, and performs the SDK write (e.g. policy-document types via
`CreatePolicyVersion`). **Add a unit test** in `tests/writers.test.ts` covering the
read → apply-ops → write path, and update README.md "Known limitations" if a "not
revertable" claim changes.

### A noise normalizer

To suppress a class of false-positive drift, add or extend a normalizer under
[`src/normalize/`](src/normalize/) (policy canonicalization, ARN/identity, `aws:*`
tags, CC-API strip, path strip, intrinsic resolution). Normalizers must be
**fail-closed**: never fabricate a value that would show as false drift — when in
doubt, leave a property `unresolved` (skipped). **Add a unit test** demonstrating
that the targeted noise is removed and that genuine drift still surfaces.

## Before you commit

Run the markgate companion skills (they back the pre-commit gate):

- `/check` — typecheck / lint+format / build / unit tests (sets the `check` marker).
- `/check-docs` — README / DESIGN / docs consistency with src (sets the `docs`
  marker).

A `check-gate` hook blocks `git commit` unless both markers are fresh. Run the
relevant skill, then commit.

## Before you open a PR

Work on a branch — `branch-gate` blocks commits and pushes on `main`.

- `/verify-pr` — the PR readiness checklist; sets the `verify-pr` marker that
  `verify-pr-gate` requires for `gh pr create` / `gh pr merge`. A PR whose diff
  touches no `src/**` (docs / tooling only) is exempt: `check` + `docs` already
  cover it.
- CI (`.github/workflows/ci.yml`) must be green before merging — `ci-green-gate`
  blocks `gh pr merge` on a red or still-pending run.

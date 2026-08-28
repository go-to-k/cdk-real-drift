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
**only because every deployed stack is deleted and verified gone** — see the
cleanup-gate stage file, which is enforced by a gate, not by trust.

## How this skill is packaged (read this before anything)

This file is a thin orchestrator. The full procedure lives in per-stage files
under `references/`, split so a run loads only the stage it is in instead of the
whole corpus. **Reading the stage file at stage entry is MANDATORY, not
optional** — each file carries hard rules and measured failure modes without
which the stage summary below is not executable.

**Delegate the read-heavy stages to subagents to keep this session's context for
the live work.** Two stages are shaped for it:

- **Angle-picking (before any deploy)**: dispatch a read-only subagent
  (general-purpose or Explore) that reads `references/principles.md` +
  `references/gotchas.md` in full, runs the offline audits in
  `references/plan.md` stage 0, and returns ONLY the round plan — the
  types/configs to deploy, the lens per round, and the offline-audit findings.
  The catalogue prose stays out of the parent context.
- **Retro (stage 9)**: after the merge, a subagent with
  `references/cleanup-and-ship.md` stage 9 plus this run's evidence drafts the
  fold-back edits to the stage files and ships them.

Deploys, the cleanup gate, fixes, and merges run in the parent: it holds the
sentinel, the worktrees, and the gates.

## Stages

| Stage                       | File (read at entry)              | What it covers                                                                                                                                                                                       |
| --------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Posture + goal + principles | `references/principles.md`        | Default: ~5 rounds, vary the lens, assume latent bugs remain; ASK issue-only vs fix+PR unless the user named it; the core-principles catalogue (FP/FN classes, corpus mining, composite identifiers) |
| 0–2. Plan + arm             | `references/plan.md`              | Offline audits BEFORE picking targets, worktree + build, scaffold fixtures, `bughunt-track.sh add` BEFORE any deploy                                                                                 |
| 3–4. Deploy + detect        | `references/deploy-and-detect.md` | Parallel deploys (3–4 stack cap), first `check` (FP half), out-of-band mutation probes (FN half), revert convergence                                                                                 |
| 5–5.5. Harvest              | `references/harvest.md`           | Golden-corpus harvest EVERY round (bug or not), first-run-noise sweep via `KNOWN_DEFAULTS`                                                                                                           |
| 6. File + fix               | `references/file-and-fix.md`      | On a confirmed bug: file the issue (dup-check), then fix with a unit test — mandatory; collision-safe start via `/work-issues` when the backlog flow applies                                         |
| 7–9. Cleanup + ship         | `references/cleanup-and-ship.md`  | `/sweep-resources`, the gate-enforced sentinel (verify → clear), merge + worktree removal, record what you learned                                                                                   |
| Appendix                    | `references/gotchas.md`           | Gotchas learned the hard way — keep current                                                                                                                                                          |

## Hard invariants (hold even between stage reads)

- **Cleanup is non-negotiable and gate-enforced**: run the tracker's `add` with
  every stack name BEFORE any deploy; the `bughunt-clean-gate` hook blocks commit /
  PR-create / PR-merge while the sentinel is non-empty; release only via
  `bughunt-track.sh verify` → `clear` (separate, un-piped commands, same cwd),
  after `delstack` deletion + `SWEEP CLEAN`. Never delete the sentinel by hand.
  Set `CDKRD_BUGHUNT_OWNER="session-$CLAUDE_CODE_SESSION_ID"` so a `clear` can
  never drop a peer's pending stacks.
- **`delstack`, not `cdk destroy` / `delete-stack`** — plain deletion orphans
  blocking members; then sweep stack-EXTERNAL orphans (log groups, IAM roles,
  RETAIN resources, Secrets in recovery, KMS pending deletion).
- **ASK the goal at run start unless the user named it**: issue-only vs fix+PR
  differ in cost and collision risk — do not assume.
- **Unique stack names, 3–4 concurrent stacks max** — a real account may hold
  PROD stacks, and parallel agents must never collide.
- **A confirmed bug gets an issue AND a unit test with its fix** — never a
  silent fix, never a fix without the test.
- **A clean, un-mutated deploy has ZERO `[Potential Drift]` on first `check`**
  (CLAUDE.md core invariant) — anything surfaced is a fold gap, i.e. the bug.
- **English only in every committed/published artifact** (code, issues, PRs).

## Where lessons land (keeps this file thin)

The retro amends the STAGE FILE the lesson belongs to — a principle or gotcha
goes into `references/principles.md` / `references/gotchas.md`, a stage-specific
trap into the stage file where it fires — never this orchestrator, unless the
stage list itself changed. This file's byte size is capped by
`tests/skill-file-payload.test.ts`; the cap is the mechanical stop on the growth
loop that produced the 107 KB predecessor of this layout. Qualify every
cross-repo issue reference (`go-to-k/cdk-real-drift#N`, never a bare `#N` —
`tests/skill-doc-paths.test.ts` enforces it over every `.md` file here).

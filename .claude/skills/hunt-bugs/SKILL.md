---
name: hunt-bugs
description: Proactively hunt for cdkrd bugs by deploying real CDK stacks that exercise common-but-untested AWS resources, configs, and CloudFormation notations against real AWS, then catch false positives + missed detection and fix what breaks. Use for a periodic "find latent bugs" sweep, not for verifying a specific change.
argument-hint: "[area hint, e.g. 'rich S3' | 'CFn intrinsics' | 'console-edit detection']"
---

# cdkrd Bug Hunt

Find latent cdkrd bugs the way real users hit them: deploy a CDK stack that uses a
resource / config / CloudFormation notation **cdkrd has not exercised yet**, then
`check` it against real AWS and watch for misbehavior. The remaining bugs live in the
gap between cdkrd's model of AWS and the **actual** live AWS response — only a real
deploy surfaces those.

This is a deliberately exploratory, possibly-expensive workflow. Cost is acceptable
**only because every deployed stack is deleted and verified gone** — see
`references/cleanup-and-ship.md`, which a gate enforces.

## How this skill is packaged (read this before anything)

This file is a thin orchestrator; the procedure lives in per-stage files under
`references/`, so a run loads only the stage it is in. **Reading the stage file at
stage entry is MANDATORY** — each carries hard rules without which the summary below
is not executable.

**Delegate the read-heavy stages to subagents to keep this session's context for the
live work:**

- **Angle-picking (before any deploy)**: a read-only subagent reads
  `references/principles.md` + `references/gotchas.md` in full, runs the offline
  audits in `references/plan.md` stage 0, and returns ONLY the round plan — the
  types/configs to deploy, the lens per round, the audit findings.
- **Retro (stage 9)**: after the merge, a subagent with
  `references/cleanup-and-ship.md` stage 9 plus this run's evidence drafts the
  fold-back edits to the stage files.

Deploys, cleanup, fixes and merges run in the parent: it holds the sentinel and the
worktrees.

## Stages

| Stage                | File (read at entry)              | What it covers                                                        |
| -------------------- | --------------------------------- | --------------------------------------------------------------------- |
| Posture + principles | `references/principles.md`        | Rounds and lenses; ASK the goal; FP/FN classes; fold-strategy order   |
| 0–2. Plan + arm      | `references/plan.md`              | Offline audits, worktree + build, fixtures, `add` BEFORE any deploy   |
| 3–4. Deploy + detect | `references/deploy-and-detect.md` | Capped parallel deploys, first `check`, OOB mutation, revert converge |
| 5–5.5. Harvest       | `references/harvest.md`           | Corpus harvest EVERY round, first-run-noise sweep                     |
| 6. File + fix        | `references/file-and-fix.md`      | File the issue, then fix with a unit test; start via `/work-issues`   |
| 7–9. Cleanup + ship  | `references/cleanup-and-ship.md`  | `/sweep-resources`, sentinel verify → clear, merge, retro             |
| Appendix             | `references/gotchas.md`           | Gotchas learned the hard way — keep current                           |

## Hard invariants (hold even between stage reads)

- **Cleanup is non-negotiable and gate-enforced**: run the tracker's `add` with every
  stack name BEFORE any deploy; the `bughunt-clean-gate` hook blocks commit /
  PR-create / PR-merge while the sentinel is non-empty; release only via
  `bughunt-track.sh verify` → `clear` (separate, un-piped commands, same cwd), after
  `delstack` deletion + `SWEEP CLEAN`. Never delete the sentinel by hand. Set
  `CDKRD_BUGHUNT_OWNER="session-$CLAUDE_CODE_SESSION_ID"` so a `clear` can never drop
  a peer's pending stacks.
- **`delstack`, not `cdk destroy` / `delete-stack`** — plain deletion orphans blocking
  members; then sweep stack-EXTERNAL orphans (log groups, IAM roles, RETAIN resources,
  Secrets in recovery, KMS pending deletion).
- **ASK the goal at run start unless the user named it**: issue-only vs fix+PR differ
  in cost and collision risk.
- **Unique stack names, 3–4 concurrent stacks max** — a real account may hold PROD
  stacks, and parallel agents must not collide.
- **A confirmed bug gets an issue AND a unit test with its fix** — never a silent fix,
  never a fix without the test.
- **A clean, un-mutated deploy has ZERO `[Potential Drift]` on first `check`**
  (CLAUDE.md core invariant) — anything surfaced is a fold gap, i.e. the bug.
- **English only in every committed/published artifact** (code, issues, PRs).

## Where lessons land (keeps this file thin)

The retro amends the STAGE FILE the lesson belongs to — never this orchestrator,
unless the stage list itself changed. A lesson about the TOOLING rather than about
cdkrd goes to `docs/tooling-backlog.md`. Qualify every issue reference
(`go-to-k/cdk-real-drift#N`, never a bare one).

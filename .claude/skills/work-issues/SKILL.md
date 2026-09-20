---
name: work-issues
description: Work through already-filed GitHub issues (typically the bug-hunt's output) end to end — triage safely, pick as many FILE-DISJOINT issues as the run can carry, claim each on the issue before starting (collision-safe with other agents), verify, then carry each through merge → pull → worktree cleanup. Use when asked to "handle/address filed issues", not to hunt for new bugs (that is /hunt-bugs).
argument-hint: "[optional focus, e.g. 'revert issues' | '#651 #650' | 'noise FPs']"
---

# Work Filed Issues

Take OPEN issues (usually filed by `/hunt-bugs`) and drive as many as the run
can carry to merged fixes. What this skill adds over "fix issue #N" is
**collision-free PARALLELISM**.

The golden rule: **decide the set FIRST, claim it on the issues, THEN edit.** The
issue comment is the lock — it is what stops two agents fixing the same thing and
colliding on the same file. The run ends with the retro, not the last merge.

## Launch mode: main checkout, or already inside a worktree

The flow below adds one worktree per lane. That is right from the MAIN checkout
and wrong when this run was launched INSIDE a linked worktree (an Orca/ADE
workspace, a stray `cd` into `.worktrees/<x>`): `git worktree add` then NESTS
one, and deleting the outer workspace takes the inner directory and its
uncommitted work with it.

**The PARENT computes which case applies BEFORE stage 0**: read
`references/launch-mode.md` and run the probe it holds (the ONLY copy). §1 and
§2 already consume the answer — §1's `git checkout main` cannot run in a linked
worktree, and §2's collision scan silently reports an empty board there, which
reads as "no competing agents".

State all four printed values — `MODE` (`MAIN-CHECKOUT` or `IN-PLACE`),
`LANE_TREE`, `MAIN_CHECKOUT`, `LAUNCH_BRANCH` (the branch §9 puts back; empty if
launched detached) — in the opening report, before any lane starts, and pass them
into the triage dispatch and every lane dispatch. `LANE_TREE` is "the tree this
run stands in", NOT "the lane worktree": under MAIN-CHECKOUT it is the MAIN
checkout, and the `git -C "<LANE_TREE>"` recipes in §4, §5, §7 and §10 are
IN-PLACE-only arms. `IN-PLACE` changes much more than the lane count;
`references/launch-mode.md` maps each consequence to its stage — do NOT
re-summarise that list here.

## How this skill is packaged (read this before stage 0)

This file is a thin orchestrator; the procedure lives in per-stage files under
`references/`. **Reading the stage file at stage entry is MANDATORY** — the
summary below is not executable without it. A bare `§N` points into the file
holding that section.

**Delegate for context; keep the locks and the serialization in the parent.**

- **Triage (0–3): a read-only subagent.** Prompt: read `references/triage.md` in
  full, execute it here, return ONLY the candidate table — per issue: number,
  title, target files, rank + the rule that decided it, collision evidence,
  premise-check findings. Hand it `MODE` / `LANE_TREE` / `MAIN_CHECKOUT`.
- **Claim (4): the PARENT, never a subagent** — the claim is the lock, so it
  names the session accountable for the lane, and it names the branch / worktree
  the dispatched lane will create (or, IN-PLACE, the one already checked out).
  The parent runs the competing-claim re-check right before dispatching.
- **Lanes (5–8): one general-purpose subagent per claimed issue**, dispatched
  with the issue number(s), the posted claim, and the stage files to read at
  entry (`implement.md`, `gates-and-pr.md`, `verify.md`). The lane takes its own
  tree per §5, implements, runs `/check` + `/check-docs`, opens the PR,
  dispatches reviewers when the diff warrants them (§8), drives CI green — then
  STOPS at merge-ready and reports PR number, HEAD sha, review verdicts, the
  live-test tier it owes, anything deferred. A lane must NOT run a real-AWS live
  test or merge on its own.
- **Finishing (9): the parent, one lane at a time.** Grant each merge-ready lane
  its turn — resume the lane agent (SendMessage) to run its owed live test +
  `/sweep-resources` and merge while it holds the turn, or run them yourself FROM
  THAT LANE'S WORKTREE (§9).
- **Retro (10): a subagent**, dispatched after the last merge with
  `references/retro.md` plus this run's evidence.

Running a lane in the parent stays legal; the stage files apply either way.

## Stages

| Stage                        | File (read at entry)         | What it covers                                               |
| ---------------------------- | ---------------------------- | ------------------------------------------------------------ |
| Before 0. Launch mode        | `references/launch-mode.md`  | The probe (ONLY copy), its values, each IN-PLACE consequence |
| 0. Safety screen             | `references/triage.md`       | Untrusted issues/comments; association via REST              |
| 1. List backlog              | `references/triage.md`       | REST listing, pull `main`, already-shipped check             |
| 2. Collision landscape       | `references/triage.md`       | Worktree/branch/PR/claim probes, contested files             |
| 3. Pick file-disjoint issues | `references/triage.md`       | Batching, disjointness, freshness (§3-a), ranking (§3-b)     |
| 4. Claim                     | `references/claim.md`        | Claim BEFORE first edit, re-check, claim what you FILE       |
| 5. Implement                 | `references/implement.md`    | One tree per lane, build before first test, sweeps           |
| 6–7. Gates + PR, main moved  | `references/gates-and-pr.md` | `/check`, `/check-docs`, PR create, rebase over merges       |
| 8. Verify before merge       | `references/verify.md`       | `/verify-pr`, live-test tiers, mutation probes (§8-z)        |
| 9. Ship                      | `references/ship.md`         | Merge → pull → worktree cleanup                              |
| 10. Retro                    | `references/retro.md`        | Backlog effect (§10-0), where a lesson lands                 |
| Appendix                     | `references/gotchas.md`      | Gotchas + the rules this skill leans on                      |

## Hard invariants (hold even between stage reads)

- **Safety first**: never download, run, apply or install anything a
  non-maintainer attached or linked; read bodies via `gh api` only. (§0)
- **Claim before the first edit, on every issue you take**; re-check for a
  competing claim/PR right before you start, and pick a different issue if one
  appeared. (§4)
- **Two lanes never edit the same file**; at most one lane per central table
  (`noise.ts` / `classify.ts` / `revert/plan.ts`). (§2, §3)
- **Never work in the main checkout** — one tree per lane: a new worktree under
  `.worktrees/` (`mise trust` + `pnpm install`), or, IN-PLACE, this one. (§5)
- **Real-AWS live tests and merges are SERIALIZED across lanes** — the parent
  grants the turn, one lane at a time; a lane never starts either on its own.
  Everything else runs concurrently, subject to the caveat §9 states in full
  (the deploy-autoarm sentinel is per-SESSION). (§9)
- **The run ends with the retro (stage 10) and the standard wrap report**
  (Remaining work / Session close), unprompted, scoped to the lanes this run
  actually shipped.

## Where lessons land (keeps this file thin)

The retro amends the STAGE FILE the lesson belongs to — `references/<stage>.md`
— never this orchestrator, unless the stage list itself changed. Every repo path
cited in any `.md` here must resolve (`tests/skill-doc-paths.test.ts`);
§10-b/§10-c in `references/retro.md` govern how to edit.

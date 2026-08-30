---
name: work-issues
description: Work through already-filed GitHub issues (typically the bug-hunt's output) end to end — triage safely, pick a few FILE-DISJOINT issues to fix in parallel, claim each on the issue before starting (collision-safe with other agents), verify, then carry each through merge → pull → release → global install → worktree cleanup. Use when asked to "handle/address filed issues", not to hunt for new bugs (that is /hunt-bugs).
argument-hint: "[optional focus, e.g. 'revert issues' | '#651 #650' | 'noise FPs']"
---

# Work Filed Issues

Take OPEN issues (usually filed by `/hunt-bugs` — false positives, missed
detection, revert gaps) and drive a few of them to merged, released, installed
fixes. The differentiator of this skill over just "fix issue #N" is **safe,
collision-free PARALLELISM**: when there is a backlog and other agents/sessions
are running, pick issues that cannot step on each other, announce which ones you
took, and only then start.

The golden rule: **decide the set FIRST, claim it on the issues, THEN edit.** The
issue comment is the lock — it is what stops two agents from fixing the same thing
and colliding on the same file. The run does not end at the last merge: the retro
stage folds what this run taught you back into this skill's files, while the
evidence still exists.

## Launch mode: main checkout, or already inside a worktree

The flow below adds one worktree per lane. That is right from the MAIN checkout
and wrong when this run was launched INSIDE a linked worktree (an Orca/ADE
workspace, a stray `cd` into `.worktrees/<x>`): `git worktree add` then NESTS
one, and deleting the outer workspace takes the inner directory, its uncommitted
work and its git registration with it (go-to-k/cdk-real-drift#1842). Run the
one-line probe at the top of §3 — the ONLY copy of it — before stage 0, and
state BOTH of its answers in the opening report — the mode, and the absolute
`LANE_TREE` path it captured, which §4, §5 and §10 all hand to `git -C` (§3 says
why that path is recorded rather than re-derived later).

`IN-PLACE` changes four things: take ONE issue (§3); claim the branch/worktree
already checked out (§4); add no worktree and work on the branch already here,
after confirming the tree is YOURS (§5); remove no worktree, delete no branch,
and reach `main` through the main checkout rather than leaving this tree (§9,
§10-d).

## How this skill is packaged (read this before stage 0)

This file is a thin orchestrator. The full procedure lives in per-stage files
under `references/`, split so a run loads only the stage it is in instead of the
whole corpus. **Reading the stage file at stage entry is MANDATORY, not
optional** — each file carries hard rules and measured failure modes without
which the stage summary below is not executable. A bare `§N` anywhere in this
skill points into the file that holds that section (map in the table).

**Delegate for context; keep the locks and the serialization in the parent.**
The placements below are live-proven, not aspirational: on 2026-08-28 this
repo's own skill-split PR (go-to-k/cdk-real-drift#1831), like its sibling
go-to-k/cdk-local#621, was built END-TO-END by a lane subagent — worktree,
implementation, gates, CI — with the parent doing only claims, serialized
merges and cleanup, and every hook and markgate gate fired inside the lane's
calls exactly as in the parent.

- **Triage (stages 0–3): a read-only subagent** (general-purpose or Explore)
  whose prompt is: read `references/triage.md` in full, execute it against
  this repo, and return ONLY the candidate table — per issue: number, title,
  target files, rank + the rule that decided it, collision evidence
  (worktrees / branches / claims found), and any premise-check findings. The
  raw backlog listing and issue bodies stay out of the parent context.
- **Claim (stage 4): the PARENT, never a subagent** — the claim is the lock,
  so it names the session accountable for the lane; it also names the lane
  branch/worktree the dispatched subagent will create, and the parent runs
  §4's competing-claim re-check right before dispatching (§4).
- **Lanes (stages 5–8): one general-purpose subagent per claimed issue.**
  Dispatch each with the issue number(s), the posted claim, and the stage
  files to read at stage entry (`references/implement.md`,
  `references/gates-and-pr.md`, `references/verify.md`). The lane creates its
  own worktree per §5, implements, runs `/check` + `/check-docs`, opens the
  PR, dispatches read-only reviewers when the diff warrants them (§8),
  addresses findings, and drives CI to green — then STOPS at merge-ready and
  reports back: PR number, HEAD sha, markers set, review verdicts, the
  live-test tier it owes (§8), anything deferred. Its diffs, test logs and
  review round-trips never enter the parent context. A lane must NOT run a
  real-AWS live test (a deploy → mutate → revert fixture) or merge on its
  own — that is the serialization invariant below, not a capability gap.
- **Finishing (stage 9): the parent, one lane at a time.** Grant each
  merge-ready lane its turn — resume the lane agent (SendMessage) to run its
  owed live test + `/sweep-resources` and merge while it holds the turn, or
  run them yourself FROM THAT LANE'S WORKTREE (gate verdicts are computed
  against the tree the command runs from — §9). Post-merge (pull → release →
  install → worktree cleanup) follows §9.
- **Retro (stage 10): a subagent**, dispatched after the last merge with
  `references/retro.md` plus this run's key evidence (what you re-read, what
  the text sent you into, corrections the user made) to measure the backlog
  effect, draft the skill edits, and ship them as the retro PR.

Running a lane in the parent instead stays legal (a single-lane run, or a lane
the user wants to watch); the stage files apply unchanged either way.

## Stages

| Stage                        | File (read at entry)         | What it covers                                                                                                                                                                      |
| ---------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Safety screen             | `references/triage.md`       | Untrusted issues/comments: `author_association` via REST, never download/run third-party content, defer engage/minimize/block to the maintainer                                     |
| 1. List backlog              | `references/triage.md`       | REST listing (PR filter, `per_page=100`, `created_at`), volume assessment                                                                                                           |
| 2. Collision landscape       | `references/triage.md`       | Worktree/branch/PR/claim probes and their blind spots; the central contested files (`src/normalize/noise.ts` / `src/diff/classify.ts` / `src/revert/plan.ts`)                       |
| 3. Pick file-disjoint issues | `references/triage.md`       | Disjointness gate, fresh-issue quarantine (§3-a), ranking rules, naming the next session's verification before writing `next` (§3-b), premise checks against `origin/main`          |
| 4. Claim                     | `references/claim.md`        | Claim comment BEFORE first edit, re-check for a competing claim/PR right before starting, claim what you FILE too (a `Session-fit: now` deferral gets its claim in the filing turn) |
| 5. Implement                 | `references/implement.md`    | One tree per lane (`.worktrees/`, or in place), build before first test, sibling-site sweeps, dup-check window when filing                                                          |
| 6. Gates + PR                | `references/gates-and-pr.md` | `/check`, `/check-docs`, marker freshness per worktree, PR create                                                                                                                   |
| 7. Main advanced             | `references/gates-and-pr.md` | Rebase over parallel merges, stale-base phantom diffs, re-grep what LANDED                                                                                                          |
| 8. Verify before merge       | `references/verify.md`       | `/verify-pr`, live-test tiers, mutation probes (§8-z when a probe reports no discrimination)                                                                                        |
| 9. Ship                      | `references/ship.md`         | Merge → pull → release → global install → worktree cleanup                                                                                                                          |
| 10. Retro                    | `references/retro.md`        | Net backlog effect (§10-0), promotion check on this run's `next` filings, where a lesson lands (§10-b/c), ship the retro PR (§10-d)                                                 |
| Appendix                     | `references/gotchas.md`      | Gotchas learned the hard way + the existing rules this skill leans on                                                                                                               |

## Hard invariants (hold even between stage reads)

- **Safety first**: never download, unpack, run, apply, or install anything a
  non-maintainer attached or linked — any vector (zip / patch / package /
  `curl | sh`) is the same play. Read bodies via `gh api` only. (§0)
- **Claim before the first edit, on every issue you take**; re-check for a
  competing claim/PR right before you start, and pick a different issue if one
  appeared. (§4)
- **Two lanes never edit the same file**; at most one lane per central table
  (`noise.ts` / `classify.ts` / `revert/plan.ts`). (§2, §3)
- **Never work in the main checkout** — one tree per lane: a new worktree under
  `.worktrees/` (`mise trust` + `pnpm install`), or, IN-PLACE, this one. (§5)
- **Real-AWS live tests and merges are SERIALIZED across lanes** — the parent
  grants the turn, one lane at a time; a lane subagent never starts either on
  its own. Everything else (edits, unit tests, markers, PR create, reviews,
  CI) runs concurrently, with two repo-local caveats: the markgate store is
  SHARED across worktrees with hashes from the setter's cwd, so a peer's
  `markgate set` landing between your set and your commit fails closed (a
  re-run, not a wrong pass); and the deploy-autoarm sentinel is per-SESSION,
  so one lane's live deploy blocks EVERY lane's commit and PR until the
  sweep clears it. (§9)
- **English only in every published artifact** — issue bodies/comments, PR
  titles/bodies, commits, code. (CLAUDE.md)
- **The run ends with the retro (stage 10) and the standard wrap report**
  (Remaining work / Session close), unprompted, scoped to the lanes this run
  actually shipped.

## Where lessons land (keeps this file thin)

The retro amends the STAGE FILE the lesson belongs to — `references/<stage>.md`
— never this orchestrator, unless the stage list itself changed. This file's
byte size is capped by `tests/skill-file-payload.test.ts`; the cap is the
mechanical stop on the growth loop that produced the 123 KB predecessor of this
layout. §10-b/§10-c (in `references/retro.md`) govern how to edit: amend in
place, escalate a twice-violated sentence to a test or hook, qualify every
cross-repo issue reference (`go-to-k/cdk-real-drift#N`, never a bare `#N` —
`tests/skill-doc-paths.test.ts` enforces it over every `.md` file here).

<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 4. CLAIM the chosen issues BEFORE editing

When lanes run as SUBAGENTS (the default for stages 5-8), the PARENT posts every
claim here — the claim is the lock and must name the session accountable for the
lane — and the claim's `<ref>` names the branch / worktree the dispatched lane
agent will create, not a branch the parent holds. The competing-claim/PR
re-check below also runs in the parent, right before dispatch.

**An IN-PLACE run names the tree it is STANDING IN**
(`references/launch-mode.md`): the `<ref>` is the branch §5 will create plus the
worktree already checked out — the `LANE_TREE` path the probe captured and the
opening report recorded, never re-derived from `git rev-parse --show-toplevel`
here (§5's reason). No WORKTREE will be created, and a claim pointing at one
that never appears is what §9's ownership probes misread.

**Do NOT claim `LAUNCH_BRANCH` — the branch checked out here right now is the
OUTER TOOL's, not this run's** (`references/launch-mode.md`: "a branch to PUT
BACK, never one to commit to"). So the name is COMPOSED here rather than read out
of git with `git -C "<LANE_TREE>" branch --show-current`, and it does not exist
yet: §5 creates it, after this stage. Write "the branch §5 will create in
`<LANE_TREE>`" and post the claim on time — a claim delayed until the branch
exists is a claim posted after the first edit, the one thing this stage forbids.
Such a run's lanes are SERIAL (§3), which bounds CONCURRENCY and not the issue
count: claim the top candidate alone or a whole set, but in a set mark every
lane after the first `QUEUED`, so a reader can tell a lane that is RUNNING from
one merely spoken for.

```bash
# The QUEUED form, posted up front with the rest of the set.
gh issue comment <n> --body "QUEUED behind #<the lane running first> in \
<LANE_TREE> — this session will start it only after that lane merges. Not \
started: no branch exists yet and no file is held. If you want this issue, take \
it and say so here; I will stand down."
```

When the run ends before reaching one, **stand it down rather than leaving the
claim standing** — a QUEUED claim outliving its session is a stale lock. Carry
the four classification fields in the stand-down comment, so the next session
inherits the triage instead of redoing the ranking.

For EACH issue you will start:

```bash
gh issue comment <n> --body "Working on this in PR/branch <ref> — touching <files>. \
Claiming to avoid collision with parallel agents."
```

(English only, issue BODIES and their classification lines included — nothing
checks this for issues.) Mandatory, and BEFORE the first edit: it is the
issue-level twin of the worktree DISJOINT-FILE rule. Re-check for a competing
claim/PR right before you start; if one appeared, pick a different issue.

**Claim what you FILE, too — filing is not claiming.** An issue this run files as
its own deferral is invisible to every ownership probe (only §3-a's hour covers
it). If the body carries `Session-fit: now`, post the claim comment in the same
turn you file it, naming the LANE and what it defers from — not your current
branch, which is deleted at merge and reads stale exactly when you come back;
re-post with the real branch when you open that lane. A `next` issue handed to a
later session gets NO claim at filing time (that would park a released issue
under a session that declined it); the later run claims it normally.

**`Severity` and `Effort` also ride the filing command as LABELS** — body lines
unchanged, plus `--label severity:<high|medium|low> --label
effort:<small|medium|large>` (or `--add-label` on the `gh issue edit` that
rewrites an old packed body), because prose is invisible to `gh issue list`.
`Session-fit` and `Estimate` get no label. The lane's PR inherits the issue's
labels via
`.github/workflows/pr-inherit-issue-labels.yml`, so never hand-add them to a PR.

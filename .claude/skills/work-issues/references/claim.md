<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 4. CLAIM the chosen issues BEFORE editing

When lanes run as SUBAGENTS (the orchestrator's default for stages 5-8), the
PARENT posts every claim in this section — the claim is the lock and must name
the session accountable for the lane — and the claim's `<ref>` names the branch
/ worktree the dispatched lane agent will create, not a branch the parent
holds. The competing-claim/PR re-check below also runs in the parent, right
before dispatch. Everything else in this section is unchanged.

**An IN-PLACE run names the tree it is STANDING IN**
(`references/launch-mode.md`): the `<ref>` is the branch §5 will create plus the
worktree already checked out. The worktree is the `LANE_TREE` path the
launch-mode probe captured and the opening report recorded — never re-derived
from `git rev-parse --show-toplevel` here, for §5's reason. No WORKTREE will be
created, and a claim pointing at a worktree that never appears is exactly what
§9's ownership probes misread.

**Do NOT claim `LAUNCH_BRANCH` — the branch checked out here right now is the
OUTER TOOL's, not this run's** (`references/launch-mode.md`: "a branch to PUT
BACK, never one to commit to"). So the name is COMPOSED here rather than read out
of git with `git -C "<LANE_TREE>" branch --show-current`, and it does not exist
yet: §5 creates it, after this stage. Write "the branch §5 will create in
`<LANE_TREE>`" and post the claim on time. A claim delayed until the branch
exists is a claim posted after the first edit, which is the one thing this stage
forbids. Such a run's lanes are SERIAL (§3), which bounds CONCURRENCY and not
the issue count: claiming only the top candidate is fine, and so is claiming a
whole set — but a claimed set must mark every lane after the first `QUEUED`,
because a reader has to tell a lane that is RUNNING from one merely spoken for.

```bash
# The QUEUED form, posted up front with the rest of the set.
gh issue comment <n> --body "QUEUED behind #<the lane running first> in \
<LANE_TREE> — this session will start it only after that lane merges. Not \
started: no branch exists yet and no file is held. If you want this issue, take \
it and say so here; I will stand down."
```

When the run ends before reaching one, **stand it down rather than leaving the
claim standing** — a QUEUED claim outliving its session is a stale lock, and the
four classification fields in the stand-down comment hand the next session the
triage instead of making it redo the ranking.

For EACH issue you will start:

```bash
gh issue comment <n> --body "Working on this in PR/branch <ref> — touching <files>. \
Claiming to avoid collision with parallel agents."
```

(English only — committed/public artifacts are English.) This is mandatory and
comes BEFORE the first edit. It is the issue-level twin of the worktree
DISJOINT-FILE rule. Re-check for a competing claim/PR right before you start; if
one appeared, pick a different issue.

**Claim what you FILE, too — filing is not claiming.** An issue this run files as
its own deferral is invisible to every ownership probe (no branch, no PR, no
comment; only §3-a's hour covers it). If the body carries `Session-fit: now`,
post the claim comment in the same turn you file it, naming the LANE and what it
defers from — not your current branch, which is deleted at merge and reads stale
exactly when you come back; re-post with the real branch when you open that lane.
A `next` issue handed to a later session gets NO claim at filing time (that would
park a released issue under a session that declined it); the later run claims it
normally.

**`Severity` and `Effort` also ride the filing command as LABELS** — body lines
unchanged, plus `--label severity:<high|medium|low> --label
effort:<small|medium|large>` (or `--add-label` on the `gh issue edit` that
rewrites an old packed body). Why: prose is invisible to `gh issue list`, so
ranking by `Severity` otherwise costs one `gh issue view` per candidate.
`Session-fit` and `Estimate` get no label (`CLAUDE.md` → "The four TODO
fields"). Enforced by `.claude/hooks/issue-classification-label-gate.sh`; the
lane's PR inherits the issue's labels via
`.github/workflows/pr-inherit-issue-labels.yml`, so never hand-add them to a PR.

**English-only covers the issue BODIES this flow files, not just the comment above.**
Write the classification lines in English, glosses included —
`Session-fit: next (not this session)`, `Estimate: ~1-3 h — one live run` —
never in the session's chat language. No hook enforces this half:
`non-english-text-gate` fires only on `gh pr create` / `gh pr edit` /
`gh pr merge` and resolves a PR number + `gh pr diff`, so it structurally cannot
see an issue; `issue-dup-check-gate` and `issue-classification-label-gate` do
fire on `gh issue` commands but read only the `Dup-check:` / `Severity:` /
`Effort:` lines, saying nothing about language. Discipline is the only guard and
has failed once: a go-to-k/cdk-local run filed a `Session-fit` gloss in the chat
language and had to patch the body after creation (2026-08-19,
go-to-k/cdk-real-drift#1777).

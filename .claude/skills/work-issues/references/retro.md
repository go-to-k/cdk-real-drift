<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 10. Fold what the run taught you back into this skill

Trigger: after the last lane in §9 is merged and every worktree THIS run added
is removed (an IN-PLACE run added none, so for it the trigger is the last
merge), and BEFORE the wrap report — the evidence dies with this session's
context. The subject is **the flow itself**: the orchestrator `SKILL.md`, its
`references/` stage files, the skills it drives, not the lane's code; the scope
is the WHOLE run, since cross-lane patterns are invisible from inside one lane.
APPLY the fix — editing this repo's agent tooling is a routine call. Escalate
through `AskUserQuestion` only when the edit changes what the flow PROMISES
(dropping a verification tier, loosening §0).

### 10-0. Measure the run's net effect on the backlog

Report one wrap line — `closed N / filed M (new K / folded J)` — where `J`
counts findings folded into an EXISTING issue; `updatedAt` cannot answer that,
since §4 makes every lane post a CLAIM comment, so count the issues whose BODY
gained a checklist row. When `M > N`, add the reason in one line; one root cause
split across issues means §5's sweep rule should have folded them, so fold the
open ones into an umbrella now. **`filed <= closed` is NOT a target and must
never become one** — an unfiled finding removes the defect from the record while
leaving it in the product. If weighing whether to file, file.

**Then run the PROMOTION check on every `next` this run filed**: a deferral is
judged against the run that HAPPENED, not the one predicted when it was written.
Diff the run's merged range (`git diff --name-only <sha main was at when this
run started>..origin/main`) against the files each still-open `next` issue
names, matching by SUFFIX, since bodies name files by basename more often than
by full path. **That diff is a LOWER bound on what the run loaded** — reviewers'
diffs and traced modules are not in it — so apply
`.claude/rules/session-report.md`'s context test as well. A hit is a prompt for
judgement, not a verdict (it cannot tell a citation from a target): do the item
now, or re-classify it in the issue body. **When a hit CONTRADICTS the issue's
stated reason, the BODY is the stale side**, since a reason anchored to the
filing session's own state goes false while the decision it justified stands.

### 10-a. Evidence: only what this run actually produced

Collect, with the concrete instance attached to each: **corrections the user
made** (two on one theme across lanes is a defect in this text, and the second
occurrence is the signal); **text that was WRONG as written** (a failed command,
a probe reporting clear while a lane was live, a flag / path / hook name gone);
**steps you had to invent** because the skill is silent; **right instruction,
wrong place** (done, but a step too late); **followed it and still paid** (text
obeyed, retry happened anyway).

**No evidence, no edit.** A clean run's output is one wrap line ("retrospective:
no skill change — §2 / §4 / §8 held"). A skill grown from "this would be nice"
stops being read to the bottom, where §9 and §10 live.

### 10-b. Where the finding goes — first occurrence versus second

**A tooling finding is RECORDED on its first occurrence and only becomes a
MECHANISM on its second.**

- **First occurrence** → one entry in `docs/tooling-backlog.md`: what failed,
  what it cost, and the command or file that would show it again. Do not file a
  GitHub issue, and do not build a hook, a fence or a new rule paragraph — one
  occurrence cannot tell a recurring defect from a one-off.
- **Second occurrence of the SAME failure** → build the mechanism, in ONE home:
  - **a hook** (`.claude/hooks/`) when the failure is mechanically detectable at
    the moment of the action. Strongest, and the right answer when the rule was
    ALREADY in the text and got violated anyway — that proves the sentence is
    not load-bearing. A claim that must stay in sync with the repo is a TEST.
  - **this skill's stage file** — `references/<stage>.md`, covering the step
    where the lesson fires; never the orchestrator `SKILL.md`, loaded whole on
    every invocation and changed only when the stage list changes.
  - **another skill**, only one this run exercised (`/verify-pr`,
    `/sweep-resources`, `/check`, `/check-docs`).
  - **`CLAUDE.md`, `DESIGN.md` or `docs/`** when it applies to any work here.
  - **memory** (`~/.claude/projects/.../memory/`) for judgemental cross-repo
    lessons. Weakest — where a rule lands when nothing above holds it.

Lessons stay in THIS repo: do not port a rule to a sibling or open a mirror PR
there. Each repo keeps its own text.

### 10-c. How to edit: amend, do not append

Every run appending one more bullet is how a long skill becomes an unread one.
Put the fix **in the step where it fires** (a claiming lesson belongs in §4;
gotchas is for traps that span steps, not a run log). **Amend the sentence that
was wrong** rather than adding a sibling, and point at a rule living in
`CLAUDE.md` or another step instead of restating it. **Carry the evidence as ONE
line**: the rule plus at most one issue / PR citation per decision, never the
narrative — a rule with no citation cannot be re-judged or retired, and a rule
buried in its own incident report is not read. **Pay for what you add** by
cutting a line this run proved stale, subsumed or wrong; a stage file is loaded
WHOLE at stage entry, so a lesson that cannot be paid for by compression splits
the stage instead of growing it.

Two mechanical rules, both enforced by `tests/skill-doc-paths.test.ts`:

- **Write every issue / PR reference FULLY QUALIFIED — `owner/repo#N`, never a
  bare `#N`.** The test fails on any unqualified reference in any `.md` under
  `.claude/skills/**`; it reads plain prose only, so counter-examples can stay
  written as code spans.
- **A skill doc cannot cite a repo path in order to say it is ABSENT**, because
  the test resolves every path-shaped code span with no negation exemption — a
  stale path would otherwise hide behind "no longer exists" phrasing. Reword:
  the absence stated in PROSE passes. A span is checked only when its FIRST
  segment is an existing top-level directory, and the pattern needs a leading
  word character, so a skill name like `/check-docs` is never read as a path.

### 10-d. Ship it like any other change

MAIN-CHECKOUT (SKILL.md "Launch mode") — run THIS block, not the next one. You
are on `main`, where `branch-gate` refuses a commit, so the retro gets its own
worktree. Date-suffix the branch: the previous run's was deleted on merge, so
reusing the name re-creates an orphan ref no PR tracks.

```bash
B=chore/work-issues-retro-$(date +%Y%m%d)
git worktree add ".worktrees/${B##*/}" -b "$B" origin/main
cd ".worktrees/${B##*/}"
mise trust && mise install    # untrusted .mise.toml: vp will not resolve
pnpm install                  # worktrees have no node_modules
```

IN-PLACE — run THIS block INSTEAD, never both: `git worktree add` from inside
this tree would NEST the worktree this mode exists to prevent, so take the retro
branch in the lane's own tree. `<LANE_TREE>` is the absolute path the
launch-mode probe printed — never re-derived from `git rev-parse --show-toplevel`
or `pwd`, which resolve against a reset cwd, leaving a bare `switch` to target
the MAIN checkout. Keep the `&&`: unchained, a failed `fetch` still branches,
off a stale `origin/main`. **Every later command takes the same
`-C "<LANE_TREE>"`** (edits, `git add`, commit, push, `gh pr create`), since
this block never `cd`s, and `B` is re-assigned because a separate fenced block
is a separate shell.

```bash
B=chore/work-issues-retro-$(date +%Y%m%d)
git -C "<LANE_TREE>" fetch origin \
  && git -C "<LANE_TREE>" switch -c "$B" origin/main
```

- `chore:` prefix — agent tooling, not `src/**`; a `fix:` / `feat:` prefix makes
  release-please describe a cdk-real-drift change that never happened.
- English only in every committed line, and in every issue / PR body.
- **`vp fmt` REWRITES this file's indentation, and that can change what a
  paragraph belongs to**: it re-indents a paragraph following a nested list item
  from 2 spaces to 4, re-parenting it under that sub-bullet, and nothing fails —
  the file still renders, saying something else. The shape that survives is a
  **bold lead paragraph at the parent bullet's own indent**, never prose
  trailing a sub-bullet. Run `vp fmt` TWICE, confirm the second is a no-op, and
  read the reformatted diff; the damage is invisible in the source you typed.
- Run `/check`, `/check-docs`, and the fences a prose-only diff can red
  (`tests/skill-doc-paths.test.ts`, `tests/markdown-fmt-corruption-1771.test.ts`
  — or just `vp test run`, cheap here).
- Do not let the small diff set the review depth: §8's reviewer rule applies
  unchanged, and a wrong rule here propagates into every future session.
- **Merge it before the wrap report, then remove the worktree**
  (`git worktree remove .worktrees/<name> && git worktree prune`) — §9 ends with
  every worktree gone and §10 must not undo that. An IN-PLACE run added none, so
  this is instead where it runs §9's IN-PLACE cleanup arm, **the LAST step of
  the whole run**: `git switch <LAUNCH_BRANCH>` as-is (no pull, no rebase, no
  fast-forward) and `git branch -D` every branch this run created, the retro
  branch included. §9 deliberately does NOT do it per-lane, because THIS section
  branches in the same tree and would undo it.

Then report the outcome in one wrap line: what changed, in which step, and the
run evidence behind it — or "no skill change" plus what held.

<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 10. Fold what the run taught you back into this skill

Trigger: after the last lane in §9 is merged and every worktree THIS run added
is removed — an IN-PLACE run added none, so for it the trigger is the last merge
— BEFORE the wrap report; the evidence dies with this session's context. Distinct from
`/verify-pr` step 8's per-LANE retrospective: the subject is **the flow
itself** (the orchestrator `SKILL.md`, its `references/` stage files, the
skills it drives — not the lane's code), the scope is the WHOLE run (cross-lane
patterns are invisible from inside one lane), and it **applies** the fix —
editing this repo's own agent tooling is a routine call. Escalate through
`AskUserQuestion` only when the edit changes what the flow PROMISES (dropping a
gate, lowering a verification tier, loosening §0) — never for wording,
ordering, or a newly-learned trap.

### 10-0. Measure the run's net effect on the backlog

Count what the run did to the issue list, and SPLIT the filed count by what
§5's open-issue window did with each finding — new and folded mean opposite
things:

```bash
# Folded INTO an existing issue rather than filed as a new one. `updatedAt` alone
# does NOT answer this: §4 makes every lane post a CLAIM comment on the issue it
# takes, so a bare updatedAt sweep counts this run's own claims and can never read 0.
# Count the issues whose BODY gained a checklist row instead.
gh issue list --state open --limit 200 --json number,title,updatedAt \
  --jq '.[] | select(.updatedAt > "<this run start ISO>") | .number' \
| while read -r n; do
    gh issue view "$n" --json body -q '.body' \
      | grep -qE '^[[:space:]]*- \[ \]' && echo "$n"
  done
```

Report one wrap line — `closed N / filed M (new K / folded J)` — and **when
M > N, give the reason in one more line**. `J` is the only number improvable
without missing or leaving a defect; `J = 0` is the HONEST answer for most runs
— it signals a spelling-not-concept search only once several findings in one
area are already filed. Only the first `M > N` reason is healthy:

- **the code really has that many independent defects** — say which untested
  area, so the next hunt aims there.
- **one root cause split into many issues** — §5's sweep rule should have
  folded them; fold what is still open into an umbrella now.
- **discoveries with session-only evidence were deferred** — re-read the `now`
  criteria in `CLAUDE.md`; a discovery whose repro dies with this session is
  not a residual, and the next session would re-derive it.

**`filed <= closed` (M <= N) is NOT a target, and must never become one.** The
goal is a correct codebase, not a short list: an unfiled finding is strictly
worse than a filed one — it removes the defect from the record while leaving it
in the product. Never let the count justify not filing, softening a finding, or
merging independent defects into one vague issue. If weighing whether to file,
file.

**Then run the PROMOTION check on every `next` this run filed — a deferral is
judged against the run that HAPPENED, not the one predicted when it was
written.** A QUERY, because nobody re-opens a decision they remember making
deliberately:

```bash
# For each issue this run filed, does the run's OWN merged diff touch a file
# that issue names? A hit means the deferral was written against a run that
# then went somewhere else.
RANGE="<the sha main was at when this run started>..origin/main"
git diff --name-only "$RANGE" | sort -u > /tmp/run-touched.$$
# The population is the issues this run FILED and left OPEN -- not the folded
# list above, and not the ones it filed and then fixed in the same lane, which
# section 3-a makes routine.
for n in <the numbers this run filed that are still open>; do
  b=$(gh issue view "$n" --json body -q .body)
  # The prose says every `next`; without this the loop also reports items
  # already classified `now`, which are not deferrals at all. `Session-fit`
  # carries no GitHub label, so it has to be grepped out of the body.
  printf '%s' "$b" | grep -q 'Session-fit: *next' || continue
  printf '%s' "$b" \
    | grep -oE '[A-Za-z0-9_][A-Za-z0-9_./-]*\.[a-z]+' | sort -u \
    | while read -r f; do
        # Suffix match, not equality: an issue body names a file by BASENAME far
        # more often than by full path (the bare file name, not the full
        # repo-relative one), and an exact whole-line compare misses
        # every one of those. Measured: the exact form fired on 1 of this run's 2
        # deferrals and missed the one whose body used the basename.
        grep -E "(^|/)$(printf '%s' "$f" | sed 's/[.[\*^$]/\\&/g')\$" \
          /tmp/run-touched.$$ | while read -r hit; do
            echo "PROMOTE #$n -- this run touched $hit"
          done
      done
done
rm -f /tmp/run-touched.$$
```

Pipe the whole loop through `sort -u`: a body naming a file twice prints twice,
reading as two findings.

**A hit is a prompt for judgement, not a verdict** — it cannot tell a citation
from a target (measured: one deferral hit its one target file; the other hit
four, three cited only as precedent). Do not skim a hit: do the item now while
the context is loaded, or re-classify it in the issue body with the reason it
still does not belong here.

**Re-read the REASON too — it can name a state that has since resolved.**
Classifying once at creation is right, but a reason phrased in the run's own
transient state ("the PR carrying it is still open", "a fifth review round")
goes FALSE when that state resolves (2026-08-26, go-to-k/cdkd#2259: deferred
while go-to-k/cdkd#2247 was in review; the reason survived unchanged into the
wrap after that PR merged). Re-reading an expired premise is not re-litigation;
keeping a `next` alive on a reason that stopped being true is.

### 10-a. Evidence: only what this run actually produced

Collect, with the concrete instance attached to each:

1. **Corrections the user made** — two on one theme across lanes is a defect in
   this text; the second occurrence is the signal, one alone may be a one-off.
2. **Text that was WRONG as written** — a failed command, a probe reporting a
   clear field while a lane was live, a flag / path / gate name that no longer
   exists.
3. **Steps you had to invent** because the skill is silent — the next run would
   re-invent them.
4. **Right instruction, wrong place** — done, but a step too late (claim posted
   after triage, rebase discovered after the phantom diff).
5. **Followed it and still paid** — the text was obeyed and a retry happened
   anyway.

**No evidence, no edit.** A clean run's output is one wrap line
("retrospective: no skill change — §2 / §4 / §8 held"). A skill grown from
"this would be nice" stops being read to the bottom, where §9 and §10 live.

### 10-b. Where the fix belongs — pick ONE

- **A hook** (`.claude/hooks/`) when the failure is mechanically detectable.
  Strongest, and the RIGHT answer when the rule was ALREADY in the text and got
  violated anyway — that proves the sentence is not load-bearing; escalate
  rather than restate. A claim that must stay in sync with the repo is a TEST,
  not a sentence.
- **This skill's stage file** — `references/<stage>.md`, the file covering the
  step where the lesson fires — for lessons about running THIS flow. Never the
  orchestrator `SKILL.md` (byte-capped by `tests/skill-file-payload.test.ts`;
  it changes only when the stage list changes).
- **Another skill**, only one this run actually exercised (`/verify-pr`,
  `/sweep-resources`, `/check`, `/check-docs`). `/hunt-bugs` produced the
  backlog but this flow never runs it — not this run's evidence.
- **`CLAUDE.md`, `DESIGN.md`, or `docs/`** when it applies to any work in this
  repo (the last two are in the `docs` gate's scope).
- **Memory** (`~/.claude/projects/.../memory/`) for judgmental cross-repo
  lessons. Weakest — the landing spot when nothing above can hold the rule, not
  the default.

**A cross-repo request outranks your own triage.** Inside a "handle this across
the repos in one session" ask, a discovery cannot be `Session-fit: next` —
three tells, any one forcing `now`: filing the SAME issue body in more than one
repo (the split the request exists to end); a mechanical fix whose evidence is
live now (repro built, files open, gate cycle running); or the user already
said "finish it here" for the surrounding task, which the discovery inherits. A
tidy `Effort` / `Estimate` for work the session is already positioned to do is
the tell the fields are an excuse, not a measurement (2026-08-20: a run fixing
inert sibling PreToolUse gates across cdkd, cdk-local and
go-to-k/cdk-real-drift filed the remaining script-level gap as three separate
issues until the user objected; then done in the same SESSION as a follow-up PR
per repo). "Same session" is the bar; "same PR" only when small enough to
review together.

### 10-c. How to edit: amend, do not append

Every run appending one more bullet is how a long skill becomes an unread one.

- Put the fix **in the step where it fires** — a claiming lesson belongs in §4.
  Gotchas is for traps that span steps, not a run log.
- **Amend the sentence that was wrong** rather than adding a sibling — two
  near-duplicate bullets blunt each other.
- **Carry the evidence inline** (date, issue / PR number, what happened) — a
  rule with no incident cannot be re-judged or retired later.
- **Pay for what you add**: cut a line this run proved stale, subsumed, or
  wrong. Net growth is fine for a new lesson; unbounded growth is not.
- Do not restate a rule living in `CLAUDE.md` or another step — point at it.
- A FLOW lesson (not a cdk-real-drift one) lands in all three repos in ONE
  session — this skill plus the same-named `work-issues` skill in the siblings,
  at `../cdkd` and `../cdk-local` RELATIVE TO THE REPO ROOT (from a
  `.worktrees/<lane>` cwd neither resolves; measured 2026-08-19). Adapt the
  wording per repo — gates and ship steps differ — as three worktrees, three
  PRs, three gate cycles (cdkd blocks tracked-file edits in its main worktree).
  All three is the DEFAULT: a one-repo-at-a-time hop is a duplicate GENERATOR —
  each landing session's own §10 retro files again into the other two
  (2026-08-19: go-to-k/cdkd#2011 / go-to-k/cdkd#2016, filed twenty minutes
  apart by two hops, were the SAME three cdk-local lessons).
  **Filing instead is a WHOLE-REMAINDER exception.** If the session cannot pay
  the remaining gate cycles, file into EVERY repo not yet landed, in ONE turn,
  each issue naming the other filings plus the repo already landed — partial
  filing produced the pair above. Carry §4's `Session-fit` line in each, in
  English.
  **A lane WORKING a mirror issue does not mirror onward** — the originating
  session owns all three landings; re-filing only adds copies. What IS new is
  what the ADAPTATION teaches (a differing gate name, a probe reading
  differently), itself subject to this bullet.
  **Batch a run's lessons into ONE PR per repo**, not one per lesson — the gate
  cycle is the per-PR cost (go-to-k/cdk-real-drift#1791 and
  go-to-k/cdk-real-drift#1792 landed in one lane, one PR).
  **Verify the copy against the TARGET repo, claim by claim, before shipping** —
  a sentence true here reads as authoritative there while false, and nothing
  lints instruction prose. A read-only reviewer per target repo — checking each
  gate name, hook behavior, skill name, path convention and cross-reference
  against that repo's files — caught four such false claims in the first mirror
  of this section (2026-08-18). This rule lives here, not in memory: memory is
  per-project-path and per-machine, so it would not load in the target repos.
  **Verify the MECHANISM at the SOURCE, not only the applicability at the
  TARGET.** The two feel like one check and are not. Applicability asks "does
  this repo have that gate / hook / file", which the target-repo reviewer above
  answers well. The mechanism asks "was the claim ever true where it was
  WRITTEN", and once a lesson is in transit nobody is positioned to ask it: the
  originating repo is no longer being read, and the target repo cannot see a
  defect in machinery it does not have. Measured 2026-09-03 on the mirror that
  produced this section's own edits: a lesson arrived describing a leaked
  `.markgate-pr-review-sha` as a FALSE PASS that would merge a PR on the
  strength of an already-merged one's review. The recon correctly ruled it
  INAPPLICABLE here — `pr-review` is inert in this repo and the sentinel file
  does not exist — and the framing was still wrong at the source: the siblings'
  `pr-review-gate.sh` passes only on `recorded_sha = head_sha`, so a leaked
  sentinel MISMATCHES and blocks, printing `bound to <sha> (mismatch)`. Fail
  CLOSED, not fail open; the real sibling cost is a confusing block naming an
  unrelated PR's sha. A correctly-REJECTED claim can still be false, and a
  mirror that only ever asks "does this apply here" launders it intact into
  every repo that DOES have the machinery. Reading the source hook cost two
  commands.
  **A recon or handoff report is a CLAIM SET, not a work list — re-derive its
  SCOPE, not only its citations.** The mirror that produced this section was
  handed a read-only recon that had checked every claim against this repo's
  files, and it was still stale in ten places and wrong about scope twice — both
  times UNDER-reporting. The false markgate-store claim sat at FIVE sites, not
  the three it named, and the two it missed were the `/check` and `/check-docs`
  skills — and `/check` is the ORIGIN the others point back at, so correcting only
  the three named would have left the source still asserting it. Adding one item
  to `verify.md`'s §8-z touched FOUR places rather than the one it flagged, and
  only TWO of those carried a digit that changed; the other two kept their
  numeral and moved their scope, so even a careful grep for numerals finds half
  the work and looks finished.
  The two error kinds are not equally dangerous. A drifted line number announces
  itself the moment you open the file, but an under-reported scope is SILENT: a
  lane that treats the list as complete lands a partial fix and reports it done,
  leaving the copies corrected and the original still asserting the falsehood —
  which is the drift shape §10-b fences, re-created by the very run sent to end
  it. So for every claim, grep for the OTHER sites before fixing the named one,
  and count what a list-shaped instruction says it contains.
  **The worked instance is this rule's own commit.** Correcting the probe-value
  undercount, that run fixed `hunt-bugs/references/plan.md` and left the
  identical sentence in `references/triage.md` saying "a mode and two paths" —
  one claim, two copies, one corrected, shipped in the very commit that adds the
  paragraph you are reading. A reviewer found it, not the author, which is the
  point: the author had just written the rule and still could not see the
  instance, because the second copy was in a file the finding did not name
  (2026-09-03, go-to-k/cdk-real-drift#1861).
  **Verify the cited EVIDENCE too — open the issue or PR the sentence names and
  confirm it says what the sentence claims.** Wrong evidence is wrong where
  WRITTEN and travels intact past every per-repo noun check: this file claimed
  go-to-k/cdk-real-drift#1761 was a flaky rc=0/rc=1 tsgolint artifact; the
  record is a DETERMINISTIC exit 134 (Vite+ stdout `EAGAIN` panic, 3/3 per
  go-to-k/cdk-real-drift#1765, no tsgolint), and it reached go-to-k/cdk-local#504
  verbatim before a reviewer caught it (go-to-k/cdk-real-drift#1768). Checking
  cost one command per record.
  **Write every issue / PR reference FULLY QUALIFIED — `owner/repo#N`, never a
  bare `#N` or half-qualified `cdkd#N` — in every skill doc, this section's own
  refs included.** A bare `#N` renders against whichever repo is READING it, so
  mirroring silently rewrites a correct citation: an unqualified `#1761` here
  lands on go-to-k/cdkd#1761 (real but unrelated), an unqualified `#1765` on
  go-to-k/cdk-local#1765 (nonexistent). Mechanically detectable, so per §10-b
  it is a TEST rather than a sentence: `tests/skill-doc-paths.test.ts` fails on
  any unqualified reference in ANY `.md` under `.claude/skills/**` —
  orchestrator `SKILL.md` files and `references/` stage files alike
  (go-to-k/cdk-real-drift#1796 landed the same change here and in cdk-local).
  It reads plain prose only, so this paragraph's counter-examples can stay
  written as code spans.

### 10-d. Ship it like any other change

MAIN-CHECKOUT: every worktree is gone by §9 and you are back on `main`, where
`branch-gate` blocks a commit — so the retro gets its own worktree. IN-PLACE:
§9 removed nothing and you are standing in the lane's tree on its (merged)
branch, so the retro takes a branch IN THAT TREE. The two blocks below are the
two cases; run exactly one.

MAIN-CHECKOUT (SKILL.md "Launch mode") — run THIS block, and not the next one:

```bash
# Date-suffix the branch: the previous run's branch was deleted on merge, so
# reusing the name re-creates it as an orphan ref that no PR tracks.
B=chore/work-issues-retro-$(date +%Y%m%d)
git worktree add ".worktrees/${B##*/}" -b "$B" origin/main
cd ".worktrees/${B##*/}"
mise trust && mise install    # untrusted .mise.toml: vp / markgate will not resolve
pnpm install                  # worktrees have no node_modules
```

IN-PLACE — run THIS block INSTEAD of the one above, never both: there is no
worktree to add, and `git worktree add` from inside this tree NESTS the very
worktree this mode exists to prevent. You are also not on `main`; the lane's own
tree is still here with its deps installed, so take the retro branch IN IT, and
the merged lane branch cannot be reused. `B` is re-assigned because a separate
fenced block is a separate shell (section 9's `MAIN` trap), and the switch is
addressed with `-C` for the reason §5 gives: a bare one after a cwd reset would
target the MAIN checkout rather than this lane. Since
go-to-k/cdk-real-drift#1845 `main-tree-branch-gate` REFUSES that instead of
letting it through, so the failure is loud — but a refusal is not a redirect,
and only the `-C` puts the branch in the tree you mean. Substitute the absolute
path the launch-mode probe printed as `LANE_TREE` and the opening report
recorded — captured while the cwd was
provably right — and do NOT re-derive it here from `$(git rev-parse
--show-toplevel)` or `pwd`, which resolve against the reset cwd and hand the
guard the very tree it is guarding against. Keep the `&&`: unchained, a failed
`fetch` still branches, off a stale `origin/main`. **Every command after this
one takes the same `-C "<LANE_TREE>"`** — the edits, `git add`, the commit, the
push, `gh pr create` — for the identical reason: this block never `cd`s, so a
later bare command runs in whatever tree the shell is standing in.

```bash
B=chore/work-issues-retro-$(date +%Y%m%d)
git -C "<LANE_TREE>" fetch origin \
  && git -C "<LANE_TREE>" switch -c "$B" origin/main
```

- `chore:` prefix — agent tooling, not `src/**`; a `fix:` / `feat:` prefix
  makes semantic-release describe a cdk-real-drift change that never happened.
- English only in every committed line (`non-english-text-gate` enforces at PR
  time).
- **`vp fmt` REWRITES this file's indentation, and that can change what a
  paragraph belongs to.** This repo's formatter covers markdown (the siblings'
  does not — measured 2026-08-19: the same probe file is rewritten here,
  "excluded by ignore rules" in cdkd and cdk-local), and it re-indents a
  paragraph following a nested list item from 2 spaces to 4, re-parenting it
  under that sub-bullet:

  ```text
  before                                    after `vp fmt`
  - A bullet.                               - A bullet.
    - A sub bullet that is new.               - A sub bullet that is new.
    **A bold lead paragraph.**                  **A bold lead paragraph.**
  ```

  Nothing fails — the file still renders, just saying something else (bit the
  go-to-k/cdk-real-drift#1793 lane: three verification paragraphs in section
  10-c absorbed into the clause above them). The shape that survives is a
  **bold lead paragraph at the parent bullet's own indent**, never prose
  trailing a sub-bullet; run `vp fmt` TWICE, confirm the second run is a no-op,
  and read the reformatted diff before committing — the damage is invisible in
  the source you typed.

- **A skill doc cannot cite a repo path in order to say it is ABSENT.**
  `tests/skill-doc-paths.test.ts` resolves every path-shaped code span in every
  `.md` under `.claude/skills/**`, with no negation exemption on purpose — a
  stale path would otherwise hide behind "no longer exists" phrasing, the class
  the fence exists to catch. Do not add an exemption; reword: the absence in
  PROSE ("this repo ships no multi-agent reviewer set and no `/review-pr`
  skill") passes, the same claim as a code span goes red (2026-08-28,
  go-to-k/cdk-real-drift#1829). Bites MIRROR lanes hardest — adapting a
  sibling's lesson often means stating its mechanism is missing here. Two fence
  details: a span is only checked when its FIRST segment is an existing
  top-level directory (an invented root is never checked; anything under the
  real `.claude` tree is), and `PATH_LIKE` needs a leading word character, so a
  skill name like `/review-pr` is never a path. A gate that DOES exist — the
  INERT `pr-review` entry in `.markgate.yml` — can still be cited by name. Run
  `vp test run tests/skill-doc-paths.test.ts` before the commit. It is not the
  only fence a prose-only diff can red, and treating it as such is how the other
  two get skipped: `tests/markdown-fmt-corruption-1771.test.ts` scans every
  tracked `*.md` for the `vp fmt` corruption signature, and
  `tests/check-scope-checker-inputs-1837.test.ts` reds when `/check`'s SKILL.md
  stops matching the `check` gate's real scope. On a prose-only diff, run all
  three — or just `vp test run`, which is cheap here.

- A `work-issues`-only edit is INSIDE the `check` gate's scope
  (`tests/skill-file-payload.test.ts` and `tests/skill-doc-paths.test.ts` read
  `.claude/skills/**`) and outside `docs`; `check-gate` verifies both markers on every
  commit and a fresh worktree starts with NONE — run `/check` + `/check-docs`
  there before the commit. `verify-pr-gate` exempts a diff with no `src/**`
  path, so `/verify-pr` is not required; CI must still be green for
  `ci-green-gate`. No `src/**` change also means no deploy: nothing for
  `/sweep-resources` to tear down, no `deploy-autoarm-gate` token to release.
- Do not let the small diff set the review depth. This repo has no reviewer
  ladder, so the depth is your own read of the whole diff plus the independent
  round §8 says you owe even after a lane's own — a wrong rule here propagates
  into every future session.
- **Merge it before the wrap report, then remove the worktree**
  (`git worktree remove .worktrees/<name> && git worktree prune`) — §9 ends
  with every worktree gone and §10 must not undo that. An IN-PLACE run added
  none, so instead this is where it runs §9's IN-PLACE cleanup arm — **the LAST
  step of the whole run**: `git switch <LAUNCH_BRANCH>` as-is (no pull, no
  rebase, no fast-forward) and `git branch -D` every branch this run created,
  the retro branch included. §9 deliberately does NOT do it per-lane, because
  THIS section branches in the same tree and would undo it. Leaving the tree on
  the retro branch — the previous instruction here — makes the unmerged-lane
  Stop hook warn every turn (the appendix has the wording), and detaching
  instead is visible-surprising in the outer tool's UI; restoring what the tool
  created is quiet on both counts. This is `Session-fit: now` on the leaves-main-self-inconsistent
  criterion (the skill would keep telling the next run to do what this run just
  proved wrong); its evidence dies with this session, and an open PR is NOT
  CLOSEABLE besides.

Then report the outcome in one wrap line: what changed, in which step, and the
run evidence behind it — or "no skill change" plus what held.

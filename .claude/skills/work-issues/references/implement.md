<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 5. One tree per lane, then implement

This stage (and stages 6-8) normally runs INSIDE a lane subagent the
orchestrator dispatched — one general-purpose agent per claimed issue, so the
lane's diffs, test output and review round-trips never land in the parent
context. Every rule below applies unchanged inside the lane: hooks fire on the
lane's tool calls, and markgate markers land in the lane's own worktree. Two
actions are reserved to the parent's serialization turn and are NOT the lane's
to start: a real-AWS live test (deploy → mutate → revert) and the merge (§9). A
lane stops at merge-ready and reports.

**That placement is live-proven**: this repo's own skill-split PR
(go-to-k/cdk-real-drift#1831), like its sibling go-to-k/cdk-local#621, was
built END-TO-END by a lane subagent — worktree, implementation, gates, CI —
with the parent doing only claims, serialized merges and cleanup, and every
hook and markgate gate firing inside the lane's calls exactly as in the parent.

**Before fixing, ask whether the defect has SIBLING SITES — and if it does,
sweep them in THIS lane rather than filing them.** Most defects here are a
CLASS, not an instance; once the root cause is named, grep for the same shape
across `src/` before writing the fix.

**Query for the PRECONDITION minus the REMEDY, never for the remedy alone.** A
grep for a MISSING thing returns only sites that already HAVE it — absent sites
are invisible by construction. Ask: what makes a site ELIGIBLE, and which
eligible sites lack the fix? (2026-08-27, cdk-local: a remedy grep saw 5 of 12
eligible sites; eligibility-minus-remedy found six more, plus a seventh neither
finds.) The same run then sized the residue from the ONE instance it hit ("one
site, ~30 min"; it was seven): **a count derived from the instance you happened
to hit is not a count**, and `Effort` / `Estimate` are what a future session
budgets from. The shape recurs wherever the fix is an ADDED guard: grepping for
the guard finds the types that have it.

**N sites of one root cause is ONE issue and ONE PR, never N issues.** Split
into N, each site pays the full fixed cost for the same edit, the reviewer
never sees the class, and sites 2..N sit open while site 1's fix drifts. Two
boundaries:

- **A sweep that would make the PR unreviewable is a genuine `next`** — file an
  explicit umbrella naming every site and which sites this lane DID close.
- **Sweep the same ROOT CAUSE, not the same AREA.** Two unrelated bugs in one
  file are two issues; one wrong assumption at five call sites is one. Test: a
  single sentence describes the fix at every site.

**A COUNT is a claim, and one RELAYED from a subagent is unearned.** Before a
relayed count goes anywhere durable, run the query yourself and paste the
command beside the number; a number arriving as a WORD ("nine sites") was
counted by a person or agent, command output by a machine (go-to-k/cdkd#2261:
"all nine sibling sites" was 78 across 14 files — ~9x, and it was the
load-bearing argument for a deferral). **Run it at the sha the artifact will
describe** and re-derive every number after the LAST fix round — bodies are
written once while the branch keeps moving (go-to-k/cdk-local#614: four
per-round-accurate counts all wrong at merge — a NEW file's true delta is vs
`main`, not the round start; three reached PR bodies). No automated fence
exists here — only §8's prose arm ("the CLAIMS are the artifact").

**And whatever you do file, resolve it against the issues ALREADY OPEN first.**
The code sweep finds sibling SITES; this finds a sibling ISSUE — written from a
DIFFERENT site by a different lane, naming different symbols. The case here is
prophylactic — this repo's one candidate pair (go-to-k/cdk-real-drift#1786 /
go-to-k/cdk-real-drift#1799) is NOT a duplicate — but the same cross-repo
mirror flow produced a VERIFIED duplicate pair nine minutes apart in a sibling
(go-to-k/cdk-local#528 / go-to-k/cdk-local#531), and the check costs one search
plus one line.

```bash
# Search the CONCEPT, not this instance's spelling — the same reason the code sweep
# above greps for a SHAPE rather than a name.
gh issue list --state open --limit 200 --search '<root-cause concept>' \
  --json number,title
# Then the body window, which the search index misses: an issue names its sites in
# the body, not the title.
gh issue list --state open --limit 200 --json number,title,body \
  --jq '.[] | select((.body // "") | test("<shared symbol / call / assumption>";"i"))
        | "\(.number)\t\(.title)"'
# `(.body // "")`, not `.body`: an issue filed with no body makes `test` abort the
# whole jq program with "null (null) cannot be matched", so one body-less issue
# silently costs you the entire window.
```

On a HIT, the finding becomes a CHECKLIST ROW in that issue rather than a new
issue number:

```bash
U=$(mktemp)   # NOT a fixed /tmp path — parallel lanes share the scratchpad
gh issue view <hit> --json body -q .body > "$U" \
  && [ -s "$U" ] \
  && printf -- '- [ ] <site>: <one line, plus where the evidence is>\n' >> "$U" \
  && gh issue edit <hit> --body-file "$U"
```

**The chaining and the `-s` test are load-bearing, not style.** The redirect
truncates `$U` before `gh` runs; unchained, a failed `view` leaves an empty
file, `printf` fills it with one row, and `edit` replaces the issue's WHOLE
body — destroying every previously folded finding, the outcome §10-0 says must
never happen. `mktemp` for the same reason at another scale: two overlapping
folds against one issue lose a row — never run them concurrently.

On a MISS, file it, and record the search in the body so the next lane can see
the window was checked:

```text
Dup-check: searched open issues for <terms> -- none covers this root cause
```

**This is not a filing threshold, and it must never be used as one.** §10-0:
`filed <= closed` is not a target, and an unfiled finding is strictly worse
than a filed one. This changes only WHERE a defect is written down, never
WHETHER.

Enforced by `.claude/hooks/issue-dup-check-gate.sh`, which refuses
`gh issue create` without the `Dup-check:` line; the same refusal covers
`gh api repos/<o>/<r>/issues` (the REST mint). `gh issue edit` /
`gh issue comment` are deliberately NOT gated.

- **Folding is not CHEAPER than minting** (one command vs three); the gate
  removes minting's advantage rather than creating one for folding.
- **`gh -R <owner/repo> issue create` IS matched** — §10-c's own
  mirrored-filing spelling, so it needs the `Dup-check:` line too. The shared
  `GATE_GH_C` absorbs repo flags in every spelling `gh` accepts — space, `=`,
  glued (`-Ro/r`) — after the `-C`-only form let `gh -R … pr merge` walk past
  three other gates. Unlike the `pr` gates it does NOT refuse a foreign `-R`:
  filing into a sibling is the point.
- **A `Dup-check:` line in the `--title` does not count** — the marker must be
  in a BODY value; the scan used to run over the whole command.
- **`gh api …/issues` reads are not gated** — the collection path is also the
  LIST endpoint (`-X GET … --paginate` and `-f state=open` pass); only an
  explicit `POST`, or a `title=` field with no method (gh infers POST), mints.

Never edit in the main checkout — `.claude/hooks/worktree-guard.sh` blocks an
Edit/Write to the main checkout's `src/**` or `tests/**` while any worktree
exists, and always allows a path under `.worktrees/`. Per lane, in
MAIN-CHECKOUT mode (`references/launch-mode.md` holds the probe that decides
which mode this is — the ONLY copy of it):

```bash
git worktree add .worktrees/<name> -b wt-<name> origin/main
mise trust .worktrees/<name>/.mise.toml
( cd .worktrees/<name> && pnpm install )     # worktrees have no node_modules
( cd .worktrees/<name> && vp run build )     # ...and no dist/ -- see below
```

`origin/main`, not local `main`, and both arms now agree. This one branched
from local `main` until 2026-09-01 — drift rather than a considered difference
(both siblings already spelled it `origin/main`). The reason recorded for
leaving it — that changing the base changes what `stale-base-gate.sh` sees —
had the direction backwards: that gate opens with
`git merge-base --is-ancestor "$base" HEAD || exit 0`, so a lane cut from a
stale local `main` made it exit 0 without looking — INERT for precisely this
shape. Basing on `origin/main` is what turns the gate ON for these lanes; the
change gains coverage rather than risking it.

**IN-PLACE mode (SKILL.md "Launch mode") skips that block entirely**: this run
was launched inside a linked worktree, so it keeps that tree and creates NO
WORKTREE — a nested one dies with the outer workspace, taking its uncommitted
work and leaving a registration that needs `git worktree prune`
(go-to-k/cdk-real-drift#1842). It does still take a BRANCH, in place, by the
recipe below. Deps and `dist/` are usually already there; run `pnpm install` /
`vp run build` only if they are not.

**Confirm the tree is YOURS before adopting it.** A stray `cd` into a peer's
live lane looks exactly like a workspace handed to you. This repo ships no
per-worktree session-owner sentinel (the sibling cdkd has one; do not go
looking for it here), so the probes are the three below plus the issue thread,
read for a claim naming this branch:

```bash
git -C "<LANE_TREE>" status --porcelain          # work you did not write
git -C "<LANE_TREE>" log --oneline -3            # whose branch this is
BR=$(git -C "<LANE_TREE>" branch --show-current)
# The emptiness test is load-bearing, not defensive style: this same file
# contemplates a DETACHED tree two paragraphs down, where `$BR` is EMPTY -- and
# `gh pr list --state all --head ""` exits 0 and returns EVERY PR in the repo
# (measured 2026-09-01 against this repo). Under the rule below ("any one saying
# someone is here means STOP") that is a guaranteed FALSE STOP on every detached
# adoption. Same empty-argument-retargets family that
# references/launch-mode.md records for `git -C ""`. Written as if/else rather
# than `&& ... || ...`: with the latter, a `gh` TRANSPORT failure would also
# take the second arm and report "detached" about a tree that is not.
if [ -n "$BR" ]; then
  gh pr list --state all --head "$BR"
else
  echo 'detached: no branch to query -- ownership rests on the two probes above plus the issue thread'
fi
```

**Every one of them takes `-C "<LANE_TREE>"` for the same reason the switch
below does, and omitting it costs more here than a wrong branch**: a bare probe
run after a cwd reset describes the MAIN checkout while READING as a
description of this lane — it answers "clean, no claim, no PR" about a tree
nobody asked about, and the run then adopts a peer's live lane believing it
checked. Read them under §9's rule that every ownership signal establishes LIFE
and never absence: any one of them saying "someone is here" means STOP and
report — never nest a worktree inside a peer's lane to get out of it.

This block comes BEFORE the branch recipe below because it GUARDS it, and a
previous revision had the two the other way round: a run following the file in
order took a peer's live lane off its branch and only then checked whose tree
it was. The order is the guard.

**Only once the tree is confirmed yours**: take a fresh branch here, ALWAYS,
without leaving the tree. This used to be conditional and the condition is
WITHDRAWN. The branch the tree arrived on is `LAUNCH_BRANCH`
(`references/launch-mode.md`): the OUTER TOOL's, not this run's, and §9 puts it
back untouched at the very end, so committing onto it would leave the run
nothing to restore and hand `gh pr merge --delete-branch` the outer tool's own
remote branch to delete (go-to-k/cdkd#2417).

```bash
# `-C <LANE_TREE>` is load-bearing. Until 2026-09-01 nothing here gated a
# branch switch, so a BARE `git switch -c` run after the shell's cwd had
# silently reset took the MAIN checkout off `main`, unblocked, in a tree other
# lanes share. `.claude/hooks/main-tree-branch-gate.sh` now REFUSES that
# (go-to-k/cdk-real-drift#1845), including the chained `fetch && switch -c`
# form and the two-tree spellings, so the failure is loud rather than silent.
# The `-C` stays, because a refusal is not a redirect: only `-C <LANE_TREE>`
# makes the command branch the RIGHT tree.
# Substitute the ABSOLUTE path the launch-mode probe printed as `LANE_TREE`
# and the opening report recorded -- the one value captured while the cwd was
# provably right. Do NOT re-derive it here as
# `$(git rev-parse --show-toplevel)` or `pwd`: both resolve against the same
# reset cwd, so the guard would answer "the main checkout" in exactly the case
# it exists for, and inherit the bug it is guarding.
#
# The `&&` is load-bearing too: unchained, a failed `fetch` still branches, off
# a stale `origin/main` -- the class `stale-base-gate.sh` exists to catch.
git -C "<LANE_TREE>" fetch origin \
  && git -C "<LANE_TREE>" switch -c wt-<name> origin/main
```

**Build BEFORE the first test run, and read a fresh worktree's failures with
that in mind.** A worktree starts with no `dist/`; a test spawning the built
CLI fails on the missing binary with an assertion about its SUBJECT, and the
main checkout (which HAS a `dist/`) passes, so every comparison points at main
(2026-08-27: a docs-only lane had begun writing up 13 such failures as "a peer
merge broke main"; `vp run build` made them green). **A fresh worktree failing
where the main checkout passes is evidence about the WORKTREE first.**

Do the fix in the lane's tree (match the existing table/entry pattern exactly;
ESM relative imports need the `.js` extension). **Always add a unit test that
fails without the fix and passes with it** — for a fold/FP fix use the issue's
exact harvested live model; for revert, assert the update document / patch op.
**Check first whether the artifact already has a harness** — fold-table entries
are covered generically (`tests/classify.test.ts`), and hook behavior by
standalone `.claude/hooks/*.test.sh` suites run BY HAND
(`bash .claude/hooks/<name>.test.sh` from the repo root): nothing in
`vp test run` or CI invokes those, so a hook change resting on a green suite
plus green CI is not verified at all. Run that harness FROM `.claude/hooks/`,
never from a copy parked elsewhere: every suite resolves its subject from its
OWN script path (`$(dirname "$0")` / `$(dirname "${BASH_SOURCE[0]}")`) with no
env override (`BUGHUNT_TRACKER_OVERRIDE` overrides the TRACKER script, not the
hook), so a copy in a scratch directory points at a sibling that is not
there and EVERY case fails on exit 127, reading as a regression you did not
cause (go-to-k/cdk-real-drift#1777: 13/13 pass in place, 13/13 fail copied
out). When diffing the OLD suite against your NEW hook, do NOT redirect
`git show origin/main:.claude/hooks/<name>.test.sh` into a temp file elsewhere
— write the copy BESIDE the real one as `.claude/hooks/_old-<name>.test.sh` and
delete it after. `tests/skill-doc-paths.test.ts` asserts this self-relative
resolution; amend the rule if a harness ever grows an override. Extend the
harness that exists before writing a new one beside it.

**When the fix is a repo-wide SCANNER — a test that greps every committed file
for a bad pattern — calibrate it against the PRE-FIX broken tree, and do not
implement the issue's signature literally.** An issue describes ONE instance,
not a rule with a measured false-positive rate: run the candidate over the
unrepaired tree, classify every hit by hand, and let the split decide the rule
(go-to-k/cdk-real-drift#1771 → go-to-k/cdk-real-drift#1782: the literal
signature flagged ~30 spots, mostly idiomatic prose; splitting by SIDE shipped
as before-side unconditional plus a short `s`/`es` suffix allowed after — 12/12
real hits, zero false positives). Then drive the failure direction as §8's
no-`src/**` tier requires: `git stash push <the repaired file>`, watch the scan
report the exact hits with line numbers, `git stash pop`.

**Calibration and that stash-pop drive read the SAME instances, so between them
they never show the rule catching a defect written a DIFFERENT way.** Follow
with two more probes against the real tree; every fence here got them on
2026-08-20 (go-to-k/cdk-real-drift#1797) and four of eight were dead:

- **Write the defect in EVERY spelling the language allows, and confirm each is
  flagged.** `tests/no-direct-tty.test.ts` asserted
  `not.toContain('stdin.isTTY')`, so `process.stdin['isTTY']`,
  `const { isTTY } = process.stdin` and `isatty(0)` from `node:tty` all passed.
  Source-side sibling go-to-k/cdkd#2111: a scanner matched `||` only while the
  tree already used `??`; widening it surfaced an unfiled real bug.

  **But when round three is still ADDING spellings, the instrument is wrong —
  change it rather than write a better pattern.** Measured 2026-08-29 in three
  repos at once, one defect class in a hand-rolled `.markgate.yml` reader: this
  repo's fence (go-to-k/cdk-real-drift#1838) learned to read `exclude` as
  block items, so the FLOW spelling still parsed to `exclude: []` and the
  tripwire stayed GREEN while markgate really did subtract from the scope; the
  sibling go-to-k/cdkd#2383 tallies four spellings across four rounds, ending
  on a YAML merge key splicing an `exclude` from a SIBLING gate — which the
  raw-text tripwire added as that very backstop did not fire on. **Three
  spellings in three rounds is the signal to stop patterning.** Two shapes end
  it, and neither is a sixth pattern: parse the config with a REAL parser
  (`yaml` is already a production dependency here), ALLOW-LIST the tool's own
  keys, fail CLOSED on anything outside them, and raw-scan the whole map; or,
  where no parser is available, REFUSE every shape the reader cannot model —
  the STRICTER option, not the weaker one.
  `tests/check-scope-checker-inputs-1837.test.ts` is this repo's worked
  example.

- **Delete the thing the fence REQUIRES, and watch it fail.** This finds a
  wrong POPULATION, and one derived from the DEFECT is the worst kind:
  `tests/gate-if-matchers-1801.test.ts` originally selected gates with
  `filter(h => h.condition.includes('Bash(git commit*)'))` — deleting the bare
  form dropped the gate OUT of the population instead of failing it, and
  disarming `stale-base-gate` / `ci-green-gate` outright stayed green. Three
  more that day: a TTY fence listing only 4 of 14 `src/commands/` files; a
  COUNT assertion over `.claude/hooks/*.test.sh` (measures harnesses that exist
  — cannot report `check-gate.sh`, which had none); a one-plugin-by-name lookup
  that missed why all 13 `type!:` merges released with no CHANGELOG entry
  (under semantic-release, since replaced by release-please).

And ask the dumbest question last: **is anything RUNNING it?** The
`.claude/hooks/*.test.sh` harnesses had no `vp run` task and no CI step —
shell, so `vp test run` never saw them (`vp run test:hooks` now runs them, in
CI too).

The general shape: **a fence is not evidence until you have watched it go red
on something you had not already counted.** Calibration says it is not noisy;
only the spelling and deletion probes say it is load-bearing.

**Restore from a BYTE-EXACT copy of the subject, never by inverting the edit.**
A probe deliberately breaks a file, so the restore is the half that has to be
right, and an inverse string replace is not one: measured 2026-09-02 on this
skill's own fences, a probe that deleted a line reverted with
`text.replace('', deleted_line)` — Python inserts between EVERY character —
turned an 11 KB stage file into 838 KB, and the three probes queued behind it
ran against the corrupted subject and returned verdicts about nothing. Copy the
file aside first and copy it back (`cp` / `shutil.copyfile`), then re-run the
suite and confirm GREEN before the next probe. `git checkout -- <file>` is not
the alternative: at probe time the fix itself is usually uncommitted, so that
discards the work along with the wreckage. Verify the restore by HASH, not by
eye — a `shasum -a 256` recorded before the first probe turns "I think I put it
back" into a check.

**Note WHICH work the copy protects: the bytes the subject held when the
snapshot was TAKEN.** Content written AFTER that point is reverted by the
restore, not preserved by it — a lane lost 133 lines of newly written tests to
precisely that (go-to-k/cdkd#2457). That is the destructive half of
`references/verify.md`'s pre-probe commit rule, and the two are complementary:
commit first so the restore cannot cost anything, snapshot byte-exactly so the
restore itself is not the corruption.

**Both probes above vary the INPUT. The second axis is the STATE the subject is
in when the input arrives, and that one gets enumerated by ACCIDENT** — every
case reuses the first case's fixture setup, so the suite covers one row of a
table it never drew (go-to-k/cdk-local#609: a commit gate twice shipped green
suites — 52 cases, then 93 — each hiding live fail-opens in file STATEs the
fixture never entered: untracked, tracked-but-modified, deleted on disk). DRAW
THE GRID: states on one axis, input shapes on the other, write the cells out —
uncovered cells become NAMEABLE, and the grid surfaces FALSE blocks a
one-dimensional suite cannot produce. Name the state axis from what the subject
READS: a `.claude/hooks/*.test.sh` case reads the TREE (clean, staged-only,
dirty, untracked-only, on `main`, on a branch, inside a worktree); a fold or
classify fence reads the TIER a property lands in (`declared`, `undeclared`,
`atDefault`, `readGap`) plus the empty-husk shape `isTrivialEmpty` pre-empts —
the row hand-picked cases most often skip, and where
go-to-k/cdk-real-drift#1647 lived.

**The spelling and deletion probes test the RULE; a third is needed when the
subject is a CLASSIFIER, because there the weak part is the POPULATION.** A
classifier decides which of several shapes an input is — `classifyTransient` /
`isDependencyViolation` (`src/revert/transient.ts`, `src/revert/apply.ts`),
`classifyStackStatus` / `isResourceNotFoundError` (`src/aws-errors.ts`),
`isNestedUndeclared` (`src/revert/plan.ts`). Its defects live in shapes nobody
wrote down, so hand-picked cases go green on exactly the regressions that
matter (go-to-k/cdkd#2001: a predicate shipped THREE green revisions, each
fixing the named case and breaking a neighbour). The fence that ends it is a
differential walk: enumerate the input space, run BOTH the new implementation
and a transcription of the old one (from `git show origin/main:<path>`, not
memory; confirm they agree where they SHOULD), and fail on any difference
outside an explicitly enumerated set of intended classes — a shape nobody
imagined fails by default. Two ways it goes inert, both measured on that lane:

- **Classify by the resulting VALUE, not by the input's shape.** Bucketing a
  differing cell by which input it was left a total regression inside the
  "intended repair" bucket — fence GREEN while nine ordinary cases caught it.
- **Carry a floor per class.** The walk reaches a class only if the input pool
  contains it; a pool that quietly stops covering a real intended class passes
  as "no regressions" — the same "measures what exists" failure as the COUNT
  assertion above.

Two traps for any markdown scanner: tokenize per PARAGRAPH, not per line — a
code span may WRAP a line break, and a per-line scan pairs one span's closing
backtick with the next one's opener, inventing findings in the prose between;
and report the line the HIT is on, not the paragraph start (a paragraph can run
100+ lines). When WRITING, keep each code span on one line — a wrapped span in
a list item also loses the continuation's indent to `vp fmt`.

**When the issue reports a stale ENTRY in an enumerated list, audit the whole
list, in BOTH directions, before fixing the named entry.** The defect class is
"this list drifted from the repo", and drift rarely produces exactly the
noticed instance. Check that every entry still resolves AND that everything
that belongs is present — the second half gets skipped because the issue only
names the first (go-to-k/cdkd#1972: one reported dead path in a
security-surface list; the audit found a second dead path plus four live
surfaces never added). Then make the recurrence mechanical: a list that must
stay in sync with the repo is a TEST, not a sentence
(go-to-k/cdk-real-drift#1767 — the mirror of this lesson — added
`tests/skill-doc-paths.test.ts`; it caught the class on its first run).

You may fan out **one subagent per lane** (disjoint files) to run them
concurrently — give each agent its worktree path, its allowed files, and an
explicit "do NOT touch other lanes' files; STOP and report if the fix needs a
forbidden file" guardrail. This file used to warn that a subagent's Bash
bypasses the PreToolUse gate hooks; that is measured FALSE — the
go-to-k/cdk-real-drift#1831 lane subagent had every gate hook fire on its own
calls exactly as in the parent. The gates are a backstop, not the plan, either
way: the orchestrator still holds the MERGE turn (§9).

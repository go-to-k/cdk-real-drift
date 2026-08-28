<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 5. One worktree per lane, then implement

This stage (and stages 6-8) normally runs INSIDE a lane subagent the
orchestrator dispatched — one general-purpose agent per claimed issue, so the
lane's diffs, test output and review round-trips never land in the parent
context. Every rule below applies unchanged inside the lane: hooks fire on the
lane's tool calls (measured on go-to-k/cdk-real-drift#1831, built end-to-end by
a lane subagent on 2026-08-28), and markgate markers land in the lane's own
worktree. Two actions are reserved to the parent's serialization turn and are
NOT the lane's to start: a real-AWS live test (deploy → mutate → revert) and
the merge (the orchestrator's serialization invariant; §9). A lane stops at
merge-ready and reports.

**Before fixing, ask whether the defect has SIBLING SITES — and if it does, sweep
them in THIS lane rather than filing them.** Most defects here are a CLASS, not an
instance; once the root cause is named, grep for the same shape across `src/`
before writing the fix.

**Query for the PRECONDITION minus the REMEDY, never for the remedy alone.** A
grep for a MISSING thing returns only sites that already HAVE it — absent sites
are invisible by construction. Ask: what makes a site ELIGIBLE, and which
eligible sites lack the fix? (2026-08-27, go-to-k/cdk-local: a remedy grep,
`docker rmi|docker image rm|docker image prune`, saw 5 of 12 eligible sites;
eligibility-minus-remedy — builds an image, never removes one — found six more,
plus a seventh neither finds.) The same run then sized the residue from the ONE
instance it hit ("one site, ~30 min"; it was seven): **a count derived from the
instance you happened to hit is not a count**, and `Effort` / `Estimate` are what
a future session budgets from. The shape recurs wherever the fix is an ADDED
guard (a missing `handledProperties` entry, a provider without a validation arm,
a type with no drift comparator): grepping for the guard finds the types that
have it.

**N sites of one root cause is ONE issue and ONE PR, never N issues.** Split into
N, each site pays the full fixed cost for the same edit, the reviewer never sees
the class, and sites 2..N sit open while site 1's fix drifts. Two boundaries:

- **A sweep that would make the PR unreviewable is a genuine `next`** — file an
  explicit umbrella naming every site and which sites this lane DID close.
- **Sweep the same ROOT CAUSE, not the same AREA.** Two unrelated bugs in one
  file are two issues; one wrong assumption at five call sites is one. Test: a
  single sentence describes the fix at every site.

**A COUNT is a claim, and one RELAYED from a subagent is unearned.** Before a
relayed count goes anywhere durable, run the query yourself and paste the command
beside the number; a number arriving as a WORD ("nine sites") was counted by a
person or agent, command output by a machine (2026-08-26, go-to-k/cdkd#2261:
"all nine sibling sites" was 78 across 14 files — ~9x, and it was the
load-bearing argument for a deferral). **Run it at the sha the artifact will
describe** and re-derive every number after the LAST fix round — bodies are
written once while the branch keeps moving (2026-08-27, go-to-k/cdk-local#614:
four per-round-accurate counts all wrong at merge — a NEW file's true delta is
vs `main`, not the round start; three reached PR bodies). Durable artifacts
stale the same way (this file's "nine" harnesses vs a measured 15). No automated
fence exists here — only §8's prose arm ("the CLAIMS are the artifact").

**And whatever you do file, resolve it against the issues ALREADY OPEN first.**
The code sweep finds sibling SITES; this finds a sibling ISSUE — written from a
DIFFERENT site by a different lane, naming different symbols. §10-c runs this
check rigorously but only for mirrored skill LESSONS; the mid-lane
defect-follow-up path, where the volume comes from, ran none. The case here is
prophylactic: this repo's one candidate pair (go-to-k/cdk-real-drift#1786 /
go-to-k/cdk-real-drift#1799) is NOT a duplicate — different source repos
(cdk-local's 2026-08-19 run vs cdkd's go-to-k/cdkd#2125) — but the same
cross-repo mirror flow produced a VERIFIED duplicate pair nine minutes apart in
a sibling (go-to-k/cdk-local#528 / go-to-k/cdk-local#531), and the check costs
one search plus one line.

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
truncates `$U` before `gh` runs; unchained, a failed `view` (wrong number,
non-repo cwd, transient error) leaves an empty file, `printf` fills it with one
row, and `edit` replaces the issue's WHOLE body — destroying every previously
folded finding, the outcome §10-0 says must never happen. `mktemp` for the same
reason at another scale: two overlapping folds against one issue lose a row —
never run them concurrently.

On a MISS, file it, and record the search in the body so the next lane can see
the window was checked:

```text
Dup-check: searched open issues for <terms> -- none covers this root cause
```

**This is not a filing threshold, and it must never be used as one.** §10-0:
`filed <= closed` is not a target, and an unfiled finding is strictly worse than
a filed one. This changes only WHERE a defect is written down, never WHETHER.

Enforced by `.claude/hooks/issue-dup-check-gate.sh`, which refuses
`gh issue create` without the `Dup-check:` line; the same refusal covers
`gh api repos/<o>/<r>/issues` (the REST mint). `gh issue edit` /
`gh issue comment` are deliberately NOT gated.

- **Folding is not CHEAPER than minting** (one command vs three); the gate
  removes minting's advantage rather than creating one for folding.
- **`gh -R <owner/repo> issue create` IS matched** — §10-c's own mirrored-filing
  spelling, so it needs the `Dup-check:` line too. The shared `GATE_GH_C`
  absorbs repo flags in every spelling `gh` accepts — space, `=`, glued
  (`-Ro/r`) — after the `-C`-only form let `gh -R … pr merge` walk past three
  other gates. Unlike the `pr` gates it does NOT refuse a foreign `-R`: filing
  into a sibling is the point.
- **A `Dup-check:` line in the `--title` does not count** — the marker must be
  in a BODY value; the scan used to run over the whole command, so
  `--title 'Dup-check: yes' --body '<no marker>'` satisfied it.
- **`gh api …/issues` reads are not gated** — the collection path is also the
  LIST endpoint (`-X GET … --paginate` and `-f state=open` pass); only an
  explicit `POST`, or a `title=` field with no method (gh infers POST), mints.

Never edit in the main checkout. Per lane:

```bash
git worktree add .worktrees/<name> -b wt-<name> main
mise trust .worktrees/<name>/.mise.toml
( cd .worktrees/<name> && pnpm install )     # worktrees have no node_modules
( cd .worktrees/<name> && vp run build )     # ...and no dist/ -- see below
```

**Build BEFORE the first test run, and read a fresh worktree's failures with
that in mind.** A worktree starts with no `dist/`; a test spawning the built CLI
fails on the missing binary with an assertion about its SUBJECT, and the main
checkout (which HAS a `dist/`) passes, so every comparison points at main
(2026-08-27: a docs-only lane had begun writing up 13 such failures as "a peer
merge broke main"; `vp run build` made them green). **A fresh worktree failing
where the main checkout passes is evidence about the WORKTREE first.**

Do the fix in the worktree (match the existing table/entry pattern exactly; ESM
relative imports need the `.js` extension). **Always add a unit test that fails
without the fix and passes with it** — for a fold/FP fix use the issue's exact
harvested live model; for revert, assert the update document / patch op.
**Check first whether the artifact already has a harness** — fold-table entries
are covered generically (`tests/classify.test.ts`), and hook behavior by
standalone `.claude/hooks/*.test.sh` suites run BY HAND
(`bash .claude/hooks/<name>.test.sh` from the repo root): nothing in
`vp test run` or CI invokes those, so a hook change resting on a green suite
plus green CI is not verified at all. Run that harness FROM `.claude/hooks/`,
never from a copy parked elsewhere: every suite resolves its subject from its
OWN script path (`$(dirname "$0")` / `$(dirname "${BASH_SOURCE[0]}")`) with no
env override (`BUGHUNT_TRACKER_OVERRIDE` overrides the TRACKER script, not the
hook), so a copy in a scratch directory points at a sibling that is not there
and EVERY case fails on exit 127, reading as a regression you did not cause
(2026-08-19, go-to-k/cdk-real-drift#1777: 13/13 pass in place, 13/13 fail
copied out). When diffing the OLD suite against your
NEW hook, do NOT redirect `git show origin/main:.claude/hooks/<name>.test.sh`
into a temp file elsewhere — write the copy BESIDE the real one as
`.claude/hooks/_old-<name>.test.sh` and delete it after.
`tests/skill-doc-paths.test.ts` asserts this self-relative resolution; amend
the rule if a harness ever grows an override. Extend the harness that exists
before writing a new one beside it.

**When the fix is a repo-wide SCANNER — a test that greps every committed file
for a bad pattern — calibrate it against the PRE-FIX broken tree, and do not
implement the issue's signature literally.** An issue describes ONE instance,
not a rule with a measured false-positive rate: run the candidate over the
unrepaired tree, classify every hit by hand, and let the split decide the rule
(2026-08-19, go-to-k/cdk-real-drift#1771 -> go-to-k/cdk-real-drift#1782: the
literal signature flagged ~30 spots, mostly idiomatic prose; splitting by SIDE
— letter-BEFORE-span 5/5 genuine, AFTER-side 6 of 13 the plural suffix
`` `remove`s `` — shipped as before-side unconditional plus a short `s`/`es`
allowed after: 12/12 real hits, zero false positives). Then drive the failure direction as §8's no-`src/**` tier
requires: `git stash push <the repaired file>`, watch the scan report the exact
hits with line numbers, `git stash pop`.

**Calibration and that stash-pop drive read the SAME instances, so between them
they never show the rule catching a defect written a DIFFERENT way** — spellings
the tree does not use today, contexts that defeat the exemption logic. Follow
with two more probes against the real tree; every fence here got them on
2026-08-20 (go-to-k/cdk-real-drift#1797) and four of eight were dead:

- **Write the defect in EVERY spelling the language allows, and confirm each is
  flagged.** `tests/no-direct-tty.test.ts` asserted
  `not.toContain('stdin.isTTY')`, so `process.stdin['isTTY']`,
  `const { isTTY } = process.stdin` and `isatty(0)` from `node:tty` all passed.
  Source-side sibling go-to-k/cdkd#2111: a scanner matched `||` only while the
  tree already used `??`; widening it surfaced an unfiled real bug.
- **Delete the thing the fence REQUIRES, and watch it fail.** This finds a
  wrong POPULATION, and one derived from the DEFECT is the worst kind:
  `tests/gate-if-matchers-1801.test.ts` (then named for
  go-to-k/cdk-real-drift#1786) selected gates with
  `filter(h => h.condition.includes('Bash(git commit*)'))`: deleting the bare
  form dropped the gate OUT of the population instead of failing it, and
  disarming `stale-base-gate` / `ci-green-gate` outright stayed green. Three
  more that day: a TTY fence listing only 4 of 14 `src/commands/` files; a
  COUNT assertion over `.claude/hooks/*.test.sh` (measures harnesses that exist
  — cannot report `check-gate.sh`, which has none); a one-plugin-by-name lookup
  missing `@semantic-release/release-notes-generator`'s absent `parserOpts`,
  why all 13 `type!:` merges released with no CHANGELOG entry.

And ask the dumbest question last: **is anything RUNNING it?** The
`.claude/hooks/*.test.sh` harnesses had no `vp run` task and no CI step — shell,
so `vp test run` never saw them (`vp run test:hooks` now runs them, in CI too).

The general shape: **a fence is not evidence until you have watched it go red on
something you had not already counted.** Calibration says it is not noisy; only
the spelling and deletion probes say it is load-bearing.

**Both probes above vary the INPUT. The second axis is the STATE the subject is
in when the input arrives, and that one gets enumerated by ACCIDENT** — every
case reuses the first case's fixture setup, so the suite covers one row of a
table it never drew (2026-08-27, go-to-k/cdk-local#609: a commit gate twice
shipped green suites — 52 cases, then 93 — each hiding live fail-opens in file
STATEs the fixture never entered: untracked, tracked-but-modified, deleted on
disk). DRAW THE GRID: states on one axis,
input shapes on the other, write the cells out — uncovered cells become
NAMEABLE, and the grid surfaces FALSE blocks a one-dimensional suite cannot
produce. Name the state axis from what the subject READS: a
`.claude/hooks/*.test.sh` case reads the TREE (clean, staged-only, dirty,
untracked-only, on `main`, on a branch, inside a worktree); a fold or classify
fence reads the TIER a property lands in (`declared`, `undeclared`, `atDefault`,
`readGap`) plus the empty-husk shape `isTrivialEmpty` pre-empts — the row
hand-picked cases most often skip, and where go-to-k/cdk-real-drift#1647 lived.

**The spelling and deletion probes test the RULE; a third is needed when the
subject is a CLASSIFIER, because there the weak part is the POPULATION.** A
classifier decides which of several shapes an input is — `classifyTransient` /
`isDependencyViolation` (`src/revert/transient.ts`, `src/revert/apply.ts`),
`classifyStackStatus` / `isResourceNotFoundError` (`src/aws-errors.ts`),
`isNestedUndeclared` (`src/revert/plan.ts`). Its defects live in shapes nobody
wrote down, so hand-picked cases go green on exactly the regressions that
matter (2026-08-21, go-to-k/cdkd#2001: a predicate shipped THREE green
revisions, each fixing the named case and breaking a neighbour). The fence that
ends it is a differential walk: enumerate the input space, run BOTH the new
implementation and a transcription of the old one (from
`git show origin/main:<path>`, not memory; confirm they agree where they
SHOULD), and fail on any difference outside an explicitly enumerated set of
intended classes — a shape nobody imagined fails by default. Two ways it goes
inert, both measured on that lane:

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
names the first (2026-08-19, go-to-k/cdkd#1972: one reported dead path in a
security-surface list; the audit found a second dead path plus four live
authn / credential / exec surfaces never added). Then make the recurrence
mechanical: a list that must stay in sync with the repo is a TEST, not a
sentence. go-to-k/cdk-real-drift#1767 — the mirror of this lesson — added
`tests/skill-doc-paths.test.ts`, asserting every repo path a SKILL.md cites
still resolves; it caught the class on its first run.

You may fan out **one subagent per lane** (disjoint files) to run them
concurrently — give each agent its worktree path, its allowed files, and an
explicit "do NOT touch other lanes' files; STOP and report if the fix needs a
forbidden file" guardrail. This file used to warn that a subagent's Bash
bypasses the PreToolUse gate hooks; that is measured FALSE — on 2026-08-28 the
go-to-k/cdk-real-drift#1831 lane subagent had every gate hook fire on its own
calls exactly as in the parent. The gates are a backstop, not the plan, either
way: the orchestrator still holds the MERGE turn (§9).

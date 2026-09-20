<!-- /work-issues stage file (§5); stage map in ../SKILL.md. A bare §N points into the file holding that section. READ IN FULL at stage entry. -->

## 5. One tree per lane, then implement

Stages 5–8 normally run INSIDE a lane subagent, one per claimed issue; the
real-AWS live test and the merge (§9) stay with the parent, so a lane stops at
merge-ready and reports. Every rule below holds there.

### 5-a. The tree

Never edit in the main checkout — `.claude/hooks/worktree-guard.sh` blocks an
Edit/Write to its `src/**` or `tests/**` while any worktree exists, and always
allows a path under `.worktrees/`. MAIN-CHECKOUT mode, per lane
(`references/launch-mode.md` holds the mode probe — the ONLY copy):

```bash
git worktree add .worktrees/<name> -b wt-<name> origin/main
mise trust .worktrees/<name>/.mise.toml
( cd .worktrees/<name> && pnpm install )     # worktrees have no node_modules
( cd .worktrees/<name> && vp run build )     # ...and no dist/
```

`origin/main`, not local `main`: cut from a stale local `main`,
`stale-base-gate.sh` exits 0 without looking (`git merge-base --is-ancestor
"$base" HEAD || exit 0`) and is INERT for this shape. **Build BEFORE the first
test run**: with no `dist/` a test spawning the built CLI fails with an assertion
about its SUBJECT while the main checkout passes, so **a fresh worktree failing
where the main checkout passes is evidence about the WORKTREE first.**

**IN-PLACE mode creates NO worktree** (a nested one dies with the outer
workspace, taking its uncommitted work); deps and `dist/` are usually there
already. **Confirm the tree is YOURS before adopting it** — a stray `cd` into a
peer's live lane looks exactly like a workspace handed to you. With no
session-owner sentinel in this repo the probes are these plus the issue thread,
read for a claim naming this branch; a signal establishes LIFE and never absence,
so any one saying "someone is here" means STOP and report.

```bash
# Every probe takes -C "<LANE_TREE>", the ABSOLUTE path the probe printed: a bare
# one after a cwd reset describes the MAIN checkout while READING as this lane
# ("clean, no claim, no PR").
git -C "<LANE_TREE>" status --porcelain          # work you did not write
git -C "<LANE_TREE>" log --oneline -3            # whose branch this is
BR=$(git -C "<LANE_TREE>" branch --show-current)
# The emptiness test is load-bearing: `gh pr list --head ""` exits 0 returning
# EVERY PR -- a false STOP on any detached tree. if/else, not `&& ... || ...`:
# a gh TRANSPORT failure would also report "detached".
if [ -n "$BR" ]; then
  gh pr list --state all --head "$BR"
else
  echo 'detached: ownership rests on the probes above plus the issue thread'
fi
```

**Only once the tree is confirmed yours**: take a fresh branch, ALWAYS, without
leaving the tree. The branch it arrived on is `LAUNCH_BRANCH`, the OUTER TOOL's,
which §9 puts back untouched — committing onto it leaves nothing to restore and
hands `gh pr merge --delete-branch` the outer tool's remote branch.

```bash
# `-C <LANE_TREE>` is load-bearing: a bare `git switch -c` after a cwd reset
# branches the MAIN checkout, which other lanes share -- and never re-derive the
# path as `$(git rev-parse --show-toplevel)` or `pwd`, which resolve against that
# same reset cwd. Unchained, a failed fetch still branches off a stale
# origin/main.
git -C "<LANE_TREE>" fetch origin \
  && git -C "<LANE_TREE>" switch -c wt-<name> origin/main
```

### 5-b. Sweep the class, not the instance

**Before fixing, ask whether the defect has SIBLING SITES — and if it does, sweep
them in THIS lane rather than filing them.** Most defects here are a CLASS: once
the root cause is named, grep the shape across `src/`.

- **Query for the PRECONDITION minus the REMEDY**: a grep for a MISSING thing
  returns only the sites that already HAVE it, so ask what makes a site ELIGIBLE
  and subtract the ones carrying the fix.
- **N sites of one root cause is ONE issue and ONE PR, never N** — split, and the
  reviewer never sees the class while sites 2..N sit open against a drifting fix
  1. A residue carrying its OWN verification is a genuine `next`: file an
     umbrella naming every site and the ones this lane closed, justified by that
     verification, never by review size. Sweep the same ROOT CAUSE, not the same
     AREA (test: one sentence describes the fix at every site).
- **A COUNT is a claim, and one RELAYED from a subagent is unearned** — run the
  query yourself, paste the command beside the number, **at the sha the artifact
  describes**, re-deriving after the LAST fix round.
- **A stale ENTRY in an enumerated list means auditing the whole list, in BOTH
  directions**: every entry still resolves AND everything that belongs is present
  (the issue names only the first half). Then make it mechanical — a list that
  must track the repo is a TEST, not a sentence
  (`tests/skill-doc-paths.test.ts`).

### 5-c. What you do NOT fix here

**A TOOLING finding — hooks, skills, rules, CI — is recorded in
`docs/tooling-backlog.md`, never filed as an issue.** For a product defect,
**resolve it against the issues ALREADY OPEN first**: the code sweep finds
sibling SITES, this finds a sibling ISSUE, written from a different site by
another lane and naming different symbols.

```bash
# Search the CONCEPT, not this instance's spelling.
gh issue list --state open --limit 200 --search '<root-cause concept>' \
  --json number,title
# Then the body window the search index misses: an issue names its sites in the
# body, not the title. `(.body // "")`, not `.body`: one body-less issue makes
# `test` abort the whole jq program and silently costs you the entire window.
gh issue list --state open --limit 200 --json number,title,body \
  --jq '.[] | select((.body // "") | test("<shared symbol / call / assumption>";"i"))
        | "\(.number)\t\(.title)"'
```

On a HIT the finding becomes a CHECKLIST ROW in that issue, not a new number:

```bash
U=$(mktemp)   # NOT a fixed /tmp path — parallel lanes share the scratchpad
gh issue view <hit> --json body -q .body > "$U" \
  && [ -s "$U" ] \
  && printf -- '- [ ] <site>: <one line, plus where the evidence is>\n' >> "$U" \
  && gh issue edit <hit> --body-file "$U"
```

**The chaining and the `-s` test are load-bearing**: the redirect truncates `$U`
before `gh` runs, so unchained, a failed `view` leaves an empty file, `printf`
fills it with one row, and `edit` replaces the issue's WHOLE body, destroying
every finding folded in before. Never run two folds against one issue at once.
This changes WHERE a defect is recorded, never WHETHER (§10-0).

### 5-d. The fix itself

Fix in the lane's tree, matching the existing table/entry pattern exactly.
**Always add a unit test that fails
without the fix and passes with it** — for a fold/FP fix use the issue's exact
harvested live model; for revert, assert the update document / patch op.

**Check first whether the artifact already has a harness**: fold-table entries
are covered generically (`tests/classify.test.ts`), hook behaviour by
`.claude/hooks/*.test.sh`, which `vp run test:hooks` runs in CI. Run a hook suite
FROM `.claude/hooks/` — each resolves its subject from its OWN script path
(`$(dirname "$0")`) with no env override, so a copy parked elsewhere fails EVERY
case on exit 127, reading as a regression you did not cause; diff an old suite as
`.claude/hooks/_old-<name>.test.sh`, deleted after. Extend the harness that
exists rather than writing a new one beside it.

### 5-e. Fences and mutation probes

**A fence is not evidence until you have watched it go red on something you had
not already counted**: calibration says it is not noisy, only the probes say it
is load-bearing.

- **Calibrate a repo-wide SCANNER against the PRE-FIX broken tree, not the
  issue's wording**: classify every hit by hand, let the split decide the rule,
  then drive the failure direction (`git stash push <the repaired file>` → hits
  with line numbers → `git stash pop`).
- **Write the defect in EVERY spelling the language allows** —
  `not.toContain('stdin.isTTY')` misses `process.stdin['isTTY']`, destructuring
  and `isatty(0)`. **When round three is still ADDING spellings the instrument is
  wrong**: parse the config with a REAL parser (`yaml` is a production
  dependency), allow-list the tool's own keys and fail CLOSED outside them; with
  no parser, REFUSE every shape the reader cannot model.
- **Delete what the fence REQUIRES and watch it fail** — this finds a wrong
  POPULATION, worst when derived from the DEFECT: a selector keyed on a bare
  condition string drops the gate OUT of the population instead of failing it, so
  disarming a gate stays green (`tests/gate-if-matchers-1801.test.ts`). A COUNT
  over files that exist cannot report the missing case.
- **A CLASSIFIER cannot be fenced by hand-picked cases** — its defects live in
  shapes nobody wrote down (`classifyTransient`, `classifyStackStatus`,
  `isResourceNotFoundError`, `isNestedUndeclared`). Walk an enumerated input
  space against a transcription of the OLD implementation
  (`git show origin/main:<path>`, not memory), failing on any difference outside
  the intended classes, bucketed by resulting VALUE (by INPUT hides a regression
  inside "intended repair") and with a floor per class.
- **An assertion's EXEMPTION is the enumeration the property replaced.** Assert
  the whole class PER MESSAGE, not over a join (then no separator needs
  exempting), assert the VALUE rather than `out === input` (blind wherever the
  subject maps a value to itself), and keep the expected value INDEPENDENT of the
  one under test — a TRANSCRIBED class needs a behaviour fence over its WHOLE
  domain, against the copy **IN USE**.
- **The second axis is the STATE the subject is in when the input arrives**,
  enumerated by ACCIDENT since every case reuses the first fixture. DRAW THE GRID
  — states against input shapes — naming states from what the subject READS: a
  hook suite reads the TREE (clean, staged-only, dirty, untracked-only, on
  `main`, on a branch, in a worktree); a fold/classify fence reads the property's
  TIER (`declared`, `undeclared`, `atDefault`, `readGap`) plus the husk shape
  `isTrivialEmpty` pre-empts.
- **COMMIT the round's real fixes BEFORE any probe, and restore from a BYTE-EXACT
  copy** (`cp` out, `cp` back, verified by `shasum -a 256`), re-running to GREEN
  before the next probe. An inverse string replace is not a restore
  (`text.replace('', line)` inserts between EVERY character); the copy protects
  only the bytes held when TAKEN; `git checkout -- <file>` discards the
  uncommitted fix with the wreckage.
- And ask the dumbest question last: **is anything RUNNING it?** (A markdown
  scanner also tokenizes per PARAGRAPH, not per line: a code span may WRAP a line
  break, and a per-line scan pairs one span's closing backtick with the next
  one's opener.)

### 5-f. Fan-out mechanics

You may fan out **one subagent per lane** (disjoint files): give each its tree
path, its allowed files, and an explicit "do NOT touch other lanes' files; STOP
and report if the fix needs a forbidden file" guardrail. Hooks fire on a lane's
own calls as in the parent, but they are a backstop, not the plan: the
orchestrator still holds the MERGE turn (§9).

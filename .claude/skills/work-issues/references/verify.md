<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 8. Verify before merge (`/verify-pr`)

Run `/verify-pr`. Its live-test rules decide how each PR is verified:

**Run the integ LAST, and DECLARE the tree final, in words, to whoever is still
editing it.** The `integ` gate is `hash: diff` over `src/**` and
`tests/integration/**`: even a comment-only review fix to an in-scope file
stales the marker and costs a full fixture run (three real-AWS runs of one
fixture, the third for a zero-non-comment round — 2026-08-26,
go-to-k/cdkd#2261). Tell the implementer to batch all remaining findings into
ONE commit and report when the tree is FINAL — unsaid, it will re-verify per
finding. Reviewer-side: scope the round to the delta and take its findings all
at once, not trickled.

- **fold / FP / classify fix** → the harvested **corpus** case is authoritative
  live data. If it is pinned by `vp test run corpus-replay` AND was live-proven
  in its originating hunt (the issue carries the real repro), that IS the live
  evidence — no fresh deploy. State the deferral explicitly.
- **toolchain / CI / skill fix (nothing under `src/` in the diff)** → no
  live-test tier, no corpus; `verify-pr-gate` exempts the diff — an exemption
  from the LIVE test, not from verifying. A diff doing both owes both arms
  (go-to-k/cdk-real-drift#1774: undivided, this tier sent a pure prose diff to
  run a command 3–5×, which for a SKILL.md edit does not exist):
  - **It changes what a command or gate DOES** (a `vite.config.ts` task,
    lint/typecheck config, `.github/workflows/ci.yml`, `.claude/hooks/` logic)
    → the verification IS that command, run 3–5× BEFORE and AFTER, FAILURE
    direction driven too. Run _the command your own diff changes_: the hook's
    own `.claude/hooks/<name>.test.sh`, the workflow step's own command, the
    changed task. `vp run check` format-checks `ci.yml` as text and never
    EXECUTES a step or hook — a probe that cannot fail (2026-08-19:
    `vp fmt --check .github/workflows/ci.yml` passes on any semantic change).
    Measure as recorded below.
  - **It changes PROSE only** (a skill, rule, doc — including this file) → the
    CLAIMS are the artifact; repeating an adjacent command 5× measures nothing.
    Resolve every gate, hook, skill, path, task and command the text names
    against this repo's own files, and RUN each command it sends the next agent
    to run, confirming the output matches the promise — §10-c's claim-by-claim
    pass, owed even for text ported from a sibling;
    `tests/skill-doc-paths.test.ts` mechanizes the path/issue-ref halves.

- **A fixture that establishes the fix's PRECONDITION on the happy path cannot
  test the arm where the FAILING path creates it** — every signal says pass
  (go-to-k/cdkd#2125 shipped past unit tests, a real-AWS fixture and four
  reviewers). Here the state is the BASELINE `record` writes under
  `.cdkrd/baselines/` and the rules `ignore` appends: a `verify.sh` that runs
  `record` and only THEN mutates never exercises the `record`-less first-run
  path where the FIRST `check` both creates the situation and must handle it.
  When a fix keys on state an earlier step wrote, ask **which step writes it in
  the fixture, and which in the reachable case**; if they differ, add the arm
  where one operation does both, and prove it DISCRIMINATES by mutating the
  fix: the ORIGINAL arm still passes, the new one fails — an arm failing with
  the old one shows nothing new.
- **A `cleanup` that ALSO runs before the run must not destroy anything the run
  then needs.** `WORKDIR="$(mktemp -d …)"` at load time + `rm -rf "$WORKDIR"`
  in `cleanup` + a pre-run `cleanup` call: the directory is gone before its
  first write, and the symptom is a bare `No such file or directory` hundreds
  of lines from the cause (cost a real-AWS cycle in cdkd). AWS resources are
  immune — creating them IS a phase — a scratch path computed at
  variable-definition time is not. Anything `cleanup` removes must be
  re-created by a phase or created after the pre-run call. This repo's fixtures
  arm `trap cleanup EXIT` with no pre-run call; if you add one, dry-run against
  stubs first.
- **When a fix round produces the NEXT round's blocker twice, stop reviewing
  the patch and question its SHAPE** (`/verify-pr` step 5 re-reads the whole
  diff each run and re-decides review depth at the final sha). Each fix is
  locally correct and moves the failure one layer out; blockers are found by
  executing a probe, never by re-reading the diff. After round two, name what
  the rounds have in COMMON — usually one structural absence — then take the
  NARROW fix, file the structural one, and reference it from the narrow fix;
  new code at round five is how round six happens.

  **Filing the structural fix does not STOP the cascade**
  (go-to-k/cdk-local#596, 2026-08-27: filed at round five, ran to TWELVE —
  eleven instances of one defect class in one PR, five introduced by fixes).
  What ended it: making the artifact **CLAIM LESS** — the sweep now prints raw
  output and names both outcomes instead of a verdict, because a command that
  claims nothing cannot claim something false. The tell is each fix being more
  SOPHISTICATED than the last while the plain rc-only sweeps beside it were
  right throughout: `grep -q 'does not exist'` also matches botocore's
  `The source_profile ... does not exist`, raised before any network call, so
  a broken profile reported CLEAN having queried nothing. The sophistication
  WAS the defect; expect the fix to feel like a retreat — it converges.

  Corollaries, both paid for there:
  - **Fence the REMEDIATION, not just the detection.** A destroy built from
    names missing a required suffix exits 0 SILENTLY — success read with the
    resources still deployed; every fence pinned the DETECTION, so restoring
    that line left the suite green. If a procedure both detects and repairs,
    the repair is where the next instance goes.
  - **Do not pre-commit to a remedy for a finding you have not seen.** "If
    instance nine appears, delete the whole thing" — when it arrived, deleting
    would have left NO check at all. Say what the next finding would have to
    SHOW, not what you will do about it.

  Two shapes recur, distinguishable a round apart:
  - **TWO SPELLINGS OF ONE QUESTION** — make both sites use ONE predicate
    verbatim; a better second spelling passes its own test and regenerates the
    cascade. Name the SITE THAT OWNS the question; every other site calls or
    copies it exactly (go-to-k/cdkd#2134: ended only when the authority's test
    was copied character for character — the round before, the spellings still
    disagreed on the empty string, fail-OPEN).
  - **A PROXY FOR A QUESTION ONLY ANOTHER COMPONENT CAN ANSWER** — make that
    component REPORT. The tell: each proxy is wrong in BOTH directions at once
    (misses real cases AND fires on unreal ones; two spellings merely disagree
    at an edge). When a fix lands on a new OBSERVABLE — "it threw", "the text
    survived", "a marker exists" — ask whether the fact is derivable outside
    the component that decides it; if not, the rounds are unbounded
    (go-to-k/cdkd#2157 / go-to-k/cdkd#2166: "it THREW" missed the
    warn-and-continue path and over-reported an unrelated failure in the same
    bag; "raw text SURVIVED" missed downstream rewrites, broke on JSON
    escaping, fired on PROSE mentioning the syntax). Drift analogue: any
    question only AWS's own readback can answer — "genuinely drifted, or never
    returned by the provider?" — which is why the corpus outranks any predicate
    reasoned about in isolation.

- **WITHDRAWING the half that cannot be made right is a legitimate outcome, and
  the residual issue must carry the MEASUREMENTS, not just the diagnosis** —
  each proxy tried, the input that broke it, the number it produced; a
  diagnosis alone makes the next session re-run every probe. Worked example:
  go-to-k/cdkd#2166 (three rounds of measurements plus a live arm written,
  passed, mutation-probed, then reverted — none of it rebuilt).
- **When two reviewers CONTRADICT each other, settle it in the code YOURSELF
  before forwarding either** — forwarding both hands the implementer a
  contradiction with LESS context than you have; forwarding only the reassuring
  one is how a blocker ships. Read the disputed lines; say which reviewer was
  right and why — routine whenever a lane, or you, dispatch read-only reviewers
  (see the round below, which this repo has no ladder to run for you).

  What to measure in the command arm (all confirmed here 2026-08-19,
  go-to-k/cdk-real-drift#1768):
  - **An exit code can lie in EITHER direction, so drive both.** _Non-zero
    meaning nothing_: `vp run check` exited **134** on a clean tree with **0
    errors** (Vite+ stdout `EAGAIN` panic), deterministic 3/3 per state, 0
    after the one-line build-config fix (go-to-k/cdk-real-drift#1761 /
    go-to-k/cdk-real-drift#1765); the hazard is a redirect swallowing the exit
    code turning a RED tree green — hence
    `tests/vp-run-check-redirect-1761.test.ts` asserting the `exit 1` survives.
    _Zero meaning nothing_: no measured case here; cite the sibling's
    go-to-k/cdk-local#504 (`vp test run` rc=0,0,1,0,1 across five identical
    all-passing runs) as the sibling's, and measure the command YOU changed.
  - **`vp pack` BEFORE reading any `vp run test` verdict in a fresh worktree —
    and re-run a red from that one file before believing it.** No `dist/`
    fails 13 tests of `tests/json-empty-on-error.test.ts` deterministically
    (they spawn the built CLI); with `dist/` freshly packed, three of the 13
    failed once and the identical re-run went 343/343 rc=0. Tell them apart by
    the COUNT — 13 failures means no `dist/`, fewer means the flake — and
    never let a single red run stand as the verdict.
  - **Repeating a `vp run <task>` DOES re-execute here** — `check` (5/5) and
    `test` (3/3) reported `not cached because it modified its input`. Do not
    import the sibling's cache-hit warning; the local cache trap (PR
    go-to-k/cdk-real-drift#438: a cached GREEN `typecheck` masked a real
    TS1117) is already handled by `cache: false` in `vite.config.ts`.
  - **Inject the failure anywhere LINTED — here that includes the tests
    tree.** A non-underscore-prefixed unused variable fails `vp run check`
    rc=1 from `src/` AND from `tests/` (`lint.ignorePatterns` re-includes the
    tests tree, excluding only `tests/integration/`). cdk-local's lint is
    source-only, so its "never inject into the tests tree" clause is FALSE
    here — the drift §10-c's per-repo check exists to catch.
  - **Then guard the SHAPE of the fix**, since nothing else re-checks a config
    or hook line: a unit test on the config object for a build-config change
    (the go-to-k/cdk-real-drift#1765 test above), or the standalone hook suite
    for a `.claude/hooks/` change — which §5 notes you must run BY HAND.

  Both arms end in writing, and `vp fmt` mangles a paragraph that uses bold
  AND contains a double-star glob inside a code span — it corrupted this very
  passage when go-to-k/cdk-real-drift#1766 added it. Now a GATE:
  `tests/markdown-fmt-corruption-1771.test.ts` fails on both the trigger
  construct and the damage; write the plain directory (`src/`, `tests/`) in a
  bold paragraph. Root cause + toolchain bump: go-to-k/cdk-real-drift#1771 /
  go-to-k/cdk-real-drift#1780.

- **transport / client-config change** (`src/read/client-config.ts`
  requestHandler / agents / timeouts, proxy routing) → live-verify with ZERO
  deployed resources: `check` on an UNDEPLOYED unique-named stack still makes
  real AWS calls (STS + CloudFormation DescribeStacks) and exits 0 with "not
  deployed yet — skipped", so the transport is exercised end-to-end with
  nothing to sweep and no sentinel armed. The oracle is whatever observes the
  transport — for go-to-k/cdk-real-drift#1841 (PR
  go-to-k/cdk-real-drift#1852) a ~25-line local logging HTTP CONNECT proxy
  proved every call tunneled, plus dead-proxy (no silent direct fallback),
  `NO_PROXY` bypass, and no-proxy control arms. Reach for the deploy tier below
  only when the change needs a real RESOURCE, not just real calls.
- **revert / read HOT-PATH fix** → live-verify with a MINIMAL, UNIQUE-named
  fixture: deploy → mutate out of band → `check` detects → `revert --yes`
  converges → confirm the live value. A throwaway CDK app works:
  `/tmp/<name>/app.cjs` (require-style CJS so classic module resolution works;
  **ESM `import` ignores `NODE_PATH`**), and `ln -s <repo>/node_modules
node_modules` to borrow `aws-cdk-lib` (rm any existing dir first — `ln -sfn` into
  an existing dir nests a symlink). Inline/no-asset stacks need no bootstrap. Build
  the FIX binary with `vp pack` and run `node "<LANE_TREE>/dist/cli.js"` —
  the absolute path from the launch-mode probe, not `.worktrees/<w>/…`, which
  is wrong twice: it is relative to the main checkout, and an IN-PLACE launch
  tree (an Orca/ADE workspace) need not live under `.worktrees/` at all.

**Fresh deploys: UNIQUE hunt-style stack names only** (`Cdkrd<issue>Verify`),
never a shared fixed name and never a real prod stack — the account may hold
the maintainer's production stacks. **Tag every ephemeral deploy
`cdkrd:ephemeral=1`** (`Tags.of(app).add('cdkrd:ephemeral','1')`, or `aws
cloudformation deploy --tags cdkrd:ephemeral=1`) so the generic sweep net can
find it whatever its type.

**Cleanup is enforced, not optional.** The `deploy-autoarm-gate` hook ARMS this
session's own bughunt-clean token on any deploy command, so YOUR commit / PR is
BLOCKED until you release it — even for a throwaway `/tmp` app (a peer
session's commits are not blocked). After the live-test, run
**`/sweep-resources`**: it tears down with `delstack` (never `cdk destroy`),
sweeps the stack-EXTERNAL orphans `delstack` can't reach (auto-created
`/aws/lambda/*` + API-GW CloudWatch **IAM roles**, RETAIN resources, KMS
pending-deletion, any `cdkrd:ephemeral`-tagged type), verifies `SWEEP CLEAN`,
and releases the gate (`bughunt-track verify` + `clear`, incl. this session's
`autoarm-<session>` owner). Confirm the stacks are gone.

If you also `bughunt-track add` your live-test stacks, **scope the `add` to
this session** — `CDKRD_BUGHUNT_OWNER="session-$CLAUDE_CODE_SESSION_ID" … add
<stacks>` — so a parallel agent's stacks never mix into the shared main-root
owner (go-to-k/cdk-real-drift#1409): an unscoped `add` from the main checkout
shares ONE owner file, and a `clear` empties the whole file, dropping a peer's
still-pending tracking. If shared inadvertently, NEVER `clear` while it lists a
peer's stacks; release only your `autoarm-<session>` token and merge from a
worktree cwd (the merge gate scopes by committing worktree owner + your
`autoarm`, not the shared main-root owner).

`/verify-pr` sets the `check` + `docs` + `verify-pr` markers, which unblock
`gh pr merge`. Docs/tooling-only PRs (no `src/**`) are EXEMPT from the
live-test — `check` + `docs` suffice.

**Your own review round is not optional because the lane already ran one, and
this repo has no ladder to fall back on.** A lane's reviewers are its children
— same brief, same framing — so they clear what the lane already believes, and
here nothing mechanical catches that: there is no multi-agent reviewer set and
no review-tier skill, and the `pr-review` entry in `.markgate.yml` is wired to
no hook. Measured on the sibling go-to-k/cdkd#2383 (2026-08-29), which runs a reviewer
ladder this repo does not: three rounds of the LANE's own reviewers each found
the next spelling of one defect, and it took an independent
orchestrator-level round to find the last one — a YAML merge key, the spelling
the lane's own raw-text tripwire had been added specifically to backstop and
did not fire on. This repo's go-to-k/cdk-real-drift#1838 spent its own rounds
on the same class, its flow-style `exclude:` staying green through the first
fix for it. So the depth is your own read of the whole diff plus a round you
dispatch yourself, and a lane's clean round is evidence about the lane's
assumptions, not about the diff.

**A reviewer's scratch COPY of a worktree is not detached from git, so its
`git add -A` writes to the LIVE tree.** A linked worktree's `.git` is a FILE
holding `gitdir: <repo>/.git/worktrees/<name>`, and `cp -R` carries the
pointer: every git command inside the copy reads and WRITES the real worktree's
index and HEAD. Measured 2026-08-29 in the sibling cdkd, where a read-only code
reviewer copied a lane's worktree, ran `git add -A` there, and staged three
tracked DELETIONS in the live tree that the lane's next commit would have
shipped — nothing announced it, because the reviewer believed it was on a copy.
Two lines therefore belong in every read-only reviewer's brief: **run no
WRITING git verb** (`add` / `commit` / `restore` / `checkout` / `stash` /
`clean`) anywhere, copy included — and if you must copy, copy OUTSIDE every
repository, since deleting the `.git` file does not detach the copy, it only
makes discovery walk UPWARD into whatever encloses it; and **report the TARGET
worktree's `git status --porcelain` before AND after the round.** The pair is what makes damage attributable rather
than a mystery a later agent finds: that incident surfaced only because the
NEXT reviewer volunteered "the tree went dirty mid-review, not mine", after
which the responsible one repaired the index with `git restore --staged` (index
only, never the working tree). This repo's lanes live under a `.worktrees/`
directory, so the hazard is identical here.

### 8-z. When a mutation probe reports NO discrimination

**First, a rule that applies BEFORE any probe runs: COMMIT the round's real
fixes, then probe.** A probe deliberately breaks the tree, so an interruption
mid-probe (a session limit, a crash) leaves deliberate breakage and unfinished
fixes in ONE undifferentiated dirty tree. Measured 2026-09-02 on the
go-to-k/cdk-real-drift#1841 lane: the subagent died at the 5-hour session limit
mid-probe with 9 dirty files, and the resuming session had to read the full
diff to establish that none of it was probe wreckage before it could commit.
With a pre-probe commit the separator is just `git diff` — anything unstaged
after a probe is the probe's.

**A probe that reports NO discrimination is a claim about the FENCE, and three
other things produce the identical output.** Ask them in order before touching
the fence — each nearly cost a working assertion in one session (2026-08-25):

1. **Did the edit land?** `sed`/`perl` one-liners fail silently as "no match":
   a `perl -0pi -e "s|^\|...|...|m"` delimited by the same `|` it escapes
   matches nothing; a `sed -E`-only alternation (`\|`) is a GNU extension
   matching nothing on macOS; a `sed: bad flag` prints ABOVE the suite output
   and scrolls past. Prove it with `grep -c '<the mutated text>'` before
   reading the result, and prefer `python3` with an `assert anchor in s` — an
   assertion that throws is louder than a quoting slip that quietly matches
   zero.
2. **Does the case's execution path REACH the edited line?** Breaking a hook's
   branch-lookup call left its suite fully green: every case carried an
   explicit PR number, so the lookup never ran. The fence was fine; the probe
   was aimed outside the cases' path. The fix is a case that HAS to take that
   path, not a change to the fence.
3. **Did the command run where you think it did?** A relative-path edit under a
   silently reset cwd lands in another worktree, and the confirming
   `git status` runs in that same wrong tree — "clean" and "clean somewhere
   else" print identically. Use ABSOLUTE paths and confirm by a property the
   wrong tree cannot fake (`ls -la` mtime).

And one shape inside the fixture itself: **an expected value must be an
INDEPENDENT variable from the one under test.** A stub keyed its content on a
sha whose default was the same literal on the producing and the consuming side,
so breaking the producing call still served the content and the case could not
fail.

Only after all four does "the fence is weak" remain as the explanation.
Deleting an assertion on the strength of an unexamined green is how a working
guard gets removed.

Ported from cdkd (all four shapes measured in one session: go-to-k/cdkd#2197 /
go-to-k/cdkd#2200 / go-to-k/cdkd#2198); the mechanism is the shell and the
tooling, not anything cdkd-specific, so it applies here unchanged.

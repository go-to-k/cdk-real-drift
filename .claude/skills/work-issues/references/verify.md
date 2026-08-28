<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 8. Verify before merge (`/verify-pr`)

Run `/verify-pr`. Its live-test rules decide how each PR is verified:

**Run the integ LAST, and note that "last" does not hold still across review
rounds — so DECLARE the tree final, in words, to whoever is still editing it.**
This repo's `integ` gate is `hash: diff` over `src/**` and
`tests/integration/**`, so it digests the branch's DELTA rather than the working
tree's behaviour. The consequence is worth stating outright: a round of review
fixes whose change to an in-scope file is **comment-only** still stales the
marker, and still costs a full fixture run. Measured in cdkd on 2026-08-26
(go-to-k/cdkd#2261), where a lane paid THREE real-AWS runs of one fixture, the
third for a round whose provider change was verified to carry zero non-comment
lines. What ended it was telling the implementing agent, before its last pass, to
batch every remaining finding into ONE commit and report when the tree is FINAL
with no second pass — after which the integ ran once. Say that explicitly rather
than assuming it: an agent handed a list of findings will otherwise fix, verify
and hand back, which is the right instinct everywhere except in front of a gate
that costs a real run. The reviewer-side corollary is the reverse — dispatch a
round SCOPED to the delta and ask for the whole round's findings at once, rather
than trickling them.

- **fold / FP / classify fix** → the harvested **corpus** case is authoritative
  live data. If it is pinned by `vp test run corpus-replay` AND was live-proven in
  its originating hunt (the issue carries the real repro), that IS the live
  evidence — no fresh deploy. State the deferral explicitly.
- **toolchain / CI / skill fix (nothing under `src/` in the diff)** → there is no
  live-test tier and no corpus. `verify-pr-gate` exempts a diff with no `src/`
  files, so `/verify-pr` is not required; that is an exemption from the LIVE test,
  not from verifying. WHICH verification you owe then depends on what the diff
  CHANGES, and a diff that does both owes both arms:
  - **It changes what a command or gate DOES** (a `vite.config.ts` task, lint or
    typecheck config, `.github/workflows/ci.yml`, `.claude/hooks/` logic) → the
    verification IS that command, run REPEATEDLY (3–5×) both BEFORE and AFTER, with
    the FAILURE direction driven too. Run _the command your own diff changes_: the
    hook's own `.claude/hooks/<name>.test.sh` for a hook, the workflow step's own
    command for CI, the changed task for `vite.config.ts`. `vp run check` is not
    the universal answer — it format-checks `ci.yml` as text and never EXECUTES a
    workflow step or a hook, so pointing it at either diff is a probe that cannot
    fail (confirmed here 2026-08-19: `vp fmt --check .github/workflows/ci.yml`
    passes on any semantic change). Measure it as recorded below.
  - **It changes PROSE only** (a skill, a rule, a doc — including this file) →
    there is no command to re-run, so the CLAIMS are the artifact and repeating
    some adjacent command 5× measures nothing about them. Resolve every gate, hook,
    skill, path, task and command the new text names against this repo's own files,
    and RUN each command the text will send the next agent to run, confirming its
    output matches what the text promises. That is §10-c's claim-by-claim pass,
    owed whether or not the text arrived from a sibling repo;
    `tests/skill-doc-paths.test.ts` mechanizes the path and issue-ref halves of it.
    Splitting the arms is go-to-k/cdk-real-drift#1774: undivided, this tier sent a
    pure prose diff — that issue's own fix — to run a command 3–5×, which for a
    SKILL.md edit is not a thing that exists.

- **A fixture that establishes the fix's PRECONDITION on the happy path cannot
  test the arm where the FAILING path creates it.** The most expensive shape this
  flow produces, because every signal says pass. In cdkd (go-to-k/cdkd#2125) a fix
  keyed on state that only the SUCCESS path persisted shipped past unit tests, a
  real-AWS fixture, and four reviewers; the fifth found it by tracing the evidence
  rather than the code. Here the state is the BASELINE file that `record` writes
  under `.cdkrd/baselines/`, and the ignore rules the `ignore` verb appends:
  a `verify.sh` that runs `record` and only THEN mutates has established the
  precondition with a successful run, so it can never exercise the case where the
  FIRST `check` is what both creates the situation and has to handle it — which is
  exactly the `record`-less first-run path the core invariant is about. When a fix
  keys on state an earlier step wrote, ask **which step writes it in the fixture,
  and which step writes it in the reachable case**; if the answers differ, add the
  arm where one operation does both, and prove the new arm DISCRIMINATES by
  mutating the fix and confirming the ORIGINAL arm still passes while the new one
  fails. An arm that fails alongside the old one has shown nothing new.
- **A `cleanup` that ALSO runs before the run must not destroy anything the run
  then needs.** A `WORKDIR="$(mktemp -d …)"` at load time, an `rm -rf "$WORKDIR"`
  inside `cleanup`, and a pre-run `cleanup` call are each correct alone; together
  the directory is gone before its first write and the symptom is a bare
  `No such file or directory` from a redirect hundreds of lines from the cause. It
  cost a real-AWS cycle in cdkd. AWS resources are safe from this because creating
  them IS a phase, so a pre-run sweep can only remove a PREVIOUS run's leftovers —
  a local scratch path computed at variable-definition time is not. Anything
  `cleanup` removes must either be re-created by a phase or be created after the
  pre-run call. This repo's `verify.sh` fixtures arm `trap cleanup EXIT` without a
  pre-run call, which is why it has not bitten here; the moment one adds a pre-run
  sweep, run the fixture end to end against stubs first — two seconds of a dry run
  catches it.
- **When a fix round produces the NEXT round's blocker twice, stop reviewing the
  patch and question its SHAPE.** `/verify-pr` step 5 re-reads the WHOLE diff on
  every run, fix-round deltas included, and re-decides review depth at the final
  sha; this is what to do when that keeps paying out. Each fix is locally
  correct and moves the failure one layer out rather than removing it, and the
  blockers are found by executing a probe or tracing a window — never by
  re-reading the diff. After round two, ask what the rounds have in COMMON: it is
  usually one structural absence, and naming it does not skip the rounds but does
  tell everyone what they are chasing. Then do NOT take the structural fix late
  in the cascade — adding new code at round five is how round six happens. Take
  the narrow fix, file the structural one, and reference it from the narrow fix
  so the next reader sees the choice was made rather than missed.

  **Filing the structural fix does not STOP the cascade, and the sentence above
  used to imply it would.** Measured in go-to-k/cdk-local#596 on 2026-08-27: the
  structural issue was filed at round five and the rounds ran to TWELVE,
  producing eleven instances of one defect class in one PR, five of them
  introduced by the fix for the previous one. What ended it was not a better
  check — it was making the artifact **CLAIM LESS**.

  The tell is that each round's fix is more SOPHISTICATED than the last. There a
  `/run-integ` orphan sweep went name scan -> scoped filter -> guarded filter ->
  stderr classification -> status filter, while the plain rc-only sweeps three
  lines away were correct the whole time, under the exact conditions that
  defeated the clever ones: `grep -q 'does not exist'` also matches botocore's
  `The source_profile ... does not exist`, raised before any network call, so a
  broken profile reported CLEAN having queried nothing. The sophistication WAS
  the defect. That sweep now prints raw command output and names both outcomes
  instead of emitting a verdict — a command that claims nothing cannot claim
  something false. Expect it to feel like a retreat; it is one, and it converges.

  Two corollaries, both paid for there:

  - **Fence the REMEDIATION, not just the detection.** Five of eleven instances
    arrived through a fix, and the last was in the remediation: a destroy built
    from names missing a required suffix exits 0 SILENTLY, so the operator read
    success with the resources still deployed. Every fence to that point pinned
    the DETECTION, so restoring that line left the suite green. If a procedure
    both detects and repairs, the repair is where the next instance goes.
  - **Do not pre-commit to a remedy for a finding you have not seen.** Twice the
    stated plan was "if instance nine appears, delete the whole thing",
    announced before instance nine existed; when it arrived, deleting would have
    left the flow with NO check at all — instance one made permanent. A rule
    announced in advance is a way of not having to exercise judgement. Say what
    the next finding would have to SHOW, not what you will do about it.

  Two shapes recur, and they are distinguishable a round apart:
  - **TWO SPELLINGS OF ONE QUESTION** — the fix is to make both sites use ONE
    predicate verbatim, not to write a better second spelling. A better spelling
    looks like a fix and passes its own test, so this is the sub-case that keeps
    regenerating. Name the SITE THAT OWNS the question and make every other site
    call or copy it exactly; a paraphrase is another round waiting to happen.
    Measured in cdkd (go-to-k/cdkd#2134) over three rounds, ending only when the
    authority's test was copied character for character — the round before, the
    two spellings still disagreed on the empty string, on the fail-OPEN side.
  - **A PROXY FOR A QUESTION ONLY ANOTHER COMPONENT CAN ANSWER** — the fix is to
    make that component REPORT, and the tell is that each proxy is wrong in BOTH
    directions at once. Two spellings DISAGREE at an edge; a proxy has no access
    to the fact at all, so every candidate both misses real cases and fires on
    unreal ones. When a round's fix lands on a new OBSERVABLE rather than a new
    spelling — "it threw", "the text survived", "a marker exists" — ask whether
    the thing you want to know is even derivable from outside the component that
    decides it. If it is not, the rounds are unbounded. Measured in cdkd
    (go-to-k/cdkd#2157 / go-to-k/cdkd#2166) over three rounds asking "did this
    reference go unresolved?" from outside the resolver: keying on "it THREW"
    missed the path that warns and continues without throwing, and over-reported
    an unrelated failure that merely shared the same bag; keying on "the raw text
    SURVIVED" missed input a downstream step rewrote without resolving, broke on
    JSON escaping, and fired permanently on PROSE that merely mentioned the
    syntax. The drift analogue is any question only AWS's own readback can
    answer — "is this property genuinely drifted, or did the provider never
    return it?" — where an outside proxy (the field is absent, the value differs
    from the template, a normalizer left it untouched) misses real drift AND
    manufactures false positives at the same time, which is why this repo's
    corpus is authoritative over any predicate reasoned about in isolation.

- **WITHDRAWING the half that cannot be made right is a legitimate outcome, and
  the residual issue must carry the MEASUREMENTS, not just the diagnosis.** The
  rule above says where the fix goes; this says what to do with the code already
  written for the wrong one. Cut it, ship the part the issues actually scoped,
  and file the rest — the filing is cheap only if it carries what the session
  PAID for: each proxy tried, the input that broke it, and the number it
  produced. A diagnosis alone makes the next session re-run every probe. cdkd's
  go-to-k/cdkd#2166 is the worked example: three rounds of measurements plus a
  live arm that was written, passed, mutation-probed and then reverted, so none
  of it is rebuilt.
- **When two reviewers CONTRADICT each other, settle it in the code YOURSELF
  before forwarding either.** Forwarding both hands the implementing agent a
  contradiction to adjudicate with LESS context than you have; forwarding only the
  reassuring one is how a blocker ships. Read the disputed lines, then say which
  reviewer was right and why. This repo has no standing reviewer ladder, so the
  rule fires exactly when a lane DISPATCHES read-only reviewers of its own — which
  it should for a diff big enough to warrant them, and which this file's own §6
  depth rule does not otherwise cover.

  What to measure in the command arm, all of it confirmed on this repo on
  2026-08-19 (go-to-k/cdk-real-drift#1768):
  - **An exit code can lie in EITHER direction, so drive both.** _Non-zero that
    means nothing_: go-to-k/cdk-real-drift#1761 / go-to-k/cdk-real-drift#1765 —
    `vp run check` exited **134** on a clean tree while finding **0 errors** (the
    Vite+ stdout `EAGAIN` panic), and it was
    DETERMINISTIC, not a flap: "Confirmed identical on unmodified `main`", measured
    3/3 in each state (134 before the fix, 0 after). The hazard there is the
    OPPOSITE of a flake — the fix is one line of build config, and a redirect that
    swallows the exit code turns a RED tree green, which is why
    go-to-k/cdk-real-drift#1765 shipped
    `tests/vp-run-check-redirect-1761.test.ts` asserting the `exit 1` survives.
    _Zero that means nothing_ is just as real, but this repo has no measured case;
    the sibling does — go-to-k/cdk-local#504 recorded `vp test run` returning
    rc=0,0,1,0,1 across five identical runs with every test passing (its
    forks-worker exit, which kills a reused worker AFTER its assertions pass).
    Cite that one as the sibling's, and measure the command YOU changed rather
    than assuming either shape.
  - **`vp pack` BEFORE reading any `vp run test` verdict in a fresh worktree — and
    re-run a red from that one file before believing it.** A worktree with no
    `dist/` fails 13 tests of `tests/json-empty-on-error.test.ts` deterministically
    (rc=1, 2/2) because they spawn the built CLI — a red that means nothing, and one
    that reads as "main is broken". `vp pack` fixes that red but not the file's
    OTHER one: on 2026-08-19, with `dist/` freshly packed, THREE of its 13 failed
    once and the identical re-run went 343/343 rc=0, the file itself 13/13 in
    isolation. So a `vp test run` rc DOES flap here. Tell the two apart by the
    COUNT — 13 failures means no `dist/`, fewer means the flake — and never let a
    single red run stand as the verdict.
  - **Repeating a `vp run <task>` DOES re-execute here** — `check` (5/5) and `test`
    (3/3) both reported `not cached because it modified its input`, so the repeat
    measures something. Do not carry the sibling's cache-hit warning over; the
    local cache trap is the one `vite.config.ts` records (PR
    go-to-k/cdk-real-drift#438: a cached GREEN `typecheck` masked a real TS1117)
    and it is already handled there by
    `cache: false`.
  - **Inject the failure anywhere LINTED — here that includes the tests tree.** A
    non-underscore-prefixed unused variable fails `vp run check` rc=1 from a `src/`
    file (2/2) and from a `tests/` file (1/1), because `lint.ignorePatterns`
    re-includes the tests tree and excludes only `tests/integration/`. cdk-local's
    lint is source-only, so its "never inject into the tests tree" clause is FALSE
    here — exactly the drift §10-c's per-repo check exists to catch.
  - **Then guard the SHAPE of the fix**, since nothing else re-checks a config or
    hook line: a unit test on the config object for a build-config change (the
    go-to-k/cdk-real-drift#1765 test above), or the standalone hook suite for a
    `.claude/hooks/` change — which §5 already notes you must run BY HAND.

  Both arms end in writing, and `vp fmt` mangles a paragraph that uses bold AND
  contains a double-star glob inside a code span — it is what corrupted this very
  passage when go-to-k/cdk-real-drift#1766 first added it. That trap is now a GATE,
  not a thing to remember: `tests/markdown-fmt-corruption-1771.test.ts` fails on
  both the trigger construct and the damage it leaves, so write the plain directory
  (`src/`, `tests/`) in a bold paragraph and let the test catch you otherwise. Root
  cause and the toolchain bump that ends it: go-to-k/cdk-real-drift#1771 /
  go-to-k/cdk-real-drift#1780.

- **revert / read HOT-PATH fix** → live-verify with a MINIMAL, UNIQUE-named
  fixture: deploy → mutate out of band → `check` detects → `revert --yes`
  converges → confirm the live value. A throwaway CDK app works:
  `/tmp/<name>/app.cjs` (require-style CJS so classic module resolution works;
  **ESM `import` ignores `NODE_PATH`**), and `ln -s <repo>/node_modules
node_modules` to borrow `aws-cdk-lib` (rm any existing dir first — `ln -sfn` into
  an existing dir nests a symlink). Inline/no-asset stacks need no bootstrap. Build
  the FIX binary with `vp pack` and run `node .worktrees/<w>/dist/cli.js`.

**Fresh deploys: UNIQUE hunt-style stack names only** (`Cdkrd<issue>Verify`), never
a shared fixed name and never a real prod stack — the account may hold the
maintainer's production stacks. **Tag every ephemeral deploy `cdkrd:ephemeral=1`**
(`Tags.of(app).add('cdkrd:ephemeral','1')`, or `aws cloudformation deploy --tags
cdkrd:ephemeral=1`) so the generic sweep net can find it whatever its type.

**Cleanup is enforced, not optional.** The `deploy-autoarm-gate` hook ARMS this
session's own bughunt-clean token the moment you run any deploy command, so YOUR
commit / PR is BLOCKED until you release it — even if you deployed from a throwaway
`/tmp` app (a peer session's commits are not blocked). After the live-test, run
**`/sweep-resources`** (the cleanup phase): it tears down with `delstack` (never `cdk
destroy`), sweeps the stack-EXTERNAL orphans `delstack` can't reach (auto-created
`/aws/lambda/*` + API-GW CloudWatch **IAM roles**, RETAIN resources, KMS
pending-deletion, any `cdkrd:ephemeral`-tagged type), verifies `SWEEP CLEAN`, and
releases the gate (`bughunt-track verify` + `clear`, incl. this session's
`autoarm-<session>` owner). Confirm the stacks are gone.

If you also `bughunt-track add` your live-test stacks explicitly (clearer gate
message than the autoarm backstop), **scope the `add` to this session** —
`CDKRD_BUGHUNT_OWNER="session-$CLAUDE_CODE_SESSION_ID" … add <stacks>` — so a
parallel agent's stacks never mix into the shared main-root owner
(go-to-k/cdk-real-drift#1409). An unscoped `add` run from the main checkout shares
ONE owner file with every other
session, and a `clear` empties the whole file — dropping a peer's still-pending
tracking. If you inadvertently shared it, NEVER `clear` the shared owner while it
lists a peer's stacks; release only your `autoarm-<session>` token and merge from a
worktree cwd (the merge gate scopes by the committing worktree owner + your
`autoarm`, not the shared main-root owner).

`/verify-pr` sets the `check` + `docs` + `verify-pr` markers, which unblock
`gh pr merge`. Docs/tooling-only PRs (no `src/**`) are EXEMPT from the live-test —
`check` + `docs` suffice.

### 8-z. When a mutation probe reports NO discrimination

**A probe that reports NO discrimination is a claim about the FENCE, and three
other things produce the identical output.** Ask them in order before touching
the fence, because each was hit in one session (2026-08-25) and each cost a
working assertion nearly being deleted or rewritten:

1. **Did the edit land?** `sed`/`perl` one-liners fail silently in ways that read
   as "no match". A `perl -0pi -e "s|^\|...|...|m"` whose pattern is delimited by
   the same `|` it escapes matches nothing; a `sed -E`-only alternation (`\|`) is
   a GNU extension that matches nothing on macOS; a `sed: bad flag` prints ABOVE
   the suite output and scrolls past. Prove it with `grep -c '<the mutated text>'`
   before reading the result, and prefer `python3` with an `assert anchor in s`
   over a shell one-liner — an assertion that throws is louder than a quoting
   slip that quietly matches zero.
2. **Does the case's execution path REACH the edited line?** The edit can land
   and still prove nothing. Breaking a hook's branch-lookup call left its suite
   fully green because every case carried an explicit PR number, so the lookup
   never ran. The fence was fine; the probe was aimed outside the cases' path.
   The fix is a case that HAS to take that path, not a change to the fence.
3. **Did the command run where you think it did?** A relative-path edit under a
   silently reset cwd lands in another worktree, and the `git status` confirming
   it runs in that same wrong tree — so "clean" and "clean somewhere else" print
   identically. Use ABSOLUTE paths and confirm by a property the wrong tree
   cannot fake (`ls -la` mtime).

And one shape inside the fixture itself: **an expected value must be an
INDEPENDENT variable from the one under test.** A stub keyed its content on a
sha whose default was the same literal on both the producing and the consuming
side, so breaking the producing call still served the content and the case could
not fail.

Only after all four does "the fence is weak" remain as the explanation. Deleting
an assertion on the strength of an unexamined green is how a working guard gets
removed.

Ported from cdkd, where all four shapes were measured in one session (go-to-k/cdkd#2197 / go-to-k/cdkd#2200 / go-to-k/cdkd#2198). The mechanism is the shell and the tooling, not anything cdkd-specific, so it applies here unchanged.

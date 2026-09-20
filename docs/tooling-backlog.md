# Tooling backlog

This file holds findings about cdk-real-drift's **own tooling** — Claude Code
hooks, markgate gates, `.claude/rules/**`, `.claude/skills/**`, CI fences and
the verification harness. None of them is a `cdkrd` defect: no user can hit any
of these by running the CLI, so none belongs on the issue tracker, which is for
`cdkrd` behaviour a user CAN hit.

**How an item gets here.** Write one row when a tooling weakness is observed.
That is all — nothing is built on a first occurrence. A new hook, markgate gate,
CI fence, rule paragraph or test-of-prose is added only on the SECOND occurrence
of the same failure. "Cost is not a tiebreaker for verification depth" governs
verifying PRODUCT changes and explicitly does not reach here.

**How an item graduates.** A row becomes a GitHub issue when someone actually
starts working it, and not before — the issue is then the working record, and
the row here says which issue took it. An unworked row stays a row.

**The criterion a hook has to clear to exist at all.** A PreToolUse hook may
BLOCK only when the harm completes at the moment of the action AND lands
irreversibly on a THIRD PARTY's artifact, on ANOTHER SESSION's work, or on the
MAINTAINER's AWS account. Everything else becomes a sentence in `AGENTS.md`, a
unit test over `src/**`, or nothing. The full statement, with the roster of
hooks that clear it, is in
[.claude/rules/hooks.md](../.claude/rules/hooks.md).

## Policy decisions recorded here

- **Hook fail-open on exotic shell shapes is ACCEPTED.** A gate's matcher can be
  walked past with quoting, heredocs, `$( )`, `bash -c`, `eval`, case arms or
  redirections. These hooks steer a COOPERATIVE agent away from foot-guns; they
  are not a security boundary, and `main` is protected server-side by a GitHub
  ruleset. Finding one more such shape is therefore **not issue-worthy** and not
  backlog-worthy. If a specific miss actually bites twice in practice, that is
  the second occurrence and it gets fixed.

- **Tooling findings are not issues.** Hooks, rules, skills, CI fences and the
  verification harness are not `cdkrd` behaviour a user can hit. Record the
  finding here; it becomes an issue only when someone starts working it. The
  table below is the record for the rows that were already filed as issues
  before this policy existed.

- **The second-occurrence rule.** The first occurrence of a tooling failure is a
  row in this file and nothing is built. "It would have caught this" is the
  first occurrence, not the second. A recurring prose defect is fixed in the
  prose, never fenced by a test that pins wording.

- **Flow lessons are NOT mirrored across the sibling repos any more.** cdkd,
  cdk-local and cdk-real-drift each keep their own `work-issues` / `hunt-bugs`
  text. A lesson learned here is written here; porting it to a sibling, or
  opening a mirror PR there, is not owed by any skill.

## Coverage given up with the prose fences

Recorded as first occurrences, per the rule above. Each was verified clean by
hand at the time of removal, and none is rebuilt until it bites a second time.

| Removed                                                                      | What it used to catch                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/skill-file-payload.test.ts`                                           | per-file byte caps over `.claude/skills/**`, the per-skill corpus floor, and the "no stage file is stranded" pointer check                                                               |
| `tests/check-scope-checker-inputs-1837.test.ts`                              | that the `check` gate's include list covered every file the checkers read — moot with the gate gone, but it also floored the markdown scanner's population                               |
| `tests/work-issues-launch-mode.test.ts`                                      | that `launch-mode.md`'s probe exists exactly once, that each stage file still names the mode it branches on, and that the probe answers MAIN-CHECKOUT / IN-PLACE correctly when executed |
| the fully-qualified-issue-reference block of `tests/skill-doc-paths.test.ts` | that a skill doc writes `owner/repo#N` rather than a bare `#N`. It existed because a sentence could be mirrored into a sibling repo, which no longer happens                             |
| `.claude/hooks/gh-repo-flag-parity.test.sh`                                  | that each gate returned the same verdict for `gh pr merge` and `gh -R <owner/repo> pr merge`. The equality is still asserted per verb in `_command-match.test.sh`                        |

The structural halves survive: `tests/skill-doc-paths.test.ts` still resolves
every repo path a skill doc cites, still requires a `.test.sh` beside every
hook, and still requires each harness to derive its subject from its own path.

## Coverage the English-only CI port did not carry over

`.claude/hooks/non-english-text-gate.sh` was deleted with the other gates that
do not clear the blocking criterion, and the rule it enforced came back as CI
(`scripts/check-pr-non-english-text.ts` over the PR diff,
`scripts/check-gh-body-english.ts` over the published title / body). Two pieces
of the sibling repo's coverage were NOT ported, recorded here as first
occurrences rather than rebuilt:

| Gap                                 | Why, and what would close it                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The RENDERED report is not asserted | cdkd parses the bot comment with `marked` and checks that each offender stays inside ONE list and that an all-backtick payload renders as one code block. `marked` is not a dependency here and one is not added for a test. What survives is the SOURCE-level contract: the fence is longer than the longest backtick run, the payload folds to one line, and the fence is indented two spaces so it stays inside its list item. |

A third piece is worth recording as a MEASUREMENT rather than a gap: the
allow-list ships with six entries, all of them fixtures whose subject IS the
non-ASCII bytes (mask alignment, terminal sanitizing, bidi handling, a Step
Functions `Cause` whose masked RUN LENGTHS are the discriminator). An earlier
draft of this PR claimed the list was empty; the scan behind that claim ran
`grep -P` under `LC_ALL=C`, where the `\x{...}` ranges do not match, and a
review caught it. `tests/pr-non-english-text.test.ts` now derives the answer
from the tree with the SHIPPED detector, so an uncovered file fails there rather
than on someone else's PR.

Two weaker properties are inherent to the move from a PreToolUse gate to CI and
are not gaps to close: the check now runs AFTER the text is public, so on an
issue or comment it can only report and ask for an edit; and release notes
(`gh release create --notes`) are not covered, though releases here are cut by
release-please from commit messages, which the PR-diff check already reads.

## Open issues whose subject is the tooling

All 17 open issues at the time this file was written are about the tooling
rather than about `cdkrd` behaviour a user can hit: the `work-issues` and
`hunt-bugs` skill prose (including ten "mirror a flow lesson from the
sibling repo" issues, which the mirroring decision above makes moot), the hook
layer's shell parsing, and one prose-fence test that no longer exists. They are
recorded here so the history survives, and are to be closed on the tracker.

| Issue                                                          | Title                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#1858](https://github.com/go-to-k/cdk-real-drift/issues/1858) | chore(work-issues): the IN-PLACE detach fallback moves HEAD to origin/main instead of restoring where the tree was left                                                                                                               |
| [#1859](https://github.com/go-to-k/cdk-real-drift/issues/1859) | chore(work-issues): mirror cdkd#2452's three retro lessons (gh -R, carve-out probing, mirror ordering)                                                                                                                                |
| [#1860](https://github.com/go-to-k/cdk-real-drift/issues/1860) | chore(work-issues): mirror two flow lessons from the cdkd 2026-09-02 run — LAUNCH_BRANCH is never one to RENAME, and a deferral reason the promotion check contradicts                                                                |
| [#1862](https://github.com/go-to-k/cdk-real-drift/issues/1862) | chore(work-issues): section 8-z item 4 is unfenced — nothing pins the rule or the toolchain behaviour it asserts                                                                                                                      |
| [#1863](https://github.com/go-to-k/cdk-real-drift/issues/1863) | chore(hooks): a session working this repo from another repo's workspace runs THAT repo's gates — ours go silently absent                                                                                                              |
| [#1881](https://github.com/go-to-k/cdk-real-drift/issues/1881) | chore(work-issues): mirror five flow lessons from the cdkd 2026-09-04 run — scope tripwire, cwd-safe reads, count dispositions, late-round independence, markgate on PATH                                                             |
| [#1885](https://github.com/go-to-k/cdk-real-drift/issues/1885) | chore(work-issues): mirror five flow lessons from the cdkd 2026-09-05 run — cumulative budgets at triage, symmetric tree ownership, fence population, chat-language prompts, replaced assertions                                      |
| [#1886](https://github.com/go-to-k/cdk-real-drift/issues/1886) | chore(work-issues): mirror three flow lessons from the cdkd 2026-09-05 run -- the filing-time worktree test, `gh pr checks` parsing, and re-deriving committed numbers after the last rebase                                          |
| [#1888](https://github.com/go-to-k/cdk-real-drift/issues/1888) | chore(tests): skill-file-payload has no MEASURED record, so its byte figures drift silently                                                                                                                                           |
| [#1889](https://github.com/go-to-k/cdk-real-drift/issues/1889) | chore(work-issues): mirror two flow lessons from the cdkd 2026-09-05 run — the worktree probe reads one commit, and a lane report is its deliverable                                                                                  |
| [#1890](https://github.com/go-to-k/cdk-real-drift/issues/1890) | chore(work-issues): mirror three flow lessons from the 2026-09-06 cdkd run — cascade blocker COUNT, `Resuming agent`, and retro set attribution                                                                                       |
| [#1891](https://github.com/go-to-k/cdk-real-drift/issues/1891) | fix(hooks): the deferral gate passes a body delivered through a process substitution                                                                                                                                                  |
| [#1892](https://github.com/go-to-k/cdk-real-drift/issues/1892) | fix(hooks): two residual deferral-gate shapes — CRLF defeats the newline restore, and the writer arm judges the writer's arguments                                                                                                    |
| [#1896](https://github.com/go-to-k/cdk-real-drift/issues/1896) | chore(work-issues): floor the COMPARAND, not just the walk, and spell an injected defect the way its source does                                                                                                                      |
| [#1897](https://github.com/go-to-k/cdk-real-drift/issues/1897) | chore(work-issues): mirror five prose-verification and deferral-reason lessons from cdkd's retro                                                                                                                                      |
| [#1903](https://github.com/go-to-k/cdk-real-drift/issues/1903) | chore(work-issues): mirror six flow lessons from the cdkd go-to-k/cdkd#3005 run — premise EFFECT, run a correction, table-driven regex is the same instrument, realpath a scratch root, forward cwd drift, a killed run is no verdict |
| [#1904](https://github.com/go-to-k/cdk-real-drift/issues/1904) | chore(work-issues): mirror two flow lessons from the cdkd go-to-k/cdkd#3079 run — a green probe licenses adding a case per arm, never deleting the guard; read which assertion the pre-fix control fired                              |

Three of them are moot outright rather than merely deferred: `#1888`'s subject
(`tests/skill-file-payload.test.ts`) no longer exists, and `#1891` / `#1892`
describe parsing shapes in `issue-deferral-criteria-gate.sh`, which was deleted.

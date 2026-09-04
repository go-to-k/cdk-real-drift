# Hooks and gates — mechanics and measured history

Moved out of CLAUDE.md by the token-diet split (go-to-k/cdk-real-drift#1877
follow-up): CLAUDE.md keeps the one-line rules and points here. Read this file
when working on `.claude/hooks/**`, `.claude/settings.json`, or when a gate's
verdict surprises you.

- **Naming the repo must never change a gate's verdict, and twice it did.** On
  2026-08-25, `gh -R <owner/repo> pr merge 1 --squash` matched NOTHING in
  `verify-pr-gate`, `ci-green-gate` and `bughunt-clean-gate` — measured exit 2
  plain, exit 0 flagged: a live bypass of `/verify-pr`, of red CI, and of the
  cleanup check. Two causes, both closed: the shared `GATE_GH_C` absorbed only
  `-C <path>`, AND those three gates each HAND-ROLLED their own verb regex, so
  a shared fix would not have propagated. `GATE_GH_C` is now `GATE_FLAGS`-style
  tokenisation (space, `=`, and the glued `-Ro/r` a hand-written list misses),
  and every gate derives its trigger from the shared constants via
  `gate_re_any` — `branch-gate` was a FOURTH hand-rolled copy, frozen at the
  pre-`GATE_FLAGS` token, so `git -C "<path with a space>" commit` committed
  straight to main. Follow-on rules from the same audit: **matching a flag is
  not the same as honouring it** — `-R` was absorbed and then discarded, so
  `gh -R foreign/repo pr merge 5` had each gate inspect THIS repo and permit a
  merge in one it never looked at; the three gates that audit repo-specific
  state now REFUSE a foreign `-R` by name (issue-dup-check is exempt: for the
  mirror flow the cwd decides policy and `-R` only decides where the issue
  lands). And **the selector must come from the matched verb in the matched
  segment**: `gh pr merge --squash 1` parses like `gh pr merge 1 --squash`, a
  quoted `gh pr merge 9` inside a `--body` donates nothing to a later bare
  merge, and flag VALUES are consumed (`-t msg 2195` must not resolve `msg`) —
  all `gate_pr_selector`'s job, with two reusable rules: **enumerate the
  VALUELESS flags, never the value-takers** (either list goes stale, and the
  safe stale direction is an unlisted flag eating the number — empty selector,
  caller falls back — rather than auditing the wrong PR), and **put a type
  guard at the end** so a non-number is never handed on. Fenced by
  `.claude/hooks/gh-repo-flag-parity.test.sh`, which asserts across every gate
  that the flagged spellings return the SAME exit code as the plain one **and**
  that the plain one actually blocks — parity alone is satisfied by a gate
  inert in both directions, the state `non-english-text-gate` was in (it
  invoked `gh -C`, a flag `gh` does not have, so it failed open on every
  command). The foreign-`-R` half asserts the refusal MESSAGE, not just the
  exit code — every gate in that fixture already blocks for its own reasons.

- **The two `Stop` hooks (`stop-cleanup-warn.sh` / `stop-unmerged-lane-warn.sh`):
  channels, cadence, and the record.** Until go-to-k/cdk-real-drift#1844 each
  picked an output channel its text's audience never reads. The rules, each
  measured and fenced by the hooks' own suites:

  - A Stop hook has exactly three ways out (read from the installed Claude Code
    2.1.251, not the published docs): `hookSpecificOutput.additionalContext`
    reaches the MODEL and the turn CONTINUES; `systemMessage` reaches the USER
    only (rendered as `<hookName> says: ...`); stdout / stderr at exit 0
    reaches NOBODY (hook stderr surfaces only on a NON-zero exit, and stdout at
    exit 0 is parsed as JSON and dropped when it is not one). There is no
    fourth option reaching the model WITHOUT continuing, so each hook must
    CHOOSE; the two JSON fields are independent branches, so one payload may
    carry both. `stop-cleanup-warn` — a BILLING guardrail — spent months in the
    third state (`echo ... >&2` then `exit 0`); the lane hook emitted
    `systemMessage` only while every word was addressed to the agent.
  - **A continuation is not free**: `additionalContext` travels in the SAME
    return value as a `decision: "block"`, so both spend one budget —
    `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, default 8 consecutive blocks, SHARED
    across every Stop hook. Cadence rule, followed by both:
    `stop_hook_active` (a required boolean marking a turn the harness ALREADY
    resumed) drops the MODEL half — and ONLY that. A full `exit 0` stand-down
    is wrong whenever the condition first becomes TRUE during the continuation
    (deploying a stack or committing the lane is exactly the work the
    continuation exists to push). A bare `systemMessage` does not continue a
    turn, so the user half costs nothing; a resumed pass writes no cadence
    record, so the unspent nudge survives for the next ordinary turn-end.
  - Each hook nudges the model at most once per distinct SUBJECT; a repeat
    falls back to `systemMessage`. The subject is chosen so ORDINARY WORK does
    not change it: the lane hook keys on `<own branch>:<pushed|unpushed>` —
    NOT the commit count — and the cleanup hook on the sorted armed-token set.
    **The lane predicate is DIRECTED, and a plain inequality is not a
    simplification of it**: `pushed -> unpushed` is what an ordinary COMMIT
    looks like, so `prev != subject` re-armed on every commit and again on
    every push (measured: two forced continuations per cycle). It arms on a
    new session, an unseen lane, a DIFFERENT branch, an unparsable record, or
    `unpushed -> pushed` only — the one transition opening an action the model
    did not have.
  - The record is ONE file in the PER-WORKTREE git dir (`stop-nudge-lane` /
    `stop-nudge-cleanup`) holding `<session id>TAB<subject>TAB<epoch>`,
    written tmp-then-`mv`; the cleanup hook appends a fourth `armed since`
    field each nudge must not reset. One file rather than one per session, so
    nothing accumulates, and a concurrent session in the same worktree costs an
    EXTRA nudge rather than a missed one — the safe direction. Load-bearing
    properties, each a live bug first: it is written on BOTH arms (it holds the
    last OBSERVED subject, not the last NUDGED one — recording only on the arm
    freezes the push half); every field is NORMALISED — folded free of tabs and
    newlines, defaulted when empty — **once, after EVERY source of it has been
    consulted** (both hooks read the session id from the payload AND from
    `CLAUDE_CODE_SESSION_ID`; normalising inside the payload parse left the
    environment path raw — measured: a `<TAB>`- or newline-bearing id gave
    `ctx, ctx, ctx`, an unbounded nudge); and a record that cannot be PERSISTED
    costs the MODEL channel rather than the warning, because a nudge that
    cannot be recorded cannot be bounded. Three corrections landed 2026-09-01,
    each mutation-proved: **`mv -f` is not proof of a write** — a record path
    that is a DIRECTORY returns 0 and moves the tmp INSIDE it (unbounded
    re-arm arriving through the success check), so both hooks confirm the
    destination is a regular FILE and sweep the stray tmp; **the record's
    THIRD field is READ** — a record is consulted only when well-formed
    (exactly three tab-separated fields, numeric epoch), closing the
    `IFS=<TAB>` fold where an EMPTY subject shifted fields and went QUIET;
    **the lane hook DELETES the record when no worktree is ahead** — else the
    stored subject outlives the condition and the same subject returning is
    downgraded, a missed nudge reachable through the hook's own
    `git switch --detach origin/main` remedy. The cleanup hook deliberately
    does NOT delete, and says why in the file: its `systemMessage` fires every
    turn regardless and `REARM_SECONDS` re-arms the model channel within 20
    minutes, so its worst case is bounded where the lane hook's was not.
  - **A downgrade to `systemMessage` must change VOICE, not only audience.**
    Both hooks keep a `user_msg` / `model_msg` pair; the model text is written
    at the agent ("YOUR OWN lane", "rebase, run the gates"), and routing it
    down the user channel hands a human instructions addressed to somebody
    else — go-to-k/cdkd#2389 in miniature. The lane hook has THREE downgrade
    paths (a cadence repeat, an unpersistable record, a resumed pass) and one
    shared emitter — exactly the shape where fixing one path leaves the
    others — so each is fenced by its own case, and the resumed and
    unpersistable cases also assert the ABSENCE of the "the agent has already
    been nudged" claim, which is true only of the cadence repeat (measured:
    restoring the sentence reddens exactly those two).
  - **The `stop_hook_active` fold follows PYTHON's truthiness in both hooks**
    (one parses with `jq`, the other with `python3`, and a malformed payload
    must not mean two different things): null, `false`, `0` and an empty
    container are falsy, every other value truthy, textual spellings of
    `false` folded first. Plain jq truthiness and `$f == true` are each wrong
    in OPPOSITE directions (measured), and the second is the dangerous one —
    a resumed pass read as fresh spins the turn. One recorded divergence:
    `1e-999` reads truthy in jq 1.8 and falsy in Python (underflow to `0.0`) —
    left as is, because both halves are bounded and no producer emits it (the
    harness sends a JSON boolean).
  - **The two hooks then DIVERGE deliberately, and the difference is the
    point.** `stop-unmerged-lane-warn` picks ONE channel by OWNERSHIP — the
    session's own lane (resolved from the payload's `cwd`, falling back to the
    hook copy's own checkout) goes to the model, another session's lane to the
    user, because the model cannot act on a worktree that is not its own — and
    has NO wall-clock re-arm (an unmerged lane costs nothing while it sits).
    Push state is deliberately NOT its channel discriminator: that would go
    quiet on a branch pushed with NO PR, one of the two failures the hook
    exists to catch, so it lives in the cadence subject and the message TEXT.
    `stop-cleanup-warn` makes the opposite trade on both axes, because its
    subject is real AWS resources: `systemMessage` on EVERY fire (a billing
    guardrail must never go silent to the human) PLUS `additionalContext` when
    the cadence arms, and a 20-minute wall-clock re-arm even on an unchanged
    token set — money accrues on the clock, not per turn — with the escalated
    message naming how long the tokens have been armed. Exercised by
    `.claude/hooks/stop-cleanup-warn.test.sh` and
    `.claude/hooks/stop-unmerged-lane-warn.test.sh` (74 and 121 cases), run by
    `vp run test:hooks`.
  - **Both suites run the HOOK under an explicitly chosen interpreter, and
    that is not cosmetic.** The hooks' `#!/usr/bin/env bash` resolves through
    PATH, so launching the SUITE with `/bin/bash` proved nothing about the
    hook. Each suite now puts a one-symlink shim directory first on PATH so
    every child `bash` is the fenced interpreter — `/bin/bash` by default,
    `HOOK_BASH=<path>` for the other tally — prints which one it used on its
    first line, and treats an explicitly set but non-executable `HOOK_BASH` as
    FATAL rather than a silent fallback to PATH bash.

- **A branch switch in the main checkout is now GATED, not merely discouraged.**
  `.claude/hooks/main-tree-branch-gate.sh` refuses `git switch` / `git checkout`
  onto a feature branch (and `git switch --detach`, and `git switch -` /
  `git checkout -` / `@{-1}`) when the TARGET working tree is the main
  checkout, while passing `main` / `master`, a
  `git checkout [<tree-ish>] -- <pathspec>` file restore, the restore FLAGS
  `-p` / `--ours` / `--theirs`, a detached `git checkout <sha>`,
  `git worktree add`, every switch made INSIDE a `.worktrees/` lane, and the
  orchestrator's own `git checkout <branch> -- <files>` integration step
  (measured — it restores files and leaves HEAD on `main`). It is the
  CAUSE-side twin of `branch-gate`, which fires on the symptom
  (go-to-k/cdk-real-drift#1845). Key behaviours, each settled against real git
  first and exercised by `.claude/hooks/main-tree-branch-gate.test.sh`
  (172 cases, under the pinned-interpreter fence above):

  - **The argument tail is PARSED the way git's own parse-options parses it**,
    never matched against a list of spellings: a leading flag is not mistaken
    for the branch (`git checkout -f <branch>` is refused); glued values are
    read (`-bfeat`, `-fbfeat`, `--orphan=feat`, `--track=direct`); a
    value-taking flag's argument is consumed rather than counted as a pathspec
    (`git checkout --conflict merge <branch>` really switches); and a branch
    that exists only on a CONFIGURED remote is refused, `-t origin/<b>`
    included — git DWIMs both into "create the local branch and switch", which
    is how a lane's branch usually first appears in a checkout. The parse
    reads git's ARGV through the shared `gate_argv`, never raw shell words: a
    redirection, its spaced target, a trailing `&` and a `#` comment are the
    shell's, not git's, and counting them as arguments once relaxed a real
    switch to "file restore" (measured; the round-2 rc tables live in this
    file's git history). Each verb carries its COMPLETE long-option table with per-name
    arity, because git accepts any unambiguous PREFIX of a long name
    (`--orph <b>` is the branch creation it abbreviates) and the `parse-options`
    built-ins absent from `-h` (`--end-of-options`,
    `--git-completion-helper`, `--help-all`, ...) are in the tables at arity 0
    — `--end-of-options` ends the OPTIONS without giving the next token
    checkout's pathspec meaning. `--` is checkout's pathspec separator but
    only switch's end-of-options (`git checkout <b> --` switches while
    `git switch -- main` stays put; both measured), and `--help` no longer
    returns ahead of the fence.
  - **An INCOMPLETE parse may not ALLOW.** An unresolvable or ambiguous
    option BLOCKS, naming it; an unbalanced quote is REFUSED rather than
    silently truncated (`-b agent's-branch` used to yield the single token
    `-b` and pass). The same fence applies to the shell grammar rather than a
    fourth enumeration: a word `gate_argv` cannot fully account for sets
    `parse_certain=0`, and `gate_word_is_literal` admits a word only when
    every character outside a quoted span is on `GATE_INERT_CHARS`, a CLOSED
    list of characters that trigger no shell processing — a shape nobody has
    thought of lands on BLOCK because every shell construct is SPELLED with a
    character the list does not hold (`{fd}>/dev/null` is caught by `>` and
    `{` without either being named as a redirection form). One exemption is
    proved rather than assumed: a word beginning with the literal `@{-`
    cannot vanish. This closed a regression the parse itself introduced —
    `gate_argv` had ENUMERATED the shell forms it recognised and passed
    everything else through, so `$EMPTY` and `{fd}>/dev/null` became phantom
    positionals relaxing the verdict. One retired sentence kept as behaviour:
    `remote_dwim_names` has no uniqueness check, so a name on two remotes has
    git refuse while the gate blocks — the conservative direction.
  - **The target tree is resolved PER SEGMENT, from the SAME segment that
    carries the arguments** — a command spanning two trees is judged per
    segment. Resolving it once per command was live in both siblings and
    wrong in both directions (measured:
    `git -C <wt> switch -c a && git switch -c b` scored 0 where 2 was wanted,
    and `git switch main && git -C <wt> switch -c a` refused the worktree
    branch creation the convention mandates).
  - **`branch-gate` recognises a DETACHED HEAD in the main checkout as "off
    `main`"** (go-to-k/cdkd#2402): it read the state by branch NAME through
    `symbolic-ref --short HEAD`, which is EMPTY while detached, so the
    `main|master` case matched neither arm and the commit went through — and
    the `git checkout <sha>` THIS gate passes as inspection is what detaches
    the shared tree, so the two gates composed into a hole neither had alone
    (measured on a scratch opted-in repo: rc=0 once detached, rc=2 after the
    fix). A detached LINKED worktree still passes — that is the lane-clearing
    state `stop-unmerged-lane-warn.sh` prescribes.
  - **The refusal's printed remedy follows the operation in progress**: a
    conflicted rebase is one of the ways the shared checkout detaches, and
    there git refuses `git switch main` outright — so the gate reads the
    TARGET's RESOLVED git dir (not `<dir>/.git`, wrong from a subdirectory)
    for `rebase-merge` / `rebase-apply` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` /
    `MERGE_HEAD` / `BISECT_LOG` and prints `<op> --continue` / `<op> --abort`,
    or `bisect reset`. The `applying` sentinel inside `rebase-apply`
    separates `git am` from `git rebase --apply`, and it is load-bearing in
    the direction that fails SILENTLY: `git am --abort` inside a
    `git rebase --apply` session exits 0 with no output and leaves HEAD
    DETACHED, while the reverse crossing is loud (rc=128). Both arms exit 2,
    so the suite asserts the MESSAGE TEXT.
  - **What the remedy does to HEAD is stated CONDITIONALLY, because it IS
    conditional** — exit status was the wrong observable (all nine printed
    remedies exit 0). Measured on git 2.53 by RUNNING each printed remedy and
    reading HEAD afterwards: `am --abort`, `cherry-pick --abort`,
    `revert --abort` and `merge --abort` all leave HEAD DETACHED (those four
    never detach HEAD themselves, so this arm is reachable for them only from
    an already-detached tree, and `--abort` restores exactly that pre-op
    state); a rebase re-attaches only when started FROM a branch. The
    discriminator is git's own `head-name`, which both rebase backends write;
    the gate reads it and prints either "Either ending re-attaches HEAD to
    '<branch>'" or "NEITHER ending re-attaches HEAD" plus the `switch main`
    still needed afterwards — one sentence for both endings, because the
    outcome is a property of the SESSION, not of which ending is picked. The
    bisect arm carried the same defect one arm over: `bisect reset` restores
    a branch only when `BISECT_START` holds one (started DETACHED it holds a
    raw SHA, and `bisect reset` exits 0 with HEAD STILL DETACHED). The gate
    reads `BISECT_START` and asks with `show-ref --verify refs/heads/<x>`
    rather than a 40-hex pattern — the question `git bisect reset` itself
    ends in — so a branch literally NAMED 40 hex characters, an empty
    `BISECT_START`, and a start branch deleted by `update-ref -d` are each
    answered the way git answers them. Rows RUN the printed remedies and
    assert the resulting HEAD, both polarities.
  - **The suite does not inherit the developer's git config.** It exports
    `GIT_CONFIG_GLOBAL=/dev/null` / `GIT_CONFIG_SYSTEM=/dev/null`, carries a
    POSITIVE probe that git actually HONOURS those variables (2.32+) rather
    than exporting them into a git that ignores them, and names each rebase
    row's backend explicitly (`--merge` / `--apply`), which outranks a global
    `rebase.backend`. What still breaks FIXTURES — why the exports are
    load-bearing — is anything that breaks the fixture COMMITS: a global
    `commit.gpgsign = true`, or a global `init.templateDir` pointing at a
    FAILING hook, each scored 56 pass / 25 fail plus 18 fixture failures on
    the unmutated hook; with the neutraliser, setting all three leaves the
    tally unmoved (the author's machine HAS `init.templateDir` set, whose
    hooks exit 0 — why the suite looked green).
  - **The fail-CLOSED guard names EVERY library function the hook calls.** It
    used to check ONE (`gate_matches`) while the hook also calls
    `gate_target_dir` — 239 and 962 lines into a 1094-line library — so a
    copy truncated between them defined the first, passed the guard, then
    died inside a command substitution whose 127 the hook read as "no target
    dir" and exited 0. Measured by cutting the library at every 25th line: 30
    of 44 offsets NOT BLOCKED before, 0 of 44 after (cdkd's twin had named
    every called function since go-to-k/cdkd#2130 — this was unported drift).
    The same rounds gave rows to every assertable-but-unasserted arm:
    `master` in the `main|master` pattern; both fail-CLOSED refusals, each
    needling its OWN message tail (deleting one arm no longer satisfies
    both); the refusal's diagnosis block and branch-name message body; the
    `show-ref --verify` lookup vs the 40-hex pattern its own comment rejects
    (two fixtures build the states that separate them); and the harness's
    `${line% #*}` remedy strip (one fixture now lives under a `#`-bearing
    path, and the harness extracts the remedy by its two-space-then-git
    indent, not print order — re-ordering the message plus the old extraction
    EVALed an English sentence). A fixture failure no longer increments the
    row counter, so `Pass + Fail` again equals the case count.
  - **Two stated bounds**, recorded as bounds rather than bugs: a path
    containing a NEWLINE still fails open — awk's records ARE lines, and
    `worktree list --porcelain -z` is deliberately not taken (an unsupported
    flag makes `worktree list` print NOTHING, failing OPEN on every older
    git: that would retire the spaced-path fence over a shape this repo HAS
    produced in exchange for one over a shape nobody has). And a
    `rebase-apply/` directory holding neither `applying` nor `head-name`
    reads as a rebase here — `git status` calls that same state "rebasing",
    and no git command produces it.

#!/usr/bin/env bash
# main-tree-branch-gate.sh
#
# PreToolUse hook. Blocks branch-switching commands in the MAIN CHECKOUT (= the
# repo top-level dir) so parallel lanes cannot race or clobber each other on the
# shared tree. The main checkout must stay on `main` / `master`; feature branches
# live in their own `.worktrees/<name>/`.
#
# WHY this gate (go-to-k/cdk-real-drift#1845). The main checkout is a SHARED
# RESOURCE across parallel sessions. When lane A is mid-flight and lane B runs
# `git switch <other-feature>` there, A's uncommitted work is either clobbered or
# silently stashed. This repo has been bitten twice — a README clobber, and a
# branch created in the shared checkout that captured another session's staged
# R44 commit (CLAUDE.md, "ALWAYS develop in a git worktree").
#
# The three gates already here do NOT cover this:
#   - `branch-gate.sh` fires on `git commit` / `git push`, i.e. on the SYMPTOM,
#     after the branch already exists in the shared tree.
#   - `worktree-guard.sh` fires on Edit/Write into the main checkout's `src/**` /
#     `tests/**`, not on a branch SWITCH.
#   - `stale-base-gate.sh` fires on `git push`.
# Measured 2026-08-31 by reading all three; nothing in `.claude/settings.json`
# was wired to `git switch` / `git checkout` at all.
#
# Resolution order for "where is this git command running", applied PER SEGMENT
# — a `-C` binds its one command, a `cd` persists into the next:
#   1. that segment's own `git -C <path>` — last `-C` wins.
#   2. the `cd <path>` segments before it.
#   3. the hook payload's `cwd` field.
#   4. $PWD.
#
# PER SEGMENT because ONE command can straddle TWO trees, and resolving the tree
# once for the whole command gets BOTH directions wrong. Measured against this
# repo's real main checkout and a real linked worktree, payload cwd = the main
# checkout, with the tree resolved once outside the walk and then per segment:
#
#                                                     before  after  want
#   git -C <wt> switch -c a && git switch -c b            0      2     2
#   git -C <wt> checkout -b a && git checkout -b b        0      2     2
#   git switch main && git -C <wt> switch -c a            2      0     0
#
# The first two let a branch be created in the SHARED main checkout unjudged;
# the third refuses the worktree branch creation the convention mandates.
#
# Gate scope:
#   - Block: `git switch <not-main>`, `git switch -c|-C|--create|--force-create
#     <branch>`, `git switch --orphan <branch>`, `git switch --detach`,
#     `git checkout -b|-B|--orphan <branch>`, `git checkout -t <remote-ref>`,
#     `git switch -` / `git checkout -` / `@{-1}` (the previous branch under BOTH
#     verbs), and `git checkout <not-main>` when `<not-main>` is the only
#     positional AND names either a LOCAL branch or a branch on a CONFIGURED
#     remote (git DWIMs the second into a create + switch). A leading FLAG never
#     counts as the branch name, a GLUED value is read (`-bfeat`, `-fbfeat`,
#     `--orphan=feat`, `--track=direct`), and a value-taking flag's argument is
#     CONSUMED rather than counted as a pathspec.
#   - Pass: `git switch main` / `master`, `git checkout main` / `master`,
#     `git checkout [<tree-ish>] -- <pathspec>` and `git checkout <tree-ish>
#     <pathspec>` (file restores — measured, HEAD stays put), the restore FLAGS
#     `-p` / `--ours` / `--theirs` / `--pathspec-from-file` (measured, HEAD stays
#     put and real git refuses to combine the middle two with a switch at all),
#     `git checkout <sha>` (detached HEAD — see the `--detach` note on
#     `verdict_for` for what that actually costs), `--help`, `git worktree add
#     ...` (the sanctioned path), and everything in a LINKED worktree, which is
#     where the convention wants feature branches.
#
# Bypass: there is no flag. An agent that genuinely needs to operate on a feature
# branch in the main checkout (release surgery, history rewrite) confirms with
# the user first.

set -u

# Fail CLOSED if the shared matcher is missing or does not load: a gate that
# cannot decide must not wave the command through. `[ -r … ] || exit 0` was the
# first shape in the sibling gates, and it silently disabled them whenever the
# library was unreadable or truncated (go-to-k/cdkd#2130 review). The `declare -F`
# check catches a partial source, where `.` succeeds but the function is missing.
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"
if [ ! -r "$_gate_lib" ]; then
  echo "Blocked: .claude/hooks/_command-match.sh is missing or unreadable, so this gate cannot evaluate the command." >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$_gate_lib"
# `gate_verb_args_dir` is named too, not only `gate_matches`: it feeds the
# segment loop through a process substitution, so a library that predates it
# yields NO lines, the loop body never runs, and the gate exits 0 — a silent
# bypass with no error anywhere. That is exactly what this check exists to stop.
#
# `gate_argv` and its two CONSTANTS are named for a second reason: they are what
# turns the argument text into git's ARGV. A library predating either constant
# leaves that ERE EMPTY, and an empty ERE matches EVERY string at position 0
# with every capture group empty -- so `gate_tokens` would print an empty first
# token forever and `gate_argv` would drop every word as a redirection. Either
# way the option walk sees nothing and every command reads like a bare
# `git checkout`. `declare -F` cannot see a missing constant; only this can.
if ! declare -F gate_matches >/dev/null 2>&1 \
  || ! declare -F gate_verb_args_dir >/dev/null 2>&1 \
  || ! declare -F gate_unquote >/dev/null 2>&1 \
  || ! declare -F gate_tokens >/dev/null 2>&1 \
  || ! declare -F gate_argv >/dev/null 2>&1 \
  || [ -z "${GATE_EMBEDDING_TOKEN:-}" ] \
  || [ -z "${GATE_REDIR_TOKEN:-}" ]; then
  echo "Blocked: .claude/hooks/_command-match.sh loaded but gate_matches / gate_verb_args_dir / gate_unquote / gate_tokens / gate_argv / GATE_EMBEDDING_TOKEN / GATE_REDIR_TOKEN is undefined (truncated or stale file?)." >&2
  exit 2
fi

input=$(cat 2>/dev/null || true)

# THE ONE FAIL-OPEN THIS FILE HAS, STATED BECAUSE THE PARAGRAPH ABOVE ARGUES THE
# OPPOSITE POLARITY FOR THE LIBRARY. A MISSING `jq` PASSES EVERYTHING, SILENTLY.
# Measured with a jq-free PATH (a directory of symlinks to every other binary):
# `git switch -c wt-feat-new` with the payload cwd on a real main checkout came
# back rc=0 and printed nothing, where the same call with jq present is rc=2.
# `jq -r` fails, `|| echo ""` empties `cmd`, no segment matches, `exit 0`.
#
# Left as-is DELIBERATELY: every other gate in this repo reads its payload the
# same way, so refusing here alone would make one hook diverge from the
# convention on an input shape none of them can currently handle. Closing it is a
# repo-wide change (a shared `gate_read_payload` that refuses when `jq` is
# absent), not a change to this file. The exposure is bounded by `jq` being a
# hard dependency of the whole hook set rather than of this gate.
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Canonicalize a path before comparing. macOS resolves `/tmp` -> `/private/tmp`
# and `/var` -> `/private/var` via symlinks; `git worktree list --porcelain`
# always emits the real path, while the payload cwd may still carry the symlink.
# `cd <dir> && pwd -P` is the portable canonicalizer (BSD readlink lacks `-f`
# until 12+).
canonicalize() {
  local p="$1"
  if [ -d "$p" ]; then
    (cd "$p" 2>/dev/null && pwd -P) || printf '%s' "${p%/}"
  else
    printf '%s' "${p%/}"
  fi
}

# main_tree_of <dir>
#
# Set `main_tree_out` to the MAIN checkout's path when <dir> IS that checkout AND
# the repo opts into the convention; return 1 otherwise. Called PER MATCHED
# SEGMENT — see the per-segment table in the header.
#
# IT RETURNS THROUGH A GLOBAL RATHER THAN STDOUT, and that is what makes the memo
# below real. The first shape `printf`ed the path and every caller was
# `seg_main=$(main_tree_of "$dir")` — a COMMAND SUBSTITUTION, i.e. a subshell, so
# both memo variables were written in a child process and thrown away at the
# closing paren. Instrumented on a 3-segment same-tree command
# (`git switch main && git switch master && git switch -c wt-probe`):
# 3 calls, 3 `git worktree list` forks, MEMO-HIT 0. As a statement + global the
# same command forks ONCE.
#
# `substr($0, 10)` rather than `$2`: awk splits on whitespace, so a repo path
# containing a SPACE was truncated at it, the compare below then never matched,
# and the gate stood down over a main checkout it had mis-read. The sibling
# cdk-local carried the `$2` form and its suite never noticed, because every
# fixture path was space-free.
#
# ONE-ENTRY memo: every ordinary command's segments share a tree, and a miss
# costs a `git worktree list` fork inside a PreToolUse hook that runs on every
# Bash call. bash 3.2 has no associative arrays and a deeper cache buys nothing
# at these sizes. Measured above: 3 forks before, 1 after.
#
# LIMIT, stated rather than hidden. `gate_segments` FLATTENS a subshell, so a
# `cd` inside one leaks past the closing paren and steers every later segment:
#
#   (cd <worktree> && git switch -c a) && git switch -c b
#
# resolves segment 3 to the worktree and PASSES.
#
# THE LEAK IS BIDIRECTIONAL, and an earlier revision of this paragraph claimed it
# was not ("a leaked `cd` can only ever make the gate quieter, never make it
# false-block"). Measured with the payload cwd set to a LINKED WORKTREE:
#
#   (cd <main checkout> && git status) && git switch -c b      rc=2, want 0
#
# In real bash that `git switch -c b` runs in the WORKTREE — the subshell's `cd`
# died at the closing paren — so this refuses a branch creation the convention
# mandates, on a command whose subshell does not even name a git verb. Both
# directions have the same single cause and the same single fix: teaching the
# shared segmenter to report subshell depth, which is a change to every gate that
# calls it, not to this one.
_mt_memo_dir=""
_mt_memo_val=""
main_tree_out=""
main_tree_of() {
  local dir="$1" mt
  main_tree_out=""
  if [ "$dir" = "$_mt_memo_dir" ]; then
    [ -n "$_mt_memo_val" ] || return 1
    main_tree_out="$_mt_memo_val"
    return 0
  fi
  _mt_memo_dir="$dir"
  _mt_memo_val=""
  # `git rev-parse --show-toplevel` returns the CURRENT worktree's top, which
  # differs between the main checkout and any `.worktrees/<x>/`. Cheaper
  # heuristic: the main checkout is whatever `git worktree list` lists first.
  mt=$(git -C "$dir" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0, 10); exit}')
  # Not in a git repo / cannot resolve — pass through (we do not gate what we
  # cannot see).
  [ -n "$mt" ] || return 1
  # Repo OPT-IN scope: only repos following the worktree + markgate convention
  # get main-checkout branch protection. An unrelated repo worked on from this
  # session (a personal blog, a scratch clone) has no parallel-lane contention.
  # Opt-in signal: a `.markgate.yml` at the main checkout root.
  [ -f "$mt/.markgate.yml" ] || return 1
  # A LINKED worktree (`.worktrees/<x>/` or similar) is exactly where the
  # convention wants feature branches, so it is not gated.
  [ "$(canonicalize "$dir")" = "$(canonicalize "$mt")" ] || return 1
  _mt_memo_val="$mt"
  main_tree_out="$mt"
}

# remote_dwim_names <dir>
#
# One candidate DWIM name per line: the names `git checkout <name>` may CREATE a
# local branch for and switch to, because a remote carries them. Two things it
# must get right, both measured against real git 2.53 on a fixture clone:
#
#   SYMREFS ARE NOT BRANCHES. `refs/remotes/<remote>/HEAD` exists in essentially
#     every clone, and `%(refname:lstrip=3)` renders it as the bare name `HEAD`.
#     Real git leaves HEAD exactly where it was for `git checkout HEAD`
#     (measured: "Your branch is ahead of 'origin/main'", HEAD stayed `main`), so
#     a list carrying it false-blocks a read-only command. `git branch HEAD` is
#     refused by git itself, so dropping symrefs costs no real candidate.
#
#   A REMOTE NAME MAY CONTAIN A SLASH, so a fixed `lstrip=3` is wrong. `git
#     remote add a/b <url>` is accepted -- measured -- and the branch `deep-only`
#     on it lands at `refs/remotes/a/b/deep-only`, which lstrips to
#     `b/deep-only` while git DWIMs plain `deep-only` ("Switched to a new branch
#     'deep-only'", HEAD moved). A gate comparing against `b/deep-only` PASSES
#     that switch -- measured against this gate before this function replaced the
#     `lstrip=3` scan: rc=0 where 2 is wanted. The prefix is therefore stripped
#     PER REMOTE using the remote's own name, so it is right whatever the name
#     contains.
#
# ITERATING THE CONFIGURED REMOTES is also what makes the list stop at what git
# will actually DWIM. A ref can sit under `refs/remotes/<name>/` with no remote
# `<name>` configured -- `git update-ref` puts one there, and a removed remote
# can leave one behind. Measured: with `refs/remotes/ghostremote/ghost` present
# and no `ghostremote` remote, `git checkout ghost` answers "pathspec 'ghost'
# did not match any file(s) known to git" and HEAD stays -- while a scan of
# `refs/remotes/` alone offered `ghost` as a candidate and this gate blocked it.
#
# WHAT IT DOES NOT CHECK, stated because an earlier wording claimed it did: there
# is no UNIQUENESS check. With the same name on two remotes git REFUSES ("hint:
# If you meant to check out a remote tracking branch on, e.g. 'origin'", HEAD
# stays -- measured) while this list still offers the name and the gate blocks.
# That is the conservative direction, so the behaviour stays; the claim that the
# list holds only names "exactly one remote carries" does not.
#
# The pattern stays the PREFIX `refs/remotes/<remote>/`, never `.../*/*`: in
# `for-each-ref` a `*` does not cross a `/`, so the two-star form misses every
# slashed BRANCH name (`origin/topic/nested`), which is most of them in this flow.
remote_dwim_names() {
  local dir="$1" remote refname symref
  while IFS= read -r remote; do
    [ -n "$remote" ] || continue
    # `%(refname)` FIRST and the symref second: with `IFS=<tab>` a LEADING empty
    # field is eaten (tab is IFS whitespace), so the symref-first spelling shifts
    # every ordinary ref's name into the wrong variable. In this order the
    # `IFS=$'\t' read` spelling is safe -- git refuses a ref name containing any
    # ASCII control character, tab included, so neither field can hold a tab run
    # for `read` to fold.
    while IFS=$'\t' read -r refname symref; do
      [ -n "$refname" ] || continue
      [ -z "$symref" ] || continue
      printf '%s\n' "${refname#refs/remotes/$remote/}"
    done < <(git -C "$dir" for-each-ref \
      --format=$'%(refname)\t%(symref)' "refs/remotes/$remote/" 2>/dev/null)
  done < <(git -C "$dir" remote 2>/dev/null)
}

# The LONG-OPTION grammar of each verb, transcribed from `git checkout -h` /
# `git switch -h` (git 2.53.0), one `<name>:<arity>` per line:
#
#   0   takes nothing
#   1   REQUIRES a value, which the spaced spelling takes from the NEXT token
#   ?   OPTIONAL value, which the spaced spelling does NOT take -- measured,
#       `git checkout -t origin/remote-only` creates local `remote-only`, so the
#       ref that follows is a start-point POSITIONAL and not the flag's argument
#
# It is COMPLETE rather than a list of the interesting flags, and that is
# load-bearing twice over.
#
#   git ACCEPTS ANY UNAMBIGUOUS PREFIX of a long name, which `-h` does not show
#     and an earlier revision of this parse took from `-h` alone. Measured:
#     `git checkout --orph newb` prints "Switched to a new branch 'newb'",
#     `git checkout --or newb` does the same (`orphan` is the only name starting
#     `or`), and `git checkout --trac origin/<b>` creates local `<b>` and
#     switches. All three scored rc=0 against this gate before the table existed.
#     A prefix can only be resolved against the WHOLE name set, so a table
#     holding just the flags this gate cares about would answer "unknown" for
#     `--or` one day and "ambiguous" the next as the set changed.
#
#   AN UNMODELLED VALUE-TAKING FLAG MOVES EVERY POSITIONAL AFTER IT. That is the
#     `--conflict merge <branch>` defect, and it is a defect of the TABLE, not of
#     the walk.
#
# Every `--[no-]x` line in `-h` contributes BOTH `x` and `no-x`. The negated form
# takes no value and carries no effect -- measured: `git checkout --no-orphan
# some-feature` and `git checkout --no-conflict some-feature` both switch, so the
# name after them is a positional.
GATE_CHECKOUT_LONG_OPTS='help:0
guess:0
no-guess:0
overlay:0
no-overlay:0
quiet:0
no-quiet:0
recurse-submodules:?
no-recurse-submodules:0
progress:0
no-progress:0
merge:0
no-merge:0
conflict:1
no-conflict:0
detach:0
no-detach:0
track:?
no-track:0
force:0
no-force:0
orphan:1
no-orphan:0
overwrite-ignore:0
no-overwrite-ignore:0
ignore-other-worktrees:0
no-ignore-other-worktrees:0
ours:0
theirs:0
patch:0
no-patch:0
unified:1
inter-hunk-context:1
ignore-skip-worktree-bits:0
no-ignore-skip-worktree-bits:0
pathspec-from-file:1
no-pathspec-from-file:0
pathspec-file-nul:0
no-pathspec-file-nul:0'

GATE_SWITCH_LONG_OPTS='help:0
create:1
no-create:0
force-create:1
no-force-create:0
guess:0
no-guess:0
discard-changes:0
no-discard-changes:0
quiet:0
no-quiet:0
recurse-submodules:?
no-recurse-submodules:0
progress:0
no-progress:0
merge:0
no-merge:0
conflict:1
no-conflict:0
detach:0
no-detach:0
track:?
no-track:0
force:0
no-force:0
orphan:1
no-orphan:0
overwrite-ignore:0
no-overwrite-ignore:0
ignore-other-worktrees:0
no-ignore-other-worktrees:0'

# resolve_long_opt <verb> <name-without-dashes>
#
# Answers in the globals `gate_long` (the canonical name) and `gate_long_arity`.
# Returns 0 on a resolved name, 1 on an unknown one, 2 on an AMBIGUOUS prefix --
# and git's own answers for those two are "error: unknown option" and "error:
# ambiguous option", both of which abort the command without touching HEAD.
# An EXACT match wins over any prefix, as it does in git's parse-options.
gate_long=""
gate_long_arity=""
resolve_long_opt() {
  local verb="$1" name="$2" table n a hits=0
  gate_long=""
  gate_long_arity=""
  if [ "$verb" = switch ]; then table="$GATE_SWITCH_LONG_OPTS"; else table="$GATE_CHECKOUT_LONG_OPTS"; fi
  while IFS=: read -r n a; do
    [ -n "$n" ] || continue
    if [ "$n" = "$name" ]; then
      gate_long="$n"
      gate_long_arity="$a"
      return 0
    fi
  done <<EOF
$table
EOF
  while IFS=: read -r n a; do
    [ -n "$n" ] || continue
    # `$name` is QUOTED so a glob character inside it is literal; the trailing
    # `*` is the only wildcard.
    case "$n" in
      "$name"*) hits=$((hits + 1)); gate_long="$n"; gate_long_arity="$a" ;;
    esac
  done <<EOF
$table
EOF
  [ "$hits" -eq 1 ] && return 0
  gate_long=""
  gate_long_arity=""
  [ "$hits" -eq 0 ] && return 1
  return 2
}

# verdict_for <verb> <args> <dir>
# 0 = this segment must be BLOCKED (with `target_branch` / `block_reason` set),
# 1 = allowed. <args> is everything after the matched verb, flags included,
# because the verb ERE already consumed the leading `git -C ... ` flag run.
#
#   `git switch <main|master>`             -> allow
#   `git checkout <main|master>`           -> allow
#   `git switch -- <main|master>`          -> allow (`--` under switch only ends
#                                            the options; switch has no pathspec)
#   `git switch -c|-C|--create|--force-create <branch>` -> block
#   `git switch|checkout --orphan <branch>`             -> block
#   `git switch <other-branch>` / `git switch -- <other-branch>` -> block
#   `git switch|checkout -` / `@{-1}`      -> block (previous branch, unknowable)
#   `git switch --detach`                  -> block
#   `git checkout -b|-B <branch>`          -> block
#   `git switch|checkout -t|--track <remote-ref>` -> block (DWIM create + switch)
#   `git checkout <other-branch>`          -> block when NO pathspec operand
#                                            follows it AND it names a LOCAL
#                                            branch or a branch on a CONFIGURED
#                                            remote
#   `git checkout <branch> --`             -> block: a `--` with nothing after it
#                                            leaves no pathspec, so this is the
#                                            switch (measured: HEAD moved)
#   `git checkout [<tree-ish>] -- <paths>` -> allow (file restore)
#   `git checkout <tree-ish> <paths>`      -> allow (file restore, no `--`)
#   `git checkout -p|--ours|--theirs|--pathspec-from-file ...` -> allow (restore)
#   `git checkout --no-guess <remote-only-name>` -> allow (DWIM is off; measured,
#                                            "pathspec did not match", HEAD stays)
#   `git checkout <sha>` / `HEAD`          -> allow (detached HEAD / a rev)
#   `git switch|checkout --help`           -> allow
#
# A REAL OPTION PARSE over git's ARGV. Three properties carry the whole design,
# and each replaced a class of defect rather than a spelling:
#
# 1. THE INPUT IS ARGV, NOT SHELL WORDS. `gate_argv` drops the words the SHELL
#    owns -- a redirection and its target, a trailing `&`, a `#` comment -- so
#    they cannot be miscounted as arguments. Reading `gate_tokens` output
#    directly made `git checkout <branch> 2>/dev/null`, `... >/dev/null 2>&1` and
#    `... # switch lane` read as two-positional file restores and PASS; all three
#    really move HEAD (measured, `main` -> `some-feature`).
#
# 2. FLAGS ARE RESOLVED AGAINST A COMPLETE GRAMMAR, prefixes included (see the
#    tables above), and a SHORT token is walked as a CLUSTER because git's
#    parse-options accepts `-qbfeat` as `-q -b feat` and takes the remainder of
#    the cluster as a value-taking letter's value. Every glued spelling --
#    `-bfeat`, `-Bfeat`, `-cfeat`, `-Cfeat`, `--create=feat`, `--orphan=feat` --
#    was measured creating the branch and switching to it.
#
# 3. AN INCOMPLETE PARSE MAY NOT ALLOW. When a long name resolves to no entry or
#    to more than one, or a cluster letter is unknown, the walk does not know
#    where the positionals are -- it cannot tell whether the flag would have
#    eaten the next token. Every arm below that ALLOWS depends on that knowledge;
#    the arms that BLOCK do not. So an unresolved option sets `parse_certain=0`
#    and the verdict is a conservative block naming the option. This is the
#    general form of the two defects that a POSITIONAL COUNT produced -- first
#    `--conflict merge <branch>` (a value read as a positional), then
#    `<branch> 2>/dev/null` (a shell word read as a positional). Both were the
#    count RELAXING a verdict on a parse that was not complete. Today the arm
#    fires only on commands git itself refuses ("error: unknown option" /
#    "error: ambiguous option"), so it costs nothing now; it is what keeps a
#    FUTURE git option from re-opening the same hole silently.
#
# The positional structure this parse still reads is the one GIT reads, and it is
# a boolean rather than a tally: `first_pos` (the switch target) and
# `pathspec_seen` (a pathspec operand exists). Git's own grammar is
# `git checkout [<options>] <branch>` OR
# `git checkout [<options>] [<branch>] -- <file>...`, so no correct gate can
# avoid asking whether an operand follows the target -- `git checkout <branch>
# <path>` restores a file and leaves HEAD alone while `git checkout <branch>`
# switches, and only the extra operand tells them apart (both measured). What is
# fixed is WHAT is examined: git's argv, fully parsed, or nothing.
#
# Verdicts settled against real git first, printing HEAD and the local branch
# list before and after. The defects this parse replaced, in the order found:
#
#   git checkout <branch> -- <paths>   was BLOCKED, and must not be: it restores
#     FILES and leaves HEAD alone. `git checkout <branch> <paths>` without the
#     `--` behaves identically. go-to-k/cdk-real-drift MANDATES the `--` spelling
#     for its integration step, so the old reading refused a sibling repo's own
#     documented flow.
#
#   git checkout <branch> --           was ALLOWED once that fix shipped, and
#     must not be: a `--` with NOTHING after it leaves no pathspec at all.
#     Measured -- "Switched to branch 'some-feature'", HEAD moved. The rule is
#     therefore "a pathspec operand exists", not "a `--` was seen".
#
#   git switch -- main                 was BLOCKED, and must not be: `git switch`
#     has NO pathspec form (`usage: git switch [<options>] [<branch>]`), so `--`
#     there only ends the options. Measured -- "Already on 'main'". The same
#     token walk was applying checkout's grammar to both verbs, and the command
#     landed on the "no resolvable target" arm. `git switch -- <feature>` DOES
#     switch (measured), so that one still blocks.
#
#   git checkout -f <branch>           was ALLOWED: `-f` was read AS the branch
#     name, `refs/heads/-f` does not resolve, and the gate passed.
#
#   git checkout --orphan <branch>     was ALLOWED: `--orphan` was read as the
#     branch name.
#
#   git checkout <name> / -t origin/<name>
#     were ALLOWED. With no LOCAL `<name>` but a remote carrying it, both CREATE
#     the local branch and switch -- measured, HEAD went `main` -> `feat`. That is
#     how a lane's branch usually FIRST appears in a checkout.
#
#   git checkout -  /  git checkout @{-1}   were ALLOWED while `git switch -`
#     blocked. Measured -- both print "Switched to branch 'other'" and move HEAD.
#
#   git checkout --conflict merge <branch>   was ALLOWED: `merge` inflated a
#     positional count and the command read as a restore. Measured -- it switches.
#
#   git checkout --orph <branch> / --trac origin/<b> / --or <b>   were ALLOWED:
#     git accepts unambiguous PREFIXES of a long name and the parse only knew the
#     full spellings. Measured -- all three move HEAD.
#
#   git checkout deep-only             was ALLOWED where `deep-only` lives on a
#     remote whose NAME contains a slash. Measured -- "Switched to a new branch
#     'deep-only'". The DWIM list was built with a fixed `lstrip=3`.
#
#   git checkout ghost                 was BLOCKED where `refs/remotes/ghostremote/ghost`
#     exists with NO `ghostremote` remote configured. Measured -- "pathspec
#     'ghost' did not match", HEAD stays.
#
#   git checkout --pathspec-from-file <f> <branch>   was BLOCKED: the pathspecs
#     come FROM THE FILE, so the trailing token is the tree-ish and the command is
#     a RESTORE. Measured -- "Updated 1 path from ...", HEAD stayed `main`. The
#     flag had been filed with `--conflict` as merely value-taking.
#
#   git checkout --no-guess <remote-only-name>   was BLOCKED: `--no-guess` turns
#     the DWIM off, so git answers "pathspec did not match" and HEAD stays --
#     measured, against a name that DID move HEAD without the flag.
#
# `--detach` stays asymmetric between the verbs: `git switch --detach` blocks
# while `git checkout <sha>` / `git checkout --detach <sha>` passes. That is the
# behaviour this gate shipped with, kept rather than silently changed here --
# but the rationale it shipped with, "the sha form is read-only inspection", is
# FALSE and is not repeated. `git checkout <sha>` REWRITES the shared working
# tree and leaves a detached HEAD, and the detached HEAD then disarms the
# sibling gate: `branch-gate.sh` reads
# `git -C <dir> symbolic-ref --short HEAD`, which is EMPTY while detached, and
# falls through to its `exit 0`. Measured in a throwaway repo carrying a
# `.markgate.yml`, driving branch-gate with `git commit -m x`: rc=2 on `main`,
# rc=0 once detached. So allowing the sha form leaves a two-step path to an
# ungated commit in the main checkout. Changing the verdict is a behaviour
# change with its own blast radius (it would refuse a legitimate inspection
# spelling in three repos) and belongs in its own PR, not smuggled into a parse
# fix -- recorded here and in .claude/rules/hooks.md so the next reader inherits
# the measurement rather than the old claim. What IS fixed here is the WORDING:
# `git checkout -d <branch>` / `--detach <branch>` really detaches (measured,
# HEAD went to a raw sha), and the block used to announce it as "switches to
# feature branch '<branch>'" -- a verdict that was right about an operation git
# would not perform.
#
# KNOWN BOUND, in the message rather than the verdict: `gate_segments` truncates
# a segment at a `}`, so `git switch -c 'feat/{id}'` blocks correctly but the
# message and its `git worktree add` recipe name `feat/{id` . The cause is in the
# shared splitter, which every gate in the library calls; it is recorded in
# .claude/rules/hooks-main-tree-branch.md rather than worked around here.
verdict_for() {
  local verb="$1" rest="$2" dir="$3"
  local tok pending="" create_val="" create_flag="" detach_flag="" track_flag=""
  local prev_ref="" bad_opt=""
  local saw_help=0 saw_restore=0 end_opts=0 no_guess=0 detach_seen=0
  local pathspec_seen=0 parse_certain=1 is_pos=0
  local npos=0 first_pos="" name lval lhas letters ch rc
  target_branch=""
  block_reason=""

  # The argument text must be splittable into shell words at all. It is NOT when
  # a quote is unbalanced, and `gate_argv` reports that rather than returning a
  # truncation -- `-b agent's-branch` used to yield the single token `-b`, which
  # read as a bare `git checkout` and PASSED. Refusing is the deliberate choice
  # over a coarser second scan: the text is a shell syntax error in the first
  # place (measured: "unexpected EOF while looking for matching `''"), so nothing
  # legitimate is lost, and the message says exactly why.
  if ! gate_argv "$rest" >/dev/null 2>&1; then
    target_branch=""
    block_reason="carries an argument list this gate cannot split into shell words (unbalanced quote), so its target cannot be read -- block conservatively"
    return 0
  fi

  while IFS= read -r tok; do
    tok=$(gate_unquote "$tok")
    is_pos=0
    if [ -n "$pending" ]; then
      # `value` is a branch name; `skip` is some other flag's required argument,
      # consumed only so it cannot be miscounted as a positional.
      [ "$pending" = value ] && create_val="$tok"
      pending=""
    elif [ "$end_opts" -eq 1 ]; then
      is_pos=1
    else
      case "$tok" in
        # `--` ends the options. Under CHECKOUT everything after it is a
        # pathspec; under SWITCH there is no pathspec form, so what follows is
        # still the branch. Both measured.
        --) end_opts=1 ;;
        # `-` and `@{-N}` name the PREVIOUS branch under BOTH verbs. The pattern
        # is the PREFIX `@{-`, without the closing brace, and that is measured
        # rather than sloppy: `gate_segments` TRUNCATES a segment at a `}`, so
        # the shared walk hands this gate `git checkout @{-1` for an input of
        # `git checkout @{-1}`. A pattern requiring the `}` matched nothing.
        -|@{-*) prev_ref="$tok"; is_pos=1 ;;
        --*)
          # A long flag. Split on the FIRST `=`, so the glued and spaced
          # spellings of a value-taking flag reach the same arm, then resolve the
          # NAME against the verb's grammar -- exact match, else unique prefix.
          case "$tok" in
            --*=*) name="${tok%%=*}"; lval="${tok#*=}"; lhas=1 ;;
            *)     name="$tok";       lval="";          lhas=0 ;;
          esac
          resolve_long_opt "$verb" "${name#--}"
          rc=$?
          if [ "$rc" -ne 0 ]; then
            parse_certain=0
            [ -n "$bad_opt" ] || bad_opt="$name"
          else
            # A REQUIRED value that is not glued comes from the next token. The
            # effect arms below override `skip` with `value` where the argument
            # is the branch name itself.
            [ "$gate_long_arity" = 1 ] && [ "$lhas" -eq 0 ] && pending=skip
            case "$gate_long" in
              help) saw_help=1 ;;
              create|force-create|orphan)
                create_flag="--$gate_long"
                if [ "$lhas" -eq 1 ]; then create_val="$lval"; else pending=value; fi
                ;;
              track) track_flag="--track" ;;
              detach)
                detach_seen=1
                [ "$verb" = switch ] && detach_flag="--detach"
                ;;
              # File-restore markers. `--pathspec-from-file` belongs HERE and not
              # with the merely value-taking flags: the pathspecs come from the
              # FILE, so a trailing token is the tree-ish and the command is a
              # restore (measured: "Updated 1 path", HEAD stayed). Its value is
              # still consumed, by the arity line above.
              patch|ours|theirs|pathspec-from-file) saw_restore=1 ;;
              # `--pathspec-file-nul` is NOT a restore marker on its own: real git
              # refuses it without `--pathspec-from-file` ("fatal: the option
              # '--pathspec-file-nul' requires '--pathspec-from-file'"), so it
              # never appears in an accepted command that this arm would need to
              # judge.
              guess) no_guess=0 ;;
              no-guess) no_guess=1 ;;
              *) : ;;
            esac
          fi
          ;;
        -?*)
          # A SHORT flag CLUSTER: git's parse-options accepts `-qbfeat` as
          # `-q -b feat`, so the letters are walked one at a time and a
          # value-taking letter takes the REST of the token as its value, or the
          # next token when nothing is left.
          letters="${tok#-}"
          while [ -n "$letters" ]; do
            ch="${letters%"${letters#?}"}"
            letters="${letters#?}"
            case "$verb:$ch" in
              checkout:b|checkout:B|switch:c|switch:C)
                create_flag="-$ch"
                if [ -n "$letters" ]; then create_val="$letters"; letters=""
                else pending=value; fi
                ;;
              *:h) saw_help=1 ;;
              *:t)
                # OPTIONAL value: anything glued after `t` IS that value, and the
                # SPACED form consumes nothing -- measured, `git checkout -t
                # origin/remote-only` creates local `remote-only`, so the ref is
                # a start-point positional.
                track_flag="-t"
                letters=""
                ;;
              *:d)
                detach_seen=1
                [ "$verb" = switch ] && detach_flag="-d"
                ;;
              checkout:p|checkout:2|checkout:3) saw_restore=1 ;;
              checkout:U)
                # REQUIRED value.
                if [ -n "$letters" ]; then letters=""; else pending=skip; fi
                ;;
              *:q|*:m|*:f|checkout:l) : ;;
              *)
                # An unrecognised letter. git answers "error: unknown switch" and
                # aborts; this walk cannot know whether the letter would have
                # taken the rest of the cluster or the next token, so it stops
                # reading and marks the parse incomplete.
                parse_certain=0
                [ -n "$bad_opt" ] || bad_opt="-$ch"
                letters=""
                ;;
            esac
          done
          ;;
        *) is_pos=1 ;;
      esac
    fi
    if [ "$is_pos" -eq 1 ]; then
      if [ "$end_opts" -eq 1 ] && [ "$verb" = checkout ]; then
        pathspec_seen=1
      else
        npos=$((npos + 1))
        if [ "$npos" -eq 1 ]; then first_pos="$tok"; else pathspec_seen=1; fi
      fi
    fi
  done < <(gate_argv "$rest")

  [ "$saw_help" -eq 1 ] && return 1

  if [ "$parse_certain" -eq 0 ]; then
    # Property 3 in the header. The walk met an option it could not resolve, so
    # it does not know where the positionals are; refusing is the only answer
    # that cannot be wrong in the dangerous direction.
    target_branch=""
    block_reason="uses an option this gate cannot resolve against \`git $verb\`'s grammar ($bad_opt), so its target cannot be read -- block conservatively"
    return 0
  fi

  if [ -n "$create_flag" ]; then
    target_branch="$create_val"
    block_reason="creates new feature branch '$target_branch'"
    return 0
  fi
  if [ -n "$detach_flag" ]; then
    # Detaching HEAD moves the SHARED tree off `main` exactly as a branch switch
    # does, so the verdict is unchanged; only the wording is, since there is no
    # branch to name.
    target_branch=""
    block_reason="detaches HEAD in the main checkout (\`git switch $detach_flag\`)"
    return 0
  fi
  if [ -n "$track_flag" ] && [ "$saw_restore" -eq 0 ] && [ "$pathspec_seen" -eq 0 ] \
    && [ "$npos" -eq 1 ]; then
    # `git checkout -t origin/feat` / `git switch --track origin/feat` CREATE a
    # local `feat` and switch to it -- measured, and the local branch appeared.
    # The name is the start-point's LAST segment, so `origin/topic/x` yields `x`.
    target_branch="${first_pos##*/}"
    block_reason="creates new feature branch '$target_branch'"
    return 0
  fi
  if [ -n "$prev_ref" ] && [ "$saw_restore" -eq 0 ] && [ "$pathspec_seen" -eq 0 ] \
    && [ "$npos" -eq 1 ]; then
    target_branch="$prev_ref"
    block_reason="switches to the previous branch (\`git $verb $prev_ref\`); resolved branch unknown -- block conservatively"
    return 0
  fi

  case "$verb" in
    switch)
      case "$first_pos" in
        main|master) return 1 ;;
        "")
          # A bare `git switch` with no branch and no create flag. It is a git
          # error, but block conservatively rather than reason about a shape
          # nothing legitimate produces.
          target_branch=""
          block_reason="runs \`git switch\` in the main checkout with no resolvable target -- block conservatively"
          return 0
          ;;
        *)
          target_branch="$first_pos"
          block_reason="switches to feature branch '$first_pos'"
          return 0
          ;;
      esac
      ;;
    checkout)
      # `-p` / `--ours` / `--theirs` / `--pathspec-from-file` are RESTORE modes
      # whatever the operands look like: measured, `-p <branch>` prints a diff and
      # leaves HEAD on `main`, `--ours` / `--theirs` refuse to run without paths,
      # and `--pathspec-from-file <f> <branch>` updates paths from `<branch>`.
      [ "$saw_restore" -eq 1 ] && return 1
      # A PATHSPEC OPERAND exists -- either after a `--` or as a second
      # positional. That is `git checkout [<branch>] -- <file>...`, a file
      # restore, whatever it names. Note this is the operand's EXISTENCE, not a
      # count: `git checkout <branch> --` has a `--` and no operand, and it
      # switches.
      [ "$pathspec_seen" -eq 1 ] && return 1
      # No positional at all: a bare `git checkout` or `git checkout --`, both of
      # which leave HEAD alone (measured).
      [ "$npos" -eq 0 ] && return 1
      case "$first_pos" in
        main|master) return 1 ;;
        *)
          # A branch name or a sha. A name resolving to a LOCAL branch is a
          # branch switch; so is one that resolves on a CONFIGURED REMOTE (the
          # DWIM arm below). A sha or a pathspec passes. Both questions are asked
          # of the SEGMENT's own tree, since that is where the command would run.
          if git -C "$dir" show-ref --verify --quiet "refs/heads/$first_pos" 2>/dev/null; then
            target_branch="$first_pos"
            if [ "$detach_seen" -eq 1 ]; then
              block_reason="detaches HEAD in the main checkout at '$first_pos'"
            else
              block_reason="switches to feature branch '$first_pos'"
            fi
            return 0
          fi
          # DWIM. With no LOCAL `<name>` but a configured remote carrying it,
          # `git checkout <name>` CREATES the local branch and switches to it.
          # `--no-guess` turns that off, and then git answers "pathspec did not
          # match" and HEAD stays -- measured, so the arm is skipped for it.
          # `grep -qxF` is an exact whole-LINE match, so a name that is merely a
          # SUBSTRING of a remote branch does not false-block either.
          if [ "$no_guess" -eq 0 ] \
            && remote_dwim_names "$dir" | grep -qxF -- "$first_pos"; then
            target_branch="$first_pos"
            if [ "$detach_seen" -eq 1 ]; then
              block_reason="detaches HEAD in the main checkout at remote branch '$first_pos'"
            else
              block_reason="creates a local branch tracking remote '$first_pos' and switches to it"
            fi
            return 0
          fi
          return 1
          ;;
      esac
      ;;
  esac
  return 1
}

target_dir=""
main_tree=""
target_branch=""
block_reason=""
blocked=0

# EVERY matching segment is judged, not just the first: `git switch main && git
# switch -c feat` must block on its SECOND half. A gate whose verdict depends on
# the ARGUMENTS and that reads only segment 1 fences nothing one operator along.
#
# The two verbs are walked with SEPARATE EREs because the tail cannot be judged
# without knowing which fired — see the constants' header in _command-match.sh.
for gate_verb in switch checkout; do
  if [ "$gate_verb" = switch ]; then
    gate_re="$GATE_RE_GIT_SWITCH"
  else
    gate_re="$GATE_RE_GIT_CHECKOUT"
  fi
  gate_matches "$cmd" "$gate_re" || continue
  while IFS= read -r seg_line; do
    # Split on the FIRST tab only. `IFS=$'\t' read -r dir args` would fold a TAB
    # RUN inside the args — tab is IFS whitespace — and silently drop one.
    #
    # DEFENCE, NOT A FENCE, and it is labelled as one because no case can redden
    # it: substituting the `IFS` spelling leaves the suite at 92/0. The reason is
    # structural rather than a coverage gap — the only consumer of `seg_args` is
    # `gate_tokens`, whose token pattern opens with `^[[:space:]]*`, so a folded
    # tab run cannot change how the tail parses and therefore cannot change a
    # verdict. It stays because the NEXT consumer of this line may not tokenise.
    seg_dir="${seg_line%%	*}"
    seg_args="${seg_line#*	}"
    # A STATEMENT, not `$(main_tree_of …)`: the command substitution that shape
    # needs is a subshell, and it is what made the memo above dead code.
    main_tree_of "$seg_dir" || continue
    seg_main="$main_tree_out"
    if verdict_for "$gate_verb" "$seg_args" "$seg_dir"; then
      target_dir="$seg_dir"
      main_tree="$seg_main"
      blocked=1
      break
    fi
  done < <(gate_verb_args_dir "$cmd" "${hook_cwd:-$PWD}" "$gate_re")
  [ "$blocked" -eq 1 ] && break
done

[ "$blocked" -eq 1 ] || exit 0

# Compose the block message. This repo's lanes are `.worktrees/<name>` with a
# `wt-<name>` branch (NOT cdkd's `.claude/worktrees/<branch>`), and the base is
# `origin/main`: `stale-base-gate.sh` opens with
# `git merge-base --is-ancestor "$base" HEAD || exit 0`, so it is INERT for a
# lane cut from a stale LOCAL `main`. Basing on `origin/main` is what turns that
# gate on.
branch_slug=$(printf '%s' "${target_branch:-feature-branch}" | tr -c 'a-zA-Z0-9._/-' '-')
branch_out="wt-${branch_slug#wt-}"
# THE LANE DIRECTORY IS FLAT; the BRANCH keeps whatever slashes it came with.
# `wt-topic/nested` used to print `.worktrees/topic/nested`, a nested lane layout
# nothing else in this repo uses -- and `git worktree remove` on it then leaves an
# empty `.worktrees/topic/` behind. The branch name is what the reader asked for,
# so only the path is flattened.
dir_slug=$(printf '%s' "${branch_slug#wt-}" | tr '/' '-')
cat >&2 <<EOF
Blocked by main-tree-branch-gate: the target git working tree IS the main checkout, and the command $block_reason.

  resolved target dir: $target_dir
  command: $cmd

The main checkout at $main_tree is a SHARED RESOURCE across parallel lanes. Feature branches must live in their own worktree so concurrent sessions do not clobber each other's uncommitted work (CLAUDE.md, "ALWAYS develop in a git worktree" — this repo has been bitten twice).

Correct invocation:

  git worktree add .worktrees/${dir_slug} -b ${branch_out} origin/main
  mise trust .worktrees/${dir_slug}/.mise.toml
  cd .worktrees/${dir_slug}
  pnpm install
  # ... your work here ...

The main checkout must stay on \`main\` (or \`master\`). When done with the feature worktree:

  git worktree remove .worktrees/${dir_slug}

If the session is ALREADY inside a linked worktree, do NOT run \`git worktree add\` — it nests one worktree inside another. Work on the branch already checked out there (CLAUDE.md, go-to-k/cdk-real-drift#1842).

If you genuinely need to operate on a feature branch IN the main checkout (release surgery, history rewrite), the escape is to confirm with the user explicitly first — there is no flag to bypass this hook silently.
EOF

exit 2

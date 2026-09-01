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
if ! declare -F gate_matches >/dev/null 2>&1 \
  || ! declare -F gate_verb_args_dir >/dev/null 2>&1; then
  echo "Blocked: .claude/hooks/_command-match.sh loaded but gate_matches / gate_verb_args_dir is undefined (truncated or stale file?)." >&2
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
# One candidate DWIM branch name per line: the names `git checkout <name>` would
# CREATE a local branch for and switch to, because exactly one remote carries
# them. Two things it must get right, both measured against real git 2.53:
#
#   SYMREFS ARE NOT BRANCHES. `refs/remotes/<remote>/HEAD` exists in essentially
#     every clone (16 of this repo's own remote refs, one of them HEAD), and
#     `%(refname:lstrip=3)` renders it as the bare name `HEAD`. That made
#     `git checkout HEAD` a BLOCK reported as "creates a local branch tracking
#     remote 'HEAD'", while real git leaves HEAD exactly where it was — measured,
#     `before=main after=main`. `git branch HEAD` is refused by git itself
#     ("'HEAD' is not a valid branch name"), so dropping symrefs costs no real
#     candidate.
#
#   A REMOTE NAME MAY CONTAIN A SLASH, so a fixed `lstrip=3` is wrong. `git
#     remote add a/b <url>` is accepted — measured — and the branch `deep-only`
#     on it lands at `refs/remotes/a/b/deep-only`, which lstrips to `b/deep-only`
#     while git DWIMs plain `deep-only` ("Switched to a new branch 'deep-only'",
#     HEAD moved). A gate comparing against `b/deep-only` passes the switch. The
#     prefix is therefore stripped PER REMOTE, using the remote's own name, so it
#     is right whatever the name contains.
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
    # `IFS=$'\t' read` spelling is safe — git refuses a ref name containing any
    # ASCII control character, tab included, so neither field can hold a tab run
    # for `read` to fold. That is NOT true of the segment split further down,
    # which is why that one uses `${line%%<TAB>*}` instead.
    while IFS=$'\t' read -r refname symref; do
      [ -n "$refname" ] || continue
      [ -z "$symref" ] || continue
      printf '%s\n' "${refname#refs/remotes/$remote/}"
    done < <(git -C "$dir" for-each-ref \
      --format=$'%(refname)\t%(symref)' "refs/remotes/$remote/" 2>/dev/null)
  done < <(git -C "$dir" remote 2>/dev/null)
}

# verdict_for <verb> <args> <dir>
# 0 = this segment must be BLOCKED (with `target_branch` / `block_reason` set),
# 1 = allowed. <args> is everything after the matched verb, flags included,
# because the verb ERE already consumed the leading `git -C … ` flag run.
#
#   `git switch <main|master>`             -> allow
#   `git checkout <main|master>`           -> allow
#   `git switch -c|--create <branch>`      -> block
#   `git switch <other-branch>`            -> block
#   `git checkout -b|-B|--orphan <branch>` -> block
#   `git checkout -t <remote-ref>`         -> block (DWIM create + switch)
#   `git switch|checkout -` / `@{-1}`      -> block (the previous branch)
#   `git checkout <other-branch>`          -> block when it is the only
#                                            positional AND names a LOCAL branch
#                                            or a branch on some REMOTE
#   `git checkout [<tree-ish>] -- <paths>` -> allow (file restore)
#   `git checkout <tree-ish> <paths>`      -> allow (file restore, no `--`)
#   `git checkout -p|--ours|--theirs …`    -> allow (file restore, no positional
#                                            count involved)
#   `git checkout <sha>`                   -> allow (detached HEAD)
#   `git switch|checkout --help`           -> allow
#
# A TOKEN WALK, not "read token 1 and token 2". The two-token form ported from
# the siblings is wrong in BOTH directions -- three defects, each measured
# against real git before it was fixed here (the same probes run against the
# sibling gates score them identically wrong):
#
#   git checkout <branch> -- <paths>   was BLOCKED, and must not be: it restores
#     FILES and leaves HEAD on `main`. Measured — HEAD stayed `main`, f.txt took
#     the other branch's content. It is also the spelling CLAUDE.md MANDATES for
#     the orchestrator ("integrates by `git checkout <branch> -- <files>`, NEVER
#     `git merge`"), so the ported shape refuses this repo's own integration step.
#     `git checkout <branch> <paths>` without the `--` behaves identically, which
#     is why the rule is "two or more positionals is a restore", not "`--` seen".
#
#   git checkout -f <branch>           was ALLOWED, and must not be: `-f` was read
#     AS the branch name, `refs/heads/-f` does not resolve, and the gate passed.
#     Measured — it switched the tree to `feat`. Any flag before the branch does
#     this, so flags are SKIPPED rather than treated as the positional.
#
#   git checkout <name>  /  git checkout -t origin/<name>
#     ALLOWED by all three, and must not be. With no LOCAL `<name>` but a remote
#     carrying it, both CREATE the local branch and switch — measured on a real
#     clone: HEAD went `main` -> `feat`, "Switched to a new branch". That is how
#     a lane's branch usually FIRST appears in a checkout, so a local-only
#     `show-ref` was blind to the commonest spelling of the thing it guards.
#
# THE WALK PARSES FLAGS THE WAY GIT'S OWN parse-options DOES, and the first
# revision of it did not, which cost six LIVE FAIL-OPENS — every one of them a
# command that really moves HEAD, waved through by the gate whose whole job is to
# stop exactly that. Measured against the shipped hook with the payload cwd on a
# real main checkout, and every "want" settled first against real git with HEAD
# printed before and after:
#
#     git checkout -bfeat                          rc=0  want 2
#     git checkout -Bfeat                          rc=0  want 2
#     git checkout --orphan=feat                   rc=0  want 2
#     git checkout --conflict merge some-feature   rc=0  want 2
#     git checkout -                               rc=0  want 2
#     git checkout @{-1}                           rc=0  want 2
#     git checkout --track=direct origin/<b>       rc=0  want 2
#     git checkout -tdirect origin/<b>             rc=0  want 2
#
# Three causes, and the fix is to each cause rather than to the eight spellings:
#
#   GLUED VALUES. `-bfeat`, `-B feat` and `-fbfeat` are all "create branch feat"
#     to git — parse-options takes the remainder of a short cluster as the
#     option's value, and takes `--long=value`. Measured: `git checkout -fb clus`
#     and `git checkout -qbclus` both created `clus` and switched. So a short
#     token is walked CHARACTER BY CHARACTER and a long one is split at its first
#     `=`, instead of being matched against a list of exact spellings. The old
#     comment said a glued `--track=direct` "never reaches here", which was true
#     of the case arm and was the bug: unjudged means PASSED.
#
#   A POSITIONAL COUNT STANDING IN FOR A PARSE. `[ "$npos" -ne 1 ] && return 1`
#     reads any command with two leftover positionals as a file restore, so ONE
#     value-taking flag in front of the branch turned a switch into a restore:
#     `git checkout --conflict merge some-feature` really switches (measured,
#     HEAD `main` -> `some-feature`) and scored rc=0. Every REQUIRED-value flag
#     of both verbs is now consumed during the walk, taken from `git checkout -h`
#     / `git switch -h` rather than from memory: `-b` `-B` `-c` `-C` `--create`
#     `--force-create` `--orphan` `--conflict` `-U`/`--unified`
#     `--inter-hunk-context` `--pathspec-from-file`. `-t`/`--track` and
#     `--recurse-submodules` are OPTIONAL-value and consume NOTHING — measured,
#     `git checkout -t origin/remote-only` creates local `remote-only`, i.e. the
#     ref is a start-point POSITIONAL, not the flag's argument.
#
#   `-` AND `@{-1}` ARE THE PREVIOUS BRANCH UNDER BOTH VERBS. Only `switch` had
#     an arm, and the comment claimed both were "counted as a positional and
#     judged below" — under `checkout` that judging is `show-ref refs/heads/-`
#     plus a DWIM lookup, both of which miss, so it fell through to allow.
#     Measured with a real previous branch: `git checkout -`, `git checkout
#     @{-1}`, `git switch -` and `git switch @{-1}` all moved HEAD from `main` to
#     `some-feature`. With a `--` or a second positional the same token is a
#     tree-ish to restore FROM and HEAD stays (measured), so the block is
#     conditioned on it being the ONLY positional.
#
# `--detach` is asymmetric between the verbs, deliberately: `git switch --detach`
# blocks, `git checkout <sha>` (and `git checkout --detach <sha>` / `-d`) passes.
# THE REASON IS NOT "read-only inspection" — an earlier revision said that and it
# is false. Measured on a real checkout: `git checkout <sha>` REWRITES the shared
# working tree (a file present at `main` was gone from the directory afterwards)
# and leaves HEAD detached. The consequence chains, which is the part worth
# stating: `branch-gate.sh` decides with
# `git -C <dir> symbolic-ref --short HEAD`, which is EMPTY on a detached HEAD, so
# its `case` matches nothing and it exits 0 — measured, a `git commit` payload
# against that same main checkout scored rc=2 while on `main` and rc=0 while
# detached. So allowing the sha form does not merely permit a look around; it
# opens the commit gate behind it. It stays allowed because that is the ported
# behaviour and both siblings share it, and diverging silently on a verdict is
# worse than carrying a documented asymmetry — but the honest label is "an
# accepted hole", not "harmless".
verdict_for() {
  local verb="$1" rest="$2" dir="$3"
  local tok name glued has_glued cluster c pending=""
  local create_val="" create_flag="" detach_flag="" track_flag="" prev_ref=""
  local saw_help=0 saw_ddash=0 saw_restore=0
  local npos=0 first_pos=""
  target_branch=""
  block_reason=""
  while IFS= read -r tok; do
    tok=$(gate_unquote "$tok")
    if [ -n "$pending" ]; then
      # The awaited value of a REQUIRED-value flag. `create` keeps it (it names
      # the branch); `ignore` merely stops it being counted as a positional,
      # which is the whole of cause 2 above.
      [ "$pending" = create ] && create_val="$tok"
      pending=""
      continue
    fi
    case "$tok" in
      # Everything after `--` is a pathspec, never a branch. Under `checkout` the
      # token BEFORE it is then a tree-ish to restore FROM, not a switch target —
      # measured: `git checkout <branch> -- <paths>` leaves HEAD on `main`.
      # Remembered rather than just breaking, since the positional has already
      # been counted by then.
      --) saw_ddash=1; break ;;
      # `-` and `@{-N}` name the PREVIOUS branch under BOTH verbs.
      -|@{-*)
        prev_ref="$tok"
        npos=$((npos + 1))
        [ "$npos" -eq 1 ] && first_pos="$tok"
        ;;
      --*)
        name="${tok%%=*}"
        glued=""
        has_glued=0
        case "$tok" in *=*) glued="${tok#*=}"; has_glued=1 ;; esac
        case "$name" in
          --help) saw_help=1 ;;
          --create|--force-create)
            # `--create` / `--force-create` exist only under `switch`.
            if [ "$verb" = switch ]; then
              create_flag="$name"
              if [ "$has_glued" -eq 1 ]; then create_val="$glued"; else pending=create; fi
            fi
            ;;
          --orphan)
            create_flag="$name"
            if [ "$has_glued" -eq 1 ]; then create_val="$glued"; else pending=create; fi
            ;;
          --track)
            # OPTIONAL value (`--track=direct` / `--track=inherit`), so it never
            # consumes the next token; the ref that follows is a start-point
            # POSITIONAL and the branch git creates is that ref's last segment.
            track_flag="$name"
            ;;
          --detach)
            [ "$verb" = switch ] && detach_flag="$name"
            ;;
          --patch|--ours|--theirs|--pathspec-from-file)
            # File-restore markers. Real git refuses to combine `--ours` /
            # `--theirs` with a branch switch at all ("fatal: '--ours/--theirs'
            # cannot be used with switching branches") and `-p <branch>` prints a
            # hunk picker — measured, HEAD stayed on `main` for every one.
            saw_restore=1
            [ "$name" = --pathspec-from-file ] && [ "$has_glued" -eq 0 ] && pending=ignore
            ;;
          --conflict|--unified|--inter-hunk-context)
            # REQUIRED value. Left unconsumed it becomes a phantom positional and
            # the count below then reads a real switch as a restore — cause 2.
            [ "$has_glued" -eq 0 ] && pending=ignore
            ;;
          *) : ;;
        esac
        ;;
      -?*)
        # A SHORT CLUSTER, walked character by character exactly as git's
        # parse-options does: `-fbfeat` is `-f -b feat`, and the remainder after a
        # value-taking letter IS that letter's value.
        cluster="${tok#-}"
        while [ -n "$cluster" ]; do
          c="${cluster:0:1}"
          cluster="${cluster:1}"
          case "$verb:$c" in
            checkout:b|checkout:B|switch:c|switch:C)
              create_flag="-$c"
              if [ -n "$cluster" ]; then create_val="$cluster"; else pending=create; fi
              cluster=""
              ;;
            *:t)
              track_flag="-t"
              # Optional value, so anything glued after `t` is that value and
              # nothing further in the token is a flag.
              cluster=""
              ;;
            *:h) saw_help=1 ;;
            switch:d) detach_flag="-d" ;;
            checkout:p|checkout:2|checkout:3) saw_restore=1 ;;
            checkout:U)
              [ -n "$cluster" ] || pending=ignore
              cluster=""
              ;;
            *) : ;;
          esac
        done
        ;;
      *)
        npos=$((npos + 1))
        [ "$npos" -eq 1 ] && first_pos="$tok"
        ;;
    esac
  done < <(gate_tokens "$rest")

  [ "$saw_help" -eq 1 ] && return 1
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
  if [ -n "$track_flag" ] && [ "$saw_ddash" -eq 0 ] && [ "$saw_restore" -eq 0 ] \
    && [ "$npos" -eq 1 ]; then
    # `-t <remote-ref>` / `--track <remote-ref>`: git creates a LOCAL branch named
    # after the start point's LAST SEGMENT and switches to it — measured, HEAD
    # went `main` -> `remote-only` for `git checkout -t origin/remote-only`. The
    # `-z "$create_flag"` reading is the RETURN ORDER above rather than a guard
    # inside the walk, so `-b feat -t origin/x` and `-t origin/x -b feat` both
    # name `feat` (measured: git creates `feat` for both).
    target_branch="${first_pos##*/}"
    block_reason="creates new feature branch '$target_branch'"
    return 0
  fi
  if [ -n "$prev_ref" ] && [ "$saw_ddash" -eq 0 ] && [ "$saw_restore" -eq 0 ] \
    && [ "$npos" -eq 1 ]; then
    target_branch="$prev_ref"
    block_reason="switches to the previous branch (\`git $verb $prev_ref\`); the resolved name is not knowable from the command text — block conservatively"
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
          block_reason="runs \`git switch\` in the main checkout with no resolvable target — block conservatively"
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
      # A `--` makes everything a pathspec and the leading positional a tree-ish
      # to restore FROM: a file restore, whatever it names.
      [ "$saw_ddash" -eq 1 ] && return 1
      # `-p` / `--ours` / `--theirs` / `--pathspec-from-file` do the same without
      # a `--`, and they do it whatever the positional count is.
      [ "$saw_restore" -eq 1 ] && return 1
      # No positional: a bare `git checkout` is a NOP or a restore depending on
      # the git version. TWO OR MORE: `<tree-ish> <paths...>`, the same restore
      # without the `--` — measured, see the header.
      [ "$npos" -ne 1 ] && return 1
      case "$first_pos" in
        main|master) return 1 ;;
        *)
          # A branch name or a sha. A name resolving to a LOCAL branch is a
          # branch switch; so is one that resolves only on a REMOTE (the DWIM arm
          # below). A sha or a pathspec passes. Both questions are asked of the
          # SEGMENT's own tree, since that is where the command would run.
          if git -C "$dir" show-ref --verify --quiet "refs/heads/$first_pos" 2>/dev/null; then
            target_branch="$first_pos"
            block_reason="switches to feature branch '$first_pos'"
            return 0
          fi
          # DWIM. With no LOCAL `<name>` but exactly one remote carrying it,
          # `git checkout <name>` CREATES the local branch and switches to it --
          # measured on a real clone, HEAD went from `main` to `feat` with
          # "Switched to a new branch". A local-branch check alone therefore
          # passes the commonest way a lane's branch first appears in a fresh
          # checkout. `grep -qxF` is an exact whole-LINE match, so a name that is
          # merely a SUBSTRING of a remote branch does not false-block; see
          # `remote_dwim_names` for what the candidate list excludes and why.
          if remote_dwim_names "$dir" | grep -qxF -- "$first_pos"; then
            target_branch="$first_pos"
            block_reason="creates a local branch tracking remote '$first_pos' and switches to it"
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

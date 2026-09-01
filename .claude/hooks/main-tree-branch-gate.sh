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
#     <branch>`, `git switch --orphan <branch>`, `git switch -`,
#     `git switch --detach`, `git checkout -b|-B|--orphan <branch>`,
#     `git checkout -t <remote-ref>`, and `git checkout <not-main>` when
#     `<not-main>` is the only positional AND names either a LOCAL branch or a
#     branch on some REMOTE (git DWIMs the second into a create + switch). A
#     leading FLAG never counts as the branch name.
#   - Pass: `git switch main` / `master`, `git checkout main` / `master`,
#     `git checkout [<tree-ish>] -- <pathspec>` and `git checkout <tree-ish>
#     <pathspec>` (file restores — measured, HEAD stays put), `git checkout <sha>`
#     (detached HEAD), `--help`, `git worktree add ...` (the sanctioned path), and
#     everything in a LINKED worktree, which is where the convention wants feature
#     branches.
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
# Print the MAIN checkout's path when <dir> IS that checkout AND the repo opts
# into the convention; print nothing and return 1 otherwise. Called PER MATCHED
# SEGMENT — see the per-segment table in the header.
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
# at these sizes.
#
# LIMIT, stated rather than hidden. `gate_segments` FLATTENS a subshell, so a
# `cd` inside one leaks past the closing paren and steers every later segment:
#
#   (cd <worktree> && git switch -c a) && git switch -c b
#
# resolves segment 3 to the worktree and PASSES. Closing it means teaching the
# shared segmenter to report subshell depth, which is a change to every gate that
# calls it, not to this one. The exposure is one-directional: a leaked `cd` can
# only ever make the gate quieter, never make it false-block.
_mt_memo_dir=""
_mt_memo_val=""
main_tree_of() {
  local dir="$1" mt
  if [ "$dir" = "$_mt_memo_dir" ]; then
    [ -n "$_mt_memo_val" ] || return 1
    printf '%s' "$_mt_memo_val"
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
  printf '%s' "$mt"
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
#   `git checkout <other-branch>`          -> block when it is the only
#                                            positional AND names a LOCAL branch
#                                            or a branch on some REMOTE
#   `git checkout [<tree-ish>] -- <paths>` -> allow (file restore)
#   `git checkout <tree-ish> <paths>`      -> allow (file restore, no `--`)
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
# `--detach` is asymmetric between the verbs, deliberately: `git switch --detach`
# blocks, `git checkout <sha>` (and `git checkout --detach <sha>`) passes. Both
# move the shared tree off `main`, so this is not principled — it is the ported
# behaviour, and `git checkout <sha>` has to stay allowed for read-only
# inspection. Left as-is rather than silently diverging from both siblings.
verdict_for() {
  local verb="$1" rest="$2" dir="$3"
  local tok pending="" create_val="" create_flag="" detach_flag="" saw_help=0 saw_ddash=0
  local npos=0 first_pos=""
  target_branch=""
  block_reason=""
  while IFS= read -r tok; do
    tok=$(gate_unquote "$tok")
    if [ -n "$pending" ]; then
      # `basename` is `--track`'s mode: its value is a REMOTE ref
      # (`origin/feat`) and the branch git creates is that ref's last segment.
      if [ "$pending" = basename ]; then create_val="${tok##*/}"; else create_val="$tok"; fi
      pending=""
      continue
    fi
    case "$tok" in
      --help|-h) saw_help=1 ;;
      # Everything after `--` is a pathspec, never a branch. Under `checkout`
      # the token BEFORE it is then a tree-ish to restore FROM, not a switch
      # target — measured: `git checkout <branch> -- <paths>` leaves HEAD on
      # `main`. Remembered rather than just breaking, since the positional has
      # already been counted by then.
      --) saw_ddash=1; break ;;
      -c|-C|--create|--force-create)
        # `-C` is force-create under `switch`; under `checkout` it is not a flag
        # at all (the leading `git -C <path>` run was already consumed by the
        # verb ERE), so it can only appear here as switch's.
        [ "$verb" = switch ] && { create_flag="$tok"; pending=value; }
        ;;
      -b|-B)
        [ "$verb" = checkout ] && { create_flag="$tok"; pending=value; }
        ;;
      --orphan)
        create_flag="$tok"; pending=value
        ;;
      -t|--track)
        # `git checkout -t origin/feat` CREATES a local `feat` and switches to
        # it — measured, HEAD went from `main` to `feat`. All three
        # implementations passed it, because `-t` was read as the branch name
        # and `refs/heads/-t` does not resolve. `-b` / `--orphan` win when both
        # are present, since they name the branch outright; a `--track=direct`
        # spelling is glued and never reaches here.
        [ -z "$create_flag" ] && { create_flag="$tok"; pending=basename; }
        ;;
      -d|--detach)
        # `-d` is switch's short `--detach`; `checkout` has no `-d`.
        [ "$verb" = switch ] && detach_flag="$tok"
        ;;
      -)
        # `git switch -` / `git checkout -` = the previous branch, which cannot
        # be known without running git. Counted as a positional and judged below.
        npos=$((npos + 1))
        [ "$npos" -eq 1 ] && first_pos="-"
        ;;
      -*)
        # Any other flag. Its VALUE, if it takes one, falls through as a
        # positional; that only ever makes a `checkout` look like a restore
        # (allow) or fails `show-ref` (allow), never the reverse.
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

  case "$verb" in
    switch)
      case "$first_pos" in
        main|master) return 1 ;;
        -)
          target_branch="-"
          block_reason="switches to previous branch (\`git switch -\`); resolved branch unknown — block conservatively"
          return 0
          ;;
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
          # checkout.
          #
          # The pattern is the PREFIX `refs/remotes/`, not `refs/remotes/*/*`. In
          # `for-each-ref` a `*` does NOT cross a `/`, so the two-star form lists
          # `origin/feat` and MISSES `origin/topic/nested` -- measured, and git
          # DWIMs the nested name just the same ("Switched to a new branch
          # 'topic/nested'"). The first revision of this arm had the two-star
          # form and was fail-open for every slashed branch name, which is most
          # of them in this flow. `lstrip=3` drops `refs/remotes/<remote>/` and
          # keeps the rest whole; `grep -qxF` is an exact whole-LINE match, so a
          # name that is merely a SUBSTRING of a remote branch does not
          # false-block.
          if git -C "$dir" for-each-ref --format='%(refname:lstrip=3)' 'refs/remotes/' 2>/dev/null \
            | grep -qxF -- "$first_pos"; then
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
    seg_dir="${seg_line%%	*}"
    seg_args="${seg_line#*	}"
    seg_main=$(main_tree_of "$seg_dir") || continue
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
dir_slug="${branch_slug#wt-}"
branch_out="wt-$dir_slug"
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

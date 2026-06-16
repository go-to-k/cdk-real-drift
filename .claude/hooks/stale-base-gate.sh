#!/usr/bin/env bash
# stale-base-gate.sh
#
# PreToolUse hook. Blocks `git push` of a feature branch when the branch
# sits ON TOP of the current `origin/main` (origin/main is an ancestor of
# HEAD) yet its net diff REVERTS one or more files that recent `origin/main`
# commits changed. This is the exact "stale-base soft-reset clobber"
# foot-gun that has bitten this repo's worktree flow twice:
#
#   A worktree branch is based on main@T0. While it works, a parallel
#   session merges PR #X, advancing main to T1. The author then runs
#   `git reset --soft origin/main` (or --hard with a stale working tree) to
#   "rebase", which moves HEAD onto T1 but keeps the OLD T0 tree — so the
#   resulting commit, diffed against its T1 parent, DELETES/REVERTS every
#   file #X just added. Pushing + merging that branch silently rolls #X
#   back. (See memory rule worktree-stale-base-diff.)
#
# Detection (precise, fail-open): only fires when origin/main is already an
# ancestor of HEAD (the branch CLAIMS to be current). For each path in the
# branch's net diff vs origin/main, if HEAD's blob for that path matches an
# EARLIER origin/main state (origin/main~1..~N) while differing from the
# current origin/main tip — i.e. HEAD carries a PAST version of a file main
# has since moved on from — that path is being reverted by staleness, not by
# intent. Any such path blocks the push. A branch that genuinely builds on
# top of current main (adds/edits files main has NOT touched) is never
# flagged. Every git failure falls through to `exit 0` (we never block what
# we cannot prove).
#
# cwd resolution mirrors branch-gate.sh (payload .cwd + leading `cd <path>`
# + last `git -C <path>`), because this repo is worked via `git worktree`.

set -u

input=$(cat 2>/dev/null || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `git push` (subcommand position, line-start anchored — same shape
# as branch-gate.sh so quoted "git push" substrings don't false-positive).
if ! printf '%s' "$cmd" | grep -qE '^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?git([[:space:]]+(-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?))*[[:space:]]+push([[:space:]]|$|[|;&`)])'; then
  exit 0
fi

# Resolve where the git command actually runs.
target_dir="${hook_cwd:-$PWD}"
if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  [[ "$cd_target" != /* ]] && cd_target="$target_dir/$cd_target"
  target_dir="$cd_target"
fi
if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
  c_target=""; remaining="$cmd"
  while [[ "$remaining" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; do
    c_target="${BASH_REMATCH[1]}"
    remaining="${remaining#*"${BASH_REMATCH[0]}"}"
  done
  c_target="${c_target%\"}"; c_target="${c_target#\"}"
  c_target="${c_target%\'}"; c_target="${c_target#\'}"
  [[ "$c_target" != /* ]] && c_target="$target_dir/$c_target"
  target_dir="$c_target"
fi

g() { git -C "$target_dir" "$@" 2>/dev/null; }

# Must be a git repo we can read.
g rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Base ref: prefer the remote-tracking origin/main; fall back to local main.
base=""
for ref in origin/main origin/master main master; do
  if g rev-parse --verify --quiet "$ref" >/dev/null; then base="$ref"; break; fi
done
[ -n "$base" ] || exit 0

head_sha=$(g rev-parse HEAD) || exit 0
base_sha=$(g rev-parse "$base") || exit 0
[ "$head_sha" = "$base_sha" ] && exit 0  # pushing the base itself — not our concern

# Only the soft-reset clobber shape: base is ALREADY an ancestor of HEAD, so
# the branch claims to be current. A branch merely BEHIND base is the normal
# worktree case (three-way merge keeps base's commits) — never flagged here.
g merge-base --is-ancestor "$base" HEAD || exit 0

# Files in the branch's net diff vs the base tip.
net=$(g diff --name-only "$base" HEAD) || exit 0
[ -n "$net" ] || exit 0

# Blob of a path at a ref ("" if absent at that ref).
blob_at() { g rev-parse "$1:$2" 2>/dev/null || echo ""; }

clobbered=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  head_blob=$(blob_at HEAD "$path")
  base_blob=$(blob_at "$base" "$path")
  # If HEAD carries a PAST origin/main version of this path (matches base~k
  # for some recent k) while differing from the current base tip, the branch
  # is reverting main's history by staleness, not intent.
  for k in 1 2 3 4 5; do
    past_blob=$(blob_at "${base}~${k}" "$path")
    [ -n "$past_blob" ] || continue
    if [ "$head_blob" = "$past_blob" ] && [ "$past_blob" != "$base_blob" ]; then
      clobbered="${clobbered}  - ${path} (HEAD == ${base}~${k}, but ${base} has moved on)"$'\n'
      break
    fi
  done
done <<< "$net"

[ -n "$clobbered" ] || exit 0

{
  echo "Blocked by stale-base-gate: this push would REVERT recent '${base}' work."
  echo
  echo "  resolved target dir: $target_dir"
  echo "  HEAD sits on top of ${base}, but these paths carry an OLDER ${base}"
  echo "  version than the current tip — the stale-base soft-reset clobber:"
  echo
  printf '%s' "$clobbered"
  echo
  echo "Your branch likely did 'git reset --soft/--hard ${base}' with a stale"
  echo "working tree after ${base} advanced. Pushing + merging it would roll"
  echo "those commits back. Recover with:"
  echo "  git -C \"$target_dir\" reset --hard ${base}   # take current ${base}"
  echo "  # then re-apply ONLY your intended changes and re-commit."
  echo "If the reversion is truly intended, push from a branch whose history"
  echo "does not embed ${base} as a parent (so the intent is explicit)."
} >&2
exit 2

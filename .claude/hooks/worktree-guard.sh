#!/usr/bin/env bash
# worktree-guard.sh
#
# PreToolUse hook (Edit / Write / NotebookEdit). Blocks an edit to the MAIN
# checkout's `src/**` or `tests/**` while a development worktree exists under
# `.worktrees/`. Per CLAUDE.md the main checkout is reserved for integration
# (`git checkout <branch> -- <files>` / pulls / PR plumbing) — all real work
# happens in a per-line-of-work worktree.
#
# Editing main directly while a worktree is active has repeatedly caused
# cross-session collisions: a session edits main's src, then a `cp`-recovery of
# those files into its worktree pulls ANOTHER session's freshly-MERGED work into
# its branch (the #408 contamination), and a `git checkout` in main can clobber a
# parallel session's staged work. This hook makes that foot-gun unreachable.
#
# Fail-OPEN by design: any ambiguity (no path, not absolute, no git context,
# parse error, only the main worktree exists) passes through — the hook only
# blocks the one unambiguous foot-gun.

set -u

input=$(cat 2>/dev/null || true)

# Edit/Write carry .tool_input.file_path; NotebookEdit carries .notebook_path.
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null || echo "")
[ -n "$path" ] || exit 0

# Only reason about absolute paths (Edit/Write require them).
case "$path" in
  /*) ;;
  *) exit 0 ;;
esac

# An edit INSIDE a worktree is the CORRECT place — always allow.
case "$path" in
  */.worktrees/*) exit 0 ;;
esac

# Resolve a git context from the nearest existing ancestor of the target (the
# file itself may not exist yet for a Write of a new file / new dir).
probe="$path"
while [ ! -d "$probe" ] && [ "$probe" != "/" ]; do
  probe=$(dirname "$probe")
done
git -C "$probe" rev-parse --git-dir >/dev/null 2>&1 || exit 0

# The MAIN checkout root is the FIRST worktree git lists (the primary worktree),
# and the worktree list is shared, so this is correct even from inside a worktree.
main_root=$(git -C "$probe" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')
[ -n "$main_root" ] || exit 0

# No collision risk unless at least one OTHER worktree exists.
wt_count=$(git -C "$probe" worktree list --porcelain 2>/dev/null | grep -c '^worktree ')
[ "${wt_count:-0}" -ge 2 ] || exit 0

# Canonicalize (resolve symlinks) so a /tmp -> /private/tmp style alias does not
# defeat the prefix match. The target file may not exist yet, so canonicalize its
# nearest existing ancestor (probe) and re-attach the remainder.
canon() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"; }
canon_main=$(canon "$main_root")
canon_probe=$(canon "$probe")
rest="${path#"$probe"}" # the part of the path below the existing ancestor
canon_path="${canon_probe}${rest}"

# Only guard the MAIN checkout's src/ and tests/ (where the foot-gun bites and
# where a code/test collision actually matters).
case "$canon_path" in
  "$canon_main"/src/*|"$canon_main"/tests/*) ;;
  *) exit 0 ;;
esac

rel="${canon_path#"$canon_main"/}"
others=$((wt_count - 1))
echo "Blocked by worktree-guard: editing the MAIN checkout ($rel) while ${others} worktree(s) exist under .worktrees/. Per CLAUDE.md, all src/** and tests/** work belongs in a worktree — the path must contain .worktrees/<name>. Editing main directly has caused cross-session collisions (e.g. a cp-recovery pulling another session's merged PR into your branch). Edit the file under .worktrees/<name>/ instead; the main checkout is for integration only (git checkout / pulls / PR plumbing)." >&2
exit 2

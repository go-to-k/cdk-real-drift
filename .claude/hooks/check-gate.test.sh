#!/usr/bin/env bash
# Smoke test for check-gate.sh.
#
# Stubs the markgate resolution (`mise exec -- markgate verify <gate>` and the
# bare `markgate` fallback) so the marker verdicts are controlled, then asserts
# the BLOCK (exit 2) vs ALLOW (exit 0) outcomes: which command spellings are
# gated at all, which working tree the verdict is read from, and the fail-open
# paths. Run from the repo root:
#   bash .claude/hooks/check-gate.test.sh
#
# Why a shell script (not vitest): the hook IS a shell script; its contract is
# the stdin JSON payload + exit code. A TS wrapper would test the wrapper.
#
# Written 2026-08-20 (go-to-k/cdk-real-drift#1797): `tests/skill-doc-paths.test.ts`
# enumerated `.claude/hooks/*.test.sh` and asserted a COUNT, so it measured the
# harnesses that exist rather than the hooks that owe one — and check-gate, the
# hook every commit passes through, was the one with no harness at all.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

repo="$TMPDIR/repo"
git init -q -b main "$repo"
git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

notrepo="$TMPDIR/plain"
mkdir -p "$notrepo"

# `mise exec -- markgate verify <gate>` exits with the per-gate mock rc.
SHIM_DIR="$TMPDIR/bin"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/mise" <<'MISE_EOF'
#!/usr/bin/env bash
# mise exec -- markgate verify <gate>
gate="${!#}"
case "$gate" in
  check) exit "${MARKGATE_CHECK_RC:-0}" ;;
  docs) exit "${MARKGATE_DOCS_RC:-0}" ;;
esac
exit 0
MISE_EOF
cat > "$SHIM_DIR/markgate" <<'MG_EOF'
#!/usr/bin/env bash
# markgate verify <gate>  (the PATH fallback when mise is absent)
gate="${!#}"
case "$gate" in
  check) exit "${MARKGATE_CHECK_RC:-0}" ;;
  docs) exit "${MARKGATE_DOCS_RC:-0}" ;;
esac
exit 0
MG_EOF
chmod +x "$SHIM_DIR/mise" "$SHIM_DIR/markgate"

# A PATH holding neither mise nor markgate, for the not-installed case.
BARE_DIR="$TMPDIR/bare"
mkdir -p "$BARE_DIR"
for tool in bash git jq sed awk grep cat dirname printf; do
  target=$(command -v "$tool" 2>/dev/null) && ln -sf "$target" "$BARE_DIR/$tool"
done

pass=0; fail=0

# run_case <name> <expect_exit> <command> <cwd> [PATH_DIR] [check_rc] [docs_rc]
run_case() {
  local name="$1" want="$2" command="$3" cwd="$4"
  local path_dir="${5:-$SHIM_DIR}" check_rc="${6:-0}" docs_rc="${7:-0}"
  local payload got out
  payload=$(printf '{"cwd":"%s","tool_input":{"command":"%s"}}' "$cwd" "$command")
  out=$(printf '%s' "$payload" | env PATH="$path_dir:/usr/bin:/bin" \
    MARKGATE_CHECK_RC="$check_rc" MARKGATE_DOCS_RC="$docs_rc" "$HOOK" 2>&1)
  got=$?
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1)); printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    printf 'FAIL %s (want %s, got %s)\n  out: %s\n' "$name" "$want" "$got" "$out"
  fi
}

# --- which commands are gated at all -----------------------------------------
# Stale markers everywhere below, so an ALLOW means the hook never looked.
run_case "non-commit command passes through" 0 "git status" "$repo" "$SHIM_DIR" 1 1
run_case "git commit is gated" 2 "git commit -m x" "$repo" "$SHIM_DIR" 1 1
run_case "git -C <path> commit is gated" 2 "git -C $repo commit -m x" "$repo" "$SHIM_DIR" 1 1
run_case "cd <path> && git commit is gated" 2 "cd $repo && git commit -m x" "$repo" "$SHIM_DIR" 1 1
run_case "git -c k=v commit is gated" 2 "git -c user.name=t commit -m x" "$repo" "$SHIM_DIR" 1 1
# The spellings go-to-k/cdk-real-drift#1803 measured running UNGATED against the
# old line-start anchor. Each must now be gated.
run_case "git add -A && git commit is gated" 2 "git add -A && git commit -m x" "$repo" "$SHIM_DIR" 1 1
run_case "cd <path>; git commit is gated" 2 "cd $repo; git commit -m x" "$repo" "$SHIM_DIR" 1 1
run_case "subshell is gated" 2 "(cd $repo && git commit -m x)" "$repo" "$SHIM_DIR" 1 1
run_case "leading env assignment is gated" 2 "GIT_EDITOR=true git commit -m x" "$repo" "$SHIM_DIR" 1 1
# A quoted mention is still not an invocation: quoted spans are blanked before
# the command list is split.
run_case "quoted mention is not gated" 0 "echo \\\"run git commit next\\\"" "$repo" "$SHIM_DIR" 1 1

# --- the verdict is read from the resolved working tree ----------------------
run_case "both markers fresh allows the commit" 0 "git commit -m x" "$repo" "$SHIM_DIR" 0 0
run_case "stale check marker blocks" 2 "git commit -m x" "$repo" "$SHIM_DIR" 1 0
run_case "stale docs marker blocks" 2 "git commit -m x" "$repo" "$SHIM_DIR" 0 1
run_case "cd <path> reads the target tree, not cwd" 2 "cd $repo && git commit -m x" \
  "$notrepo" "$SHIM_DIR" 1 1

# --- fail-open / fail-loud paths ---------------------------------------------
run_case "non-git target fails open" 0 "git commit -m x" "$notrepo" "$SHIM_DIR" 1 1
run_case "cd to a non-git path fails open" 0 "cd $notrepo && git commit -m x" \
  "$repo" "$SHIM_DIR" 1 1
run_case "missing markgate fails LOUD" 2 "git commit -m x" "$repo" "$BARE_DIR" 0 0

# --- the messages name the skill to re-run -----------------------------------
msg=$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$repo" |
  env PATH="$SHIM_DIR:/usr/bin:/bin" MARKGATE_CHECK_RC=1 MARKGATE_DOCS_RC=1 "$HOOK" 2>&1)
for needle in "/check" "/check-docs"; do
  if printf '%s' "$msg" | grep -qF -- "$needle"; then
    pass=$((pass + 1)); printf 'OK   block message names %s\n' "$needle"
  else
    fail=$((fail + 1)); printf 'FAIL block message omits %s\n  out: %s\n' "$needle" "$msg"
  fi
done

printf '\npass: %s  fail: %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

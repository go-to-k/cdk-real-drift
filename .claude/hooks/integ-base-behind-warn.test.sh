#!/usr/bin/env bash
# Smoke tests for integ-base-behind-warn.sh
#
# The hook is NON-BLOCKING: it exits 0 on every input, so the exit code cannot
# tell a warning from silence. Every case therefore asserts the STDERR TEXT as
# well, and the "must stay silent" cases assert stderr is EMPTY -- an
# exit-code-only suite would be green with the whole hook deleted.
#
# Covered:
#   - WARNS when the branch is behind origin/main, on each documented fixture
#     invocation shape (`bash verify.sh`, a path-qualified script, the
#     `cd <fixture> && npm install && bash verify-*.sh` chain, `npx cdk deploy`)
#   - the two message ARMS: in-scope files (src/** or tests/integration/**)
#     arriving with the advance vs. none
#   - SILENT when up to date, when ahead, when there is no origin/main, in a
#     repo that never opted in, and for a non-Bash tool
#   - SILENT for READING a fixture (`cat` / `git diff` / `sed -n` in command
#     position anywhere), which is what stops a warn hook training people to
#     ignore it
#   - SILENT for this repo's own hook harnesses -- `verify-pr-gate.test.sh`
#     contains `verify` and ends in `.sh`, and warning on `vp run test:hooks`
#     would be pure noise
#
# NOT the same subject as stale-base-gate.test.sh: that gate BLOCKS a push whose
# branch is AHEAD of origin/main yet reverts main's work. This one warns when
# the branch is BEHIND. The two conditions are mutually exclusive.
#
# MEASURED, not asserted. Baseline 31/0 under /bin/bash 3.2.57 (identical under
# 5.3.9); every fence mutation-probed against THIS suite:
#
#   stub: always silent                             13 red
#   stub: always warn (carrying every needle)       18 red
#   read-verb exclusion removed                      7 red
#   fixture / deploy arming regex removed            5 red
#   behind-count guard removed                       2 red
#   in-scope file count removed (always 0)           2 red
#   `.test.sh` fence removed (dots allowed in stem)  1 red
#   repo opt-in guard removed                        1 red
#
# The opt-in probe was VACUOUS at first (31/0 with the guard deleted): the
# no-opt-in clone was level with origin/main, so the behind-count guard exited
# before the opt-in check was ever reached. It is now behind on purpose -- see
# the fixture comment.
#
# Run in place, from `.claude/hooks/`.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/integ-base-behind-warn.sh"
PASS=0
FAIL=0

TMPBASE="$(cd "$(mktemp -d)" && pwd -P)"

# --- BASH 3.2 FENCE ---
# See main-tree-branch-gate.test.sh for the full derivation. A shim directory
# holding one symlink named `bash` goes FIRST on PATH, so the hook's
# `#!/usr/bin/env bash` shebang resolves to the fenced interpreter. The fence
# only catches PARSE-time constructs (`mapfile`, `${x^^}`); a `declare -A` is
# invisible to it.
SHIMDIR="$TMPBASE/bash-shim"
mkdir -p "$SHIMDIR"
trap 'rm -rf "$TMPBASE"' EXIT
if [ -n "${HOOK_BASH:-}" ]; then
  if [ ! -x "$HOOK_BASH" ]; then
    printf 'FATAL - HOOK_BASH is not an executable: %s\n' "$HOOK_BASH" >&2
    exit 2
  fi
else
  HOOK_BASH=/bin/bash
  [ -x "$HOOK_BASH" ] || HOOK_BASH="$(command -v bash)"
  [ -n "$HOOK_BASH" ] && [ -x "$HOOK_BASH" ] || {
    printf 'FATAL - no usable bash found for the hook interpreter\n' >&2
    exit 2
  }
fi
ln -sf "$HOOK_BASH" "$SHIMDIR/bash"
PATH="$SHIMDIR:$PATH"
export PATH
printf 'hook interpreter: %s (bash %s)\n' "$HOOK_BASH" \
  "$("$HOOK_BASH" -c 'echo "$BASH_VERSION"')"

GIT="git -c user.email=t@t -c user.name=t"

# --- fixtures ---------------------------------------------------------------
# A real origin + clone, because the hook reads `origin/main` and
# `HEAD...origin/main`; mocking git would test nothing. Three lanes:
#
#   $BEHIND_SRC  branch behind origin/main, the advance touching src/**
#   $BEHIND_DOC  branch behind origin/main, the advance touching docs only
#   $CURRENT     branch level with origin/main
#   $AHEAD       branch ahead of origin/main
#   $NOOPTIN     behind, but no `.markgate.yml` at the root
#   $NOREMOTE    no origin/main ref at all
ORIGIN="$TMPBASE/origin.git"
SEED="$TMPBASE/seed"
mkdir -p "$SEED"
$GIT init -q -b main "$SEED"
mkdir -p "$SEED/src" "$SEED/docs" "$SEED/tests/integration/basic"
printf 'seed\n' > "$SEED/src/index.ts"
printf 'gates: {}\n' > "$SEED/.markgate.yml"
$GIT -C "$SEED" add -A >/dev/null
$GIT -C "$SEED" commit -q -m seed
$GIT init -q --bare -b main "$ORIGIN"
$GIT -C "$SEED" remote add origin "$ORIGIN"
$GIT -C "$SEED" push -q origin main

make_clone() { # <dir>
  $GIT clone -q "$ORIGIN" "$1" 2>/dev/null
  $GIT -C "$1" checkout -q -b wt-lane origin/main
}

advance_origin() { # <relative path to touch> <content>
  printf '%s\n' "$2" >> "$SEED/$1"
  $GIT -C "$SEED" add -A >/dev/null
  $GIT -C "$SEED" commit -q -m "advance $1"
  $GIT -C "$SEED" push -q origin main
}

BEHIND_SRC="$TMPBASE/behind-src"
make_clone "$BEHIND_SRC"
advance_origin "src/index.ts" "advance one"
advance_origin "tests/integration/basic/verify.sh" "echo hi"
$GIT -C "$BEHIND_SRC" fetch -q origin

BEHIND_DOC="$TMPBASE/behind-doc"
make_clone "$BEHIND_DOC"
advance_origin "docs/faq.md" "a doc line"
$GIT -C "$BEHIND_DOC" fetch -q origin

CURRENT="$TMPBASE/current"
make_clone "$CURRENT"

AHEAD="$TMPBASE/ahead"
make_clone "$AHEAD"
printf 'local\n' >> "$AHEAD/src/index.ts"
$GIT -C "$AHEAD" add -A >/dev/null
$GIT -C "$AHEAD" commit -q -m "local work"

# The opt-in lane must ALSO be behind, or the case is vacuous: the behind-count
# guard would exit first and removing the opt-in check would change nothing.
# Measured -- with this clone level with origin/main, a probe deleting the
# `.markgate.yml` guard left the suite at 31/0.
NOOPTIN="$TMPBASE/no-optin"
make_clone "$NOOPTIN"
rm -f "$NOOPTIN/.markgate.yml"
advance_origin "src/index.ts" "advance after the no-optin clone"
$GIT -C "$NOOPTIN" fetch -q origin

NOREMOTE="$TMPBASE/no-remote"
mkdir -p "$NOREMOTE"
$GIT init -q -b main "$NOREMOTE"
printf 'gates: {}\n' > "$NOREMOTE/.markgate.yml"
$GIT -C "$NOREMOTE" add -A >/dev/null
$GIT -C "$NOREMOTE" commit -q -m seed

drive() { # <command> <cwd> -> prints "<rc>|<stderr>"
  local payload out rc
  payload=$(jq -n --arg c "$1" --arg d "$2" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1 >/dev/null) && rc=0 || rc=$?
  printf '%s|%s' "$rc" "$out"
}

# warns <name> <command> <cwd> <substring stderr must carry>
warns() {
  local name="$1" res rc out
  res=$(drive "$2" "$3")
  rc="${res%%|*}"
  out="${res#*|}"
  # rc is asserted at 0 in EVERY case: this hook must never block.
  if [ "$rc" = "0" ] && printf '%s' "$out" | grep -qF "$4"; then
    echo "PASS: $name (warned, exit 0)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected 0 with stderr carrying '$4')"
    printf '%s\n' "$out" | sed 's/^/      /' | head -4
    FAIL=$((FAIL + 1))
  fi
}

# silent <name> <command> <cwd>
silent() {
  local name="$1" res rc out
  res=$(drive "$2" "$3")
  rc="${res%%|*}"
  out="${res#*|}"
  if [ "$rc" = "0" ] && [ -z "$out" ]; then
    echo "PASS: $name (silent, exit 0)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected 0 with EMPTY stderr)"
    printf '%s\n' "$out" | sed 's/^/      /' | head -4
    FAIL=$((FAIL + 1))
  fi
}

# --- ARMING: every documented invocation shape -------------------------------
# tests/integration/README.md and each fixture's `# Usage:` header.
warns "bash verify.sh"                     "bash verify.sh"                                   "$BEHIND_SRC" "commit(s) behind origin/main"
warns "bash <path>/verify.sh"              "bash tests/integration/basic/verify.sh"           "$BEHIND_SRC" "commit(s) behind origin/main"
warns "the documented cd + npm install chain" \
  "cd tests/integration/basic && npm install && bash verify.sh"                               "$BEHIND_SRC" "commit(s) behind origin/main"
warns "a sibling verify-<x>.sh script"     "cd basic && bash verify-mutation-matrix.sh"       "$BEHIND_SRC" "commit(s) behind origin/main"
warns "verify-harvest12.sh (digits in the stem)" "bash verify-harvest12.sh"                   "$BEHIND_SRC" "commit(s) behind origin/main"
warns "npx cdk deploy"                     "npx cdk deploy -f CdkRealDriftIntegBasic --require-approval never" "$BEHIND_SRC" "commit(s) behind origin/main"
warns "bare cdk deploy"                    "cdk deploy -f X"                                  "$BEHIND_SRC" "commit(s) behind origin/main"
warns "cdk deploy after a chain"           "cd tests/integration/basic && npx cdk deploy -f X" "$BEHIND_SRC" "commit(s) behind origin/main"

# --- THE TWO MESSAGE ARMS ----------------------------------------------------
warns "in-scope arm names src/** or tests/integration/**" \
  "bash verify.sh" "$BEHIND_SRC" "in-scope file(s) arrive with them"
warns "in-scope arm counts FILES, not commits" \
  "bash verify.sh" "$BEHIND_SRC" "2 in-scope file(s)"
warns "out-of-scope arm when only docs advanced" \
  "bash verify.sh" "$BEHIND_DOC" "None of them touch src/** or tests/integration/**"
warns "the message names the local integ gate, not a sibling's" \
  "bash verify.sh" "$BEHIND_SRC" "\`integ\` gate in .markgate.yml"
warns "the message says the local integ gate is currently inert" \
  "bash verify.sh" "$BEHIND_SRC" "currently INERT here"

# --- SILENCE: the branch is not behind ---------------------------------------
silent "level with origin/main" "bash verify.sh"                     "$CURRENT"
silent "ahead of origin/main"   "bash verify.sh"                     "$AHEAD"
silent "no origin/main ref"     "bash verify.sh"                     "$NOREMOTE"
silent "no .markgate.yml opt-in" "bash verify.sh"                    "$NOOPTIN"

# --- SILENCE: reading a fixture is not running one ---------------------------
silent "cat a fixture script"        "cat tests/integration/basic/verify.sh"            "$BEHIND_SRC"
silent "git diff a fixture script"   "git diff tests/integration/basic/verify.sh"       "$BEHIND_SRC"
silent "git log a fixture script"    "git log --oneline -- tests/integration/basic/verify.sh" "$BEHIND_SRC"
silent "grep inside a fixture"       "grep -n cdk tests/integration/basic/verify.sh"    "$BEHIND_SRC"
silent "sed -n after a cd"           "cd x && sed -n 1,5p tests/integration/basic/verify.sh" "$BEHIND_SRC"
silent "cat after a cd"              "cd x && cat tests/integration/basic/verify.sh"    "$BEHIND_SRC"
silent "ls the fixture dir"          "ls tests/integration/basic/verify.sh"             "$BEHIND_SRC"

# --- SILENCE: this repo's own tooling ----------------------------------------
# The `.test.sh` fence. `verify-pr-gate.test.sh` starts with `verify` and ends
# in `.sh`; a stem-with-dots needle would warn on every `vp run test:hooks`.
silent "the repo's own verify-pr-gate harness" \
  "bash .claude/hooks/verify-pr-gate.test.sh"                                            "$BEHIND_SRC"
silent "the hook-suite runner"       "bash scripts/run-hook-tests.sh"                    "$BEHIND_SRC"
silent "vp run test:hooks"           "vp run test:hooks"                                 "$BEHIND_SRC"
silent "vp run build"                "vp run build"                                      "$BEHIND_SRC"
silent "a read-only CLI verb"        "node dist/cli.js check MyStack --region us-east-1" "$BEHIND_SRC"

# --- INERT INPUTS -------------------------------------------------------------
silent "empty command" "" "$BEHIND_SRC"
if out=$(jq -n '{tool_name:"Edit", tool_input:{file_path:"x"}}' | "$HOOK" 2>&1 >/dev/null) && [ -z "$out" ]; then
  echo "PASS: non-Bash tool (silent, exit 0)"
  PASS=$((PASS + 1))
else
  echo "FAIL: non-Bash tool did not stay silent"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" -eq 0 ]

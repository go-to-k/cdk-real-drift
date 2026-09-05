#!/usr/bin/env bash
# Smoke tests for issue-deferral-criteria-gate.sh
#
# The gate blocks `gh issue create` (and the REST mint) when the body's
# `Session-fit: next` line defers the work for a PR-SHAPED reason. Asserts, in
# both directions:
#   - BLOCK for each term in the vocabulary, through every body channel the
#     filing flow uses (--body, --body-file, -F, -F body=@, --field body=,
#     and the heredoc -> file -> --body-file shape this repo mandates)
#   - PASS  for every legitimate `next`, for any `now` whatever its reason, and
#     for a body with no `Session-fit` decision at all
#   - PASS  for the verbs deliberately NOT gated (edit / comment) -- the gate
#           wants re-classification, so taxing it would penalise the fix
#   - BLOCK for chained / `cd` / `-R` spellings, which is where the
#           line-start-anchored ancestors of this gate family leaked
#   - PASS  for a command that merely QUOTES the trigger
#   - PASS  in a repo that never opted in (no `.markgate.yml`)
#   - the BOUNDARY cases that decide how much text is "the reason": a wrapped
#     continuation, the next `Key:` field, a list item, a heading, a blank line,
#     a second `Session-fit:`, and a ``` / ~~~ fenced exhibit
#   - the BYPASS is honoured in command position only -- a mention inside a
#     quoted body or a heredoc body must NOT disarm the gate
#
# MEASURED, not asserted. Every fence in the gate was mutation-probed against
# THIS suite and every probe killed at least one case -- baseline 69/0, under
# /bin/bash 3.2.57 (identical tally under 5.3.9):
#
#   stub: always exit 0                             36 red
#   case-insensitive matching removed               36 red
#   stub: always exit 2                             35 red
#   reason boundaries (key / item / heading) gone    5 red
#   next-only guard removed (`now` gated too)        4 red
#   fenced-block strip removed                       3 red
#   segment scoping removed (whole command)          2 red
#   bypass command-position check removed            2 red
#   repo opt-in guard removed                        1 red
#   heredoc body arm removed (file-first only)       1 red
#   `gh api` REST mint arm removed                   1 red
#   one vocabulary term (`own review`) removed       1 red
#
# The 1-red probes are the ones to watch when adding cases: each is fenced by a
# SINGLE case, so deleting that case silently unfences the arm.
#
# Run in place, from `.claude/hooks/` -- the harness resolves its subject from
# its own path (asserted by tests/skill-doc-paths.test.ts), so a copy parked
# elsewhere fails every case on exit 127.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/issue-deferral-criteria-gate.sh"
PASS=0
FAIL=0

TMPBASE="$(cd "$(mktemp -d)" && pwd -P)"

# --- BASH 3.2 FENCE ---
# macOS ships bash 3.2 as /bin/bash and this repo runs on it, so the hook has to
# stay 3.2-clean. Running THIS FILE under /bin/bash proves nothing about the
# hook: every case invokes it as "$HOOK", whose shebang is `#!/usr/bin/env bash`
# and resolves through PATH -- normally a Homebrew 5.x build. So a shim
# directory holding one symlink named `bash` goes FIRST on PATH, and every child
# `bash` (the shebang included) is the fenced interpreter.
#
# THE FENCE ONLY CATCHES PARSE-TIME CONSTRUCTS. `${x^^}` and `mapfile` abort the
# hook under 3.2 and are caught; a `declare -A` writes to stderr and KEEPS
# GOING, so it is invisible here. A future "is it still 3.2-clean?" probe must
# inject a parse-time construct.
#
# Default /bin/bash; override with HOOK_BASH to take the other tally. An
# explicitly set HOOK_BASH that is not executable is FATAL rather than a silent
# fall back to PATH bash -- falling back hides a typo in the one setting this
# fence exists to pin. Only the built-in DEFAULT may fall back, since a machine
# without /bin/bash is a fact rather than a mistake.
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

# Two fixture trees, because the gate is repo-opt-in:
#   $TMPROOT  -- a git repo carrying `.markgate.yml`, so the gate fires
#   $NOOPTIN  -- a git repo without it, so the gate must stay silent
# Real repos rather than mocks: the opt-in decision is exactly what
# `git rev-parse --show-toplevel` reports, so mocking it would test nothing.
TMPROOT="$TMPBASE/optin"
NOOPTIN="$TMPBASE/no-optin"
for d in "$TMPROOT" "$NOOPTIN"; do
  mkdir -p "$d"
  git -C "$d" init -q 2>/dev/null
done
printf 'gates: {}\n' > "$TMPROOT/.markgate.yml"

# run <name> <command> <cwd> <expected-exit>
run() {
  local name="$1" command="$2" cwd="$3" expect="$4"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ]; then
    echo "PASS: $name (exit $rc)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected $expect)"
    printf '%s\n' "$out" | sed 's/^/      /' | head -4
    FAIL=$((FAIL + 1))
  fi
}

# run_msg <name> <command> <cwd> <expected-exit> <substring the stderr must carry>
# The exit code alone cannot tell the refusal apart from the fail-closed
# library refusal, and it cannot see whether the OFFENDING REASON was echoed
# back -- deleting the quote would otherwise leave the suite green.
run_msg() {
  local name="$1" command="$2" cwd="$3" expect="$4" needle="$5"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ] && printf '%s' "$out" | grep -qF "$needle"; then
    echo "PASS: $name (exit $rc, message matched)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected $expect carrying '$needle')"
    printf '%s\n' "$out" | sed 's/^/      /' | head -6
    FAIL=$((FAIL + 1))
  fi
}

run_env() { # <name> <command> <cwd> <expected-exit> <VAR=value>
  local name="$1" command="$2" cwd="$3" expect="$4" envassign="$5"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | env "$envassign" "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ]; then
    echo "PASS: $name (exit $rc)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected $expect)"
    FAIL=$((FAIL + 1))
  fi
}

run_nonbash() { # <name> <expected-exit>
  local out rc
  out=$(jq -n '{tool_name:"Edit", tool_input:{file_path:"x"}}' | "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$2" ]; then
    echo "PASS: $1 (exit $rc)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $1 (exit $rc, expected $2)"
    FAIL=$((FAIL + 1))
  fi
}

# --- the vocabulary, one case per term, through the inline --body channel ----
run_msg "own PR"        "gh issue create --title t --body 'Session-fit: next (not this session) -- it needs its own PR'"        "$TMPROOT" 2 "PR-SHAPED reason"
run     "separate PR"   "gh issue create --title t --body 'Session-fit: next (not this session) -- this wants a separate PR'"   "$TMPROOT" 2
run     "share a PR"    "gh issue create --title t --body 'Session-fit: next (not this session) -- it cannot share a PR with the fix'" "$TMPROOT" 2
run     "sharing a PR"  "gh issue create --title t --body 'Session-fit: next (not this session) -- sharing a PR would hide it'"  "$TMPROOT" 2
run     "shares a PR"   "gh issue create --title t --body 'Session-fit: next (not this session) -- it shares a PR with nothing'" "$TMPROOT" 2
run     "own PRs plural" "gh issue create --title t --body 'Session-fit: next (not this session) -- these want their own PRs'"  "$TMPROOT" 2
run     "independent review surface" "gh issue create --title t --body 'Session-fit: next (not this session) -- an independent review surface'" "$TMPROOT" 2
run     "unreviewable"  "gh issue create --title t --body 'Session-fit: next (not this session) -- the sweep would be unreviewable'" "$TMPROOT" 2
run     "own review"    "gh issue create --title t --body 'Session-fit: next (not this session) -- it wants its own review'"    "$TMPROOT" 2
# The reason is ECHOED BACK, so a reader can see what the gate objected to.
run_msg "the offending reason is quoted back" \
  "gh issue create --title t --body 'Session-fit: next (not this session) -- it needs its own PR'" \
  "$TMPROOT" 2 "it needs its own PR"

# --- every legitimate `next` this repo documents PASSES ----------------------
run "next: a fixture must be written" \
  "gh issue create --title t --body 'Session-fit: next (not this session) -- no fixture under tests/integration/ covers this shape; one has to be written'" "$TMPROOT" 0
run "next: bound to this run's live AWS state" \
  "gh issue create --title t --body 'Session-fit: next (not this session) -- the verifier is the shared-name core suite and needs a global clean window in us-east-1'" "$TMPROOT" 0
run "next: external input" \
  "gh issue create --title t --body 'Session-fit: next (not this session) -- blocked on an AWS quota increase'" "$TMPROOT" 0
run "next: host-bound verifier" \
  "gh issue create --title t --body 'Session-fit: next (not this session) -- the repro needs an arm64 host'" "$TMPROOT" 0
# `now` is NEVER argued with, whatever its reason says.
run "now with a PR-shaped reason is never gated" \
  "gh issue create --title t --body 'Session-fit: now (do it in this session) -- it lands in its own PR'" "$TMPROOT" 0
run "no Session-fit line at all" \
  "gh issue create --title t --body 'A defect. It needs its own PR eventually.'" "$TMPROOT" 0
# `nextish` is not `next`: the token is bounded.
run "a Session-fit value that merely starts with next" \
  "gh issue create --title t --body 'Session-fit: nextish -- its own PR'" "$TMPROOT" 0
# A `Session-fit` line stating neither token is not a deferral decision.
run "Session-fit stating neither token" \
  "gh issue create --title t --body 'Session-fit: undecided -- it needs its own PR'" "$TMPROOT" 0

# --- case and bold spellings -------------------------------------------------
run "upper-case spelling" \
  "gh issue create --title t --body 'SESSION-FIT: NEXT (NOT THIS SESSION) -- ITS OWN PR'" "$TMPROOT" 2
run "bolded key **Session-fit:**" \
  "gh issue create --title t --body '**Session-fit:** next (not this session) -- its own PR'" "$TMPROOT" 2
run "bolded key **Session-fit**:" \
  "gh issue create --title t --body '**Session-fit**: next (not this session) -- its own PR'" "$TMPROOT" 2

# --- BOUNDARIES: how much text is "the reason" -------------------------------
BODY_DIR="$TMPROOT/bodies"
mkdir -p "$BODY_DIR"

# A wrapped continuation IS part of the reason.
cat > "$BODY_DIR/wrap.md" <<'EOF'
Some defect.

Session-fit: next (not this session) -- this touches a different subsystem
and needs its own PR anyway
Severity: low -- internal tidiness
EOF
run "wrapped continuation carries the reason" \
  "gh issue create --title t --body-file $BODY_DIR/wrap.md" "$TMPROOT" 2

# The next `Key:` field is NOT the reason.
cat > "$BODY_DIR/keyfield.md" <<'EOF'
Session-fit: next (not this session) -- blocked on an AWS quota increase
Effort: large (L) -- a behavior change needing its own PR plus review
EOF
run "a sibling Key: field is not folded into the reason" \
  "gh issue create --title t --body-file $BODY_DIR/keyfield.md" "$TMPROOT" 0

# A LIST ITEM is a boundary -- and this is CLAUDE.md's own template shape.
cat > "$BODY_DIR/listitem.md" <<'EOF'
## Remaining work
- TODO -- the thing
  - Session-fit: next (not this session) -- blocked on an AWS quota increase
  - Severity: low -- internal tidiness
  - Effort: large (L) -- a behavior change needing its own PR plus review
  - Estimate: ~2 h -- writing the fixture
EOF
run "the four-field bullet template does not fold Effort into Session-fit" \
  "gh issue create --title t --body-file $BODY_DIR/listitem.md" "$TMPROOT" 0

# ...but a list item after a PR-shaped reason still blocks on the reason itself.
cat > "$BODY_DIR/listitem-bad.md" <<'EOF'
  - Session-fit: next (not this session) -- it needs its own PR
  - Severity: low -- internal tidiness
EOF
run "a PR-shaped reason inside the bullet template still blocks" \
  "gh issue create --title t --body-file $BODY_DIR/listitem-bad.md" "$TMPROOT" 2

# A blank line is a boundary.
cat > "$BODY_DIR/blank.md" <<'EOF'
Session-fit: next (not this session) -- blocked on an AWS quota increase

Aside: the follow-up will want its own PR.
EOF
run "a blank line ends the reason" \
  "gh issue create --title t --body-file $BODY_DIR/blank.md" "$TMPROOT" 0

# A heading is a boundary.
cat > "$BODY_DIR/heading.md" <<'EOF'
Session-fit: next (not this session) -- blocked on an AWS quota increase
# Notes
It will need its own PR.
EOF
run "a heading ends the reason" \
  "gh issue create --title t --body-file $BODY_DIR/heading.md" "$TMPROOT" 0

# A second `Session-fit:` closes the first.
cat > "$BODY_DIR/second.md" <<'EOF'
Session-fit: next (not this session) -- blocked on an AWS quota increase
Session-fit: now (do it in this session) -- it needs its own PR
EOF
run "a second Session-fit closes the first" \
  "gh issue create --title t --body-file $BODY_DIR/second.md" "$TMPROOT" 0

# ...and the SECOND one is judged on its own merits.
cat > "$BODY_DIR/second-bad.md" <<'EOF'
Session-fit: now (do it in this session) -- rides an existing fixture
Session-fit: next (not this session) -- it needs its own PR
EOF
run "a later Session-fit: next is judged on its own reason" \
  "gh issue create --title t --body-file $BODY_DIR/second-bad.md" "$TMPROOT" 2

# --- FENCED EXHIBITS: a body arguing ABOUT the rule needs no bypass -----------
cat > "$BODY_DIR/fence.md" <<'EOF'
The gate refuses this shape:

```text
Session-fit: next (not this session) -- it needs its own PR
```

Session-fit: now (do it in this session) -- the evidence is live right now
EOF
run "a triple-backtick fenced exhibit is not scanned" \
  "gh issue create --title t --body-file $BODY_DIR/fence.md" "$TMPROOT" 0

cat > "$BODY_DIR/fence-tilde.md" <<'EOF'
~~~text
Session-fit: next (not this session) -- it needs its own PR
~~~

Session-fit: now (do it in this session) -- the evidence is live right now
EOF
run "a ~~~ fenced exhibit is not scanned" \
  "gh issue create --title t --body-file $BODY_DIR/fence-tilde.md" "$TMPROOT" 0

# A ``` line INSIDE a ~~~ block must not close it early.
cat > "$BODY_DIR/fence-nested.md" <<'EOF'
~~~text
```
Session-fit: next (not this session) -- it needs its own PR
```
~~~

Session-fit: now (do it in this session) -- fine
EOF
run "a backtick fence inside a ~~~ block does not close it early" \
  "gh issue create --title t --body-file $BODY_DIR/fence-nested.md" "$TMPROOT" 0

# An UNCLOSED fence must NOT blank the rest of the body (fail open).
cat > "$BODY_DIR/fence-unclosed.md" <<'EOF'
```text
Session-fit: next (not this session) -- it needs its own PR
EOF
run "an unclosed fence does not blank the rest of the body" \
  "gh issue create --title t --body-file $BODY_DIR/fence-unclosed.md" "$TMPROOT" 2

# THE INLINE-BODY LIMIT, pinned in BOTH directions so it stays measured rather
# than surprising. `gate_segments` joins a quoted span's newlines into spaces,
# so a multi-line inline `--body` arrives as one physical line and the reason
# runs to the end of it -- folding a LATER field's text in. The identical body
# through `--body-file` (the shape this repo mandates) is judged correctly.
INLINE_LIMIT="gh issue create --title t --body 'Session-fit: next (not this session) -- blocked on an AWS quota increase
Effort: large (L) -- a behavior change needing its own PR plus review'"
run "an inline multi-line --body folds later fields into the reason (known limit)" \
  "$INLINE_LIMIT" "$TMPROOT" 2
printf 'Session-fit: next (not this session) -- blocked on an AWS quota increase\nEffort: large (L) -- a behavior change needing its own PR plus review\n' > "$BODY_DIR/inline-limit.md"
run "...and the SAME body via --body-file is judged correctly" \
  "gh issue create --title t --body-file $BODY_DIR/inline-limit.md" "$TMPROOT" 0

# --- BODY CHANNELS ------------------------------------------------------------
printf 'Session-fit: next (not this session) -- it needs its own PR\n' > "$BODY_DIR/bad.md"
printf 'Session-fit: next (not this session) -- a new fixture must be written\n' > "$BODY_DIR/good.md"

run "--body-file on disk"        "gh issue create --title t --body-file $BODY_DIR/bad.md"        "$TMPROOT" 2
run "--body-file= on disk"       "gh issue create --title t --body-file=$BODY_DIR/bad.md"       "$TMPROOT" 2
run "-F <path> (gh short form)"  "gh issue create --title t -F $BODY_DIR/bad.md"                "$TMPROOT" 2
run "-F body=@<path>"            "gh issue create --title t -F body=@$BODY_DIR/bad.md"          "$TMPROOT" 2
run "--field body=@<path>"       "gh issue create --title t --field body=@$BODY_DIR/bad.md"     "$TMPROOT" 2
run "--field body=<inline>"      "gh issue create --title t --field 'body=Session-fit: next (not this session) -- its own PR'" "$TMPROOT" 2
run "a clean body-file passes"   "gh issue create --title t --body-file $BODY_DIR/good.md"      "$TMPROOT" 0

# The REST mint is the same act through another verb.
run "gh api repos/<o>/<r>/issues -f body=" \
  "gh api repos/go-to-k/cdk-real-drift/issues -f title=t -f 'body=Session-fit: next (not this session) -- its own PR'" "$TMPROOT" 2
run "gh api mint with a clean body" \
  "gh api repos/go-to-k/cdk-real-drift/issues -f title=t -f 'body=Session-fit: next (not this session) -- a new fixture is needed'" "$TMPROOT" 0

# --- the heredoc -> file -> --body-file shape, in ONE command ----------------
# The file does not exist at PreToolUse time, so the heredoc body IS the body.
HD_BAD="cat > $BODY_DIR/hd.md <<'EOF'
Some defect.

Session-fit: next (not this session) -- it needs its own PR
EOF
gh issue create --title t --body-file $BODY_DIR/hd.md"
run "heredoc body carries the PR-shaped reason" "$HD_BAD" "$TMPROOT" 2

HD_OK="cat > $BODY_DIR/hd2.md <<'EOF'
Session-fit: next (not this session) -- a new fixture must be written
EOF
gh issue create --title t --body-file $BODY_DIR/hd2.md"
run "heredoc body carries a legitimate reason" "$HD_OK" "$TMPROOT" 0

# THE FAIL-OPEN THIS ARM CLOSES: a STALE-but-clean file already on disk must not
# make the gate inert against the body actually being submitted.
printf 'Session-fit: now (do it in this session) -- previous body, clean\n' > "$BODY_DIR/stale.md"
HD_STALE="cat > $BODY_DIR/stale.md <<'EOF'
Session-fit: next (not this session) -- it needs its own PR
EOF
gh issue create --title t --body-file $BODY_DIR/stale.md"
run "a stale clean file does not mask the heredoc being submitted" "$HD_STALE" "$TMPROOT" 2

# An APPEND leaves the on-disk content as the first half of the submitted body,
# so it must still be scanned.
printf 'Session-fit: next (not this session) -- it needs its own PR\n' > "$BODY_DIR/append.md"
HD_APPEND="cat >> $BODY_DIR/append.md <<'EOF'
Severity: low -- tidy
EOF
gh issue create --title t --body-file $BODY_DIR/append.md"
run "an append still scans what is on disk" "$HD_APPEND" "$TMPROOT" 2

# `<<-` with a TAB-indented terminator.
HD_DASH="$(printf 'cat > %s/hddash.md <<-EOF\n\tSession-fit: next (not this session) -- it needs its own PR\n\tEOF\ngh issue create --title t --body-file %s/hddash.md' "$BODY_DIR" "$BODY_DIR")"
run "<<- heredoc with a tab-indented terminator" "$HD_DASH" "$TMPROOT" 2

# A path that cannot be resolved from command text falls back to the whole
# command rather than refusing -- and the command still carries the reason.
run "an unresolvable \$VAR path falls back to the command" \
  "gh issue create --title t --body-file \$BODY 'Session-fit: next (not this session) -- its own PR'" "$TMPROOT" 2
# ...and a clean command with an unresolvable path is not refused.
run "an unresolvable \$VAR path with a clean command passes" \
  "gh issue create --title t --body-file \$BODY" "$TMPROOT" 0

# --- SEGMENT SCOPING ---------------------------------------------------------
# `-F` is `git commit`'s flag too, and commit messages quote the lines they
# describe. The scan must not read the COMMIT MESSAGE.
printf 'chore: add the gate\n\nIt refuses: Session-fit: next (not this session) -- its own PR\n' > "$BODY_DIR/msg.txt"
run "a git commit -F message is not read as the issue body" \
  "git commit -F $BODY_DIR/msg.txt && gh issue create --title t --body-file $BODY_DIR/good.md" "$TMPROOT" 0

# There is no whole-segment fallback, so a TITLE about the rule is not a body.
run "a --title about the rule is not a deferral" \
  "gh issue create --title 'Session-fit: next handling for its own PR' --body-file $BODY_DIR/good.md" "$TMPROOT" 0

# --- SPELLINGS THAT LEAKED IN THIS GATE FAMILY BEFORE ------------------------
run "cd <repo> && gh issue create" \
  "cd $TMPROOT && gh issue create --title t --body 'Session-fit: next (not this session) -- its own PR'" "$TMPROOT" 2
run "chained after another command" \
  "git status && gh issue create --title t --body 'Session-fit: next (not this session) -- its own PR'" "$TMPROOT" 2
run "gh -R <owner/repo> issue create (the mirror flow) is judged by its BODY" \
  "gh -R go-to-k/cdk-local issue create --title t --body 'Session-fit: next (not this session) -- its own PR'" "$TMPROOT" 2
run "gh -R with a clean body still passes" \
  "gh -R go-to-k/cdk-local issue create --title t --body-file $BODY_DIR/good.md" "$TMPROOT" 0
run "gh --repo=<owner/repo> issue create" \
  "gh --repo=go-to-k/cdk-local issue create --title t --body 'Session-fit: next (not this session) -- its own PR'" "$TMPROOT" 2

# --- VERBS DELIBERATELY NOT GATED --------------------------------------------
run "gh issue edit is not gated (re-classification is the outcome we want)" \
  "gh issue edit 42 --body 'Session-fit: next (not this session) -- its own PR'" "$TMPROOT" 0
run "gh issue comment is not gated" \
  "gh issue comment 42 --body 'Session-fit: next (not this session) -- its own PR'" "$TMPROOT" 0
run "a command that merely QUOTES the trigger" \
  "echo 'gh issue create --body \"Session-fit: next -- its own PR\"'" "$TMPROOT" 0

# --- REPO OPT-IN --------------------------------------------------------------
run "a repo with no .markgate.yml is never refused" \
  "gh issue create --title t --body 'Session-fit: next (not this session) -- its own PR'" "$NOOPTIN" 0

# --- THE BYPASS ---------------------------------------------------------------
run_env "the process env bypass" \
  "gh issue create --title t --body 'Session-fit: next (not this session) -- its own PR'" \
  "$TMPROOT" 0 "CDKRD_SKIP_DEFERRAL_CRITERIA_GATE=1"
run "the command-text bypass, leading" \
  "CDKRD_SKIP_DEFERRAL_CRITERIA_GATE=1 gh issue create --title t --body 'Session-fit: next (not this session) -- its own PR'" "$TMPROOT" 0
run "the command-text bypass after &&" \
  "cd $TMPROOT && CDKRD_SKIP_DEFERRAL_CRITERIA_GATE=1 gh issue create --title t --body 'Session-fit: next (not this session) -- its own PR'" "$TMPROOT" 0
# THE HALF THAT MATTERS: a mention inside the BODY must not disarm the gate.
run "a QUOTED mention of the bypass does not disarm it" \
  "gh issue create --title t --body 'Session-fit: next (not this session) -- its own PR; CDKRD_SKIP_DEFERRAL_CRITERIA_GATE=1 exists for quotes'" "$TMPROOT" 2
HD_BYPASS="cat > $BODY_DIR/hdby.md <<'EOF'
CDKRD_SKIP_DEFERRAL_CRITERIA_GATE=1 is the documented escape hatch.

Session-fit: next (not this session) -- it needs its own PR
EOF
gh issue create --title t --body-file $BODY_DIR/hdby.md"
run "a heredoc-body mention of the bypass at line start does not disarm it" "$HD_BYPASS" "$TMPROOT" 2

# --- INERT INPUTS -------------------------------------------------------------
run "empty command passes" "" "$TMPROOT" 0
run_nonbash "non-Bash tool passes" 0

echo ""
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" -eq 0 ]

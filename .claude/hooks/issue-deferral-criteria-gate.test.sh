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
# THIS suite and every probe killed at least one case -- baseline 100/0, under
# /bin/bash 3.2.57 (identical tally under 5.3.9):
#
#   stub: always exit 0                            53 red
#   stub: always exit 2                            49 red
#   `restore_inline_newlines` call removed          4 red
#   restore slice -> the whole raw command          1 red
#   restore `-b[=\s]*` -> `[=\s]+` (glued `-b`)     1 red
#   fallback -> the segment only                    2 red
#   `input_body_text` call removed                  4 red
#   `--input` heredoc STATUS -> emptiness           1 red
#   `--input` `$VAR` heredoc arm removed            1 red
#   `--input` relative join dropped                 1 red
#   `-b` extractor arm removed                      1 red
#   `[*_]*next` -> `next` (bolded VALUE)            1 red
#   `key_re` `:([^/]|/[^/]|$)` -> `:([^/]|$)`       1 red
#   `key_re` `:([^/]|$)` -> `:`                     1 red
#
# NOT re-taken this round, and so NOT quoted above: the older per-fence probes
# (case-insensitive matching, the reason boundary, the next-only guard, the
# fence strip, the bypass check, the opt-in guard, the heredoc arm, the REST
# mint arm, one vocabulary term). They were measured on the 69-case baseline
# and every one of them predates this round`s cases, so their numbers moved by
# an unknown amount. Re-take them wholesale before quoting any of them again --
# three numbers carried forward one round were contradicted this round, which
# is why none is carried forward here.
#
#   segment ORDINAL -> plain `index`         fails  1   -- two segments that
#                                                      collapse to identical text
#                                                      sharing one raw slice
#   `pull[[:space:]-]+requests?` dropped     fails  2   -- `own pull request`
#                                                      and `own-PR`
#
# THE WRITER PRE-FILTER IS NOT FENCED BY A CASE, deliberately. It is a COST fix
# -- without it 40 chained `--body-file missing$i.md` crossed the PreToolUse
# timeout, which is a SILENT PASS -- and a wall-clock assertion in a unit suite
# is a flake generator. Deleting it leaves the suite green; the measurement
# lives in the comment beside it.
# TWO PROBES NEED BOTH SITES BROKEN AT ONCE: the fallback lives at two arms
# (unresolvable-path and unreadable-file) and each case reaches only one, so a
# one-arm mutation kills nothing and reads as unfenced.
#
# The 1-red probes are the ones to watch when adding cases: each is fenced by a
# SINGLE case, so deleting that case silently unfences the arm.
#
# Re-measured 2026-09-05: every row above reproduced EXACTLY, under both
# interpreters. The two stubs are pinned by CONSTRUCTION -- `exit 0` / `exit 2`
# inserted directly after `set -u` -- because a stub probe's tally is a property
# of the stub: the sibling warner harness measured 17 / 18 / 19 red for three
# plausible readings of one "always warn" stub on an unmodified hook.
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
# WHAT THIS FENCE CATCHES, MEASURED (3.2.57 vs 5.3.9, 2026-09-05). The short
# version: NONE of the bash-4 constructs aborts on its own, so naming one is not
# enough to make a probe discriminate.
#
#   ${v^^}          -> `bad substitution` on stderr, execution CONTINUES, rc=0
#   mapfile -t a    -> `command not found` on stderr, CONTINUES,          rc=0
#   declare -A m    -> `-A: invalid option` on stderr, CONTINUES,         rc=0
#
# What turns any of them red is the hook then READING the result under `set -u`,
# because the failed construct left the name unset:
#
#   ${v^^} ; then use $r        -> `r: unbound variable`      rc=1
#   mapfile ; then use ${a[0]}  -> `arr[0]: unbound variable` rc=1
#   declare -A m ; then m[k]=v  -> `k: unbound variable`      rc=2
#
# TWO WAYS TO WRITE THAT PROBE AND GET THE WRONG ANSWER:
#
#   1. A SOFT read defeats it -- `${a[0]:-EMPTY}` after a failed `mapfile` keeps
#      going at rc=0. It is the HARD read, not the construct, that is load-bearing.
#   2. Putting the construct and its read on ONE `;`-separated line defeats it
#      too. bash 3.2 discards the rest of the list after the bad substitution, so
#      the read never runs and nothing is unbound. Measured on THIS suite:
#
#        __p_v=x; __p_r="${__p_v^^}"; : "$__p_r"     (one line)   69 PASS / 0 FAIL
#        __p_v=x                                                   <- three
#        __p_r="${__p_v^^}"                                           separate
#        : "$__p_r"                                  (three lines)  0 PASS / 69 FAIL
#
#      Same three commands, same interpreter. Only the second discriminates.
#
# So a valid "is it still 3.2-clean?" probe injects a construct whose result the
# hook SUBSEQUENTLY READS, hard, on a LATER LINE.
#
# The 5.x arm needs `HOOK_BASH` set EXPLICITLY: this suite defaults the hook
# interpreter to /bin/bash, so a bare `bash <this file>` already runs the hook
# under 3.2 and both arms of a probe come back red, which reads as "the probe
# broke everything" rather than "the fence works". The three-line probe above is
# 0/69 under `HOOK_BASH=/bin/bash` and 69/0 under `HOOK_BASH=<homebrew bash>`.
#
# `main-tree-branch-gate.test.sh` records 53 red from a `${verb^^}` injected
# INSIDE `verdict_for` and calls it an abort; that tally is real, and the reason
# is this one -- the substitution failed and the verdict variable was then read.
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

# THE INLINE-BODY CHANNEL, pinned in BOTH directions -- an inline `--body` and
# the SAME body through `--body-file` must reach the SAME verdict. They did not
# before `restore_inline_newlines`: `gate_segments` emits one line per segment,
# so a multi-line inline body arrived flattened, every reason terminator
# (`Key:` field, list item, heading, blank line) became unreachable, and the
# whole body read as ONE reason -- folding a LATER field`s text in. The
# MEASURED defect is a FALSE BLOCK: a legitimate `next` whose `Effort:` line
# quotes this repo`s own "needing its own PR plus review" wording. That is the
# first case, and it is the one the mutation probe kills.
#
# The second case is the OTHER direction -- a PR-shaped reason on a later line
# must still be caught. It passed before this change too (flattening moved the
# text, it did not hide it), so it fences the FIX against over-correcting
# rather than fencing the defect.
INLINE_LIMIT="gh issue create --title t --body 'Session-fit: next (not this session) -- blocked on an AWS quota increase
Effort: large (L) -- a behavior change needing its own PR plus review'"
run "an inline multi-line --body ends the reason at the next field" \
  "$INLINE_LIMIT" "$TMPROOT" 0
run "an inline multi-line --body still catches a PR-shaped reason on a later line" \
  "gh issue create --title t --body 'Dup-check: searched, none
Session-fit: next (not this session) -- it needs its own PR
Severity: low -- x'" "$TMPROOT" 2
# An ANSI-C body needs NO restoration -- its `\n` is a literal backslash-n
# that `gate_unq` decodes AFTER `gate_segments` has run, so nothing was ever
# flattened. The case is here as the CONTROL for the restored one above: it
# reaches the same verdict by a different route, and it passes with
# `restore_inline_newlines` removed, which is the point.
run "an inline ANSI-C multi-line --body needs no restoration" \
  "gh issue create --title t --body \$'Session-fit: next (not this session) -- blocked on an AWS quota increase\\nEffort: large (L) -- a behavior change needing its own PR plus review'" \
  "$TMPROOT" 0
printf 'Session-fit: next (not this session) -- blocked on an AWS quota increase\nEffort: large (L) -- a behavior change needing its own PR plus review\n' > "$BODY_DIR/inline-limit.md"
run "...and the SAME body via --body-file reaches the same verdict" \
  "gh issue create --title t --body-file $BODY_DIR/inline-limit.md" "$TMPROOT" 0

# The UNRESOLVABLE-BODY fallback is SEGMENT-scoped, like every other scan here.
# It used to fall back to the whole command, so a `git commit -m` message that
# QUOTES a PR-shaped line -- what the commit introducing this gate does -- was
# read as the issue body and refused.
run "an unresolvable body-file does not read the sibling commit message" \
  "git commit -m 'gate: refuse a body reading
Session-fit: next (not this session) -- it needs its own PR' && gh issue create --title t --body-file \"\$BODY\"" \
  "$TMPROOT" 0

# `gh api ... --input <file>` is a body CHANNEL of its own: the REST mint the
# gate already arms on carries the whole payload as JSON on disk, so no
# `--body-file` / `-F` / `-f body=` arm reads it. It filed a PR-shaped `next`
# at rc=0 before `input_body_text`. Both directions, plus the "cannot read is
# not evidence" rule that governs every other file arm here.
printf '{"title":"t","body":"Session-fit: next (not this session) -- it needs its own PR"}\n' > "$BODY_DIR/input-bad.json"
printf '{"title":"t","body":"Session-fit: next (not this session) -- blocked on an AWS quota increase"}\n' > "$BODY_DIR/input-ok.json"
run "gh api --input: PR-shaped body in the JSON payload" \
  "gh api repos/o/r/issues -f title=t --input $BODY_DIR/input-bad.json" "$TMPROOT" 2
run "gh api --input: legitimate body in the JSON payload" \
  "gh api repos/o/r/issues -f title=t --input $BODY_DIR/input-ok.json" "$TMPROOT" 0
run "gh api --input: an unreadable payload is not evidence" \
  "gh api repos/o/r/issues -f title=t --input $BODY_DIR/input-missing.json" "$TMPROOT" 0

# Cases for the fixes an earlier round shipped UNFENCED -- each verified to go
# red when its own line is reverted, and green otherwise.
run "-b (gh short --body) carries a PR-shaped reason" \
  "gh issue create --title t -b 'Session-fit: next (not this session) -- it needs its own PR'" \
  "$TMPROOT" 2
run "-b (gh short --body) carries a legitimate reason" \
  "gh issue create --title t -b 'Session-fit: next (not this session) -- blocked on an AWS quota increase'" \
  "$TMPROOT" 0
run "a BOLDED next value is read like a bolded key" \
  "gh issue create --title t --body '**Session-fit:** **next** -- it needs its own PR'" \
  "$TMPROOT" 2
# The reason boundary is any `Key:` line EXCEPT a URL scheme -- both halves,
# because narrowing to the named fields fixed the URL at the cost of refusing
# every OTHER field line, and `Note:` is one character from the `Notes:` that
# passes.
run "a wrapped reason is not ended by a URL scheme" \
  "gh issue create --title t --body 'Session-fit: next (not this session) -- see
https://example.com/x it needs its own PR'" "$TMPROOT" 2
run "a sibling Note: line still ends the reason" \
  "gh issue create --title t --body 'Session-fit: next (not this session) -- blocked on an AWS quota increase
Note: the cleanup will get its own PR'" "$TMPROOT" 0
# The unresolvable / unreadable body fallback reads the WRITER, which lives in
# another segment, but not an unrelated sibling command`s message.
run "an unreadable body-file whose writer is in the command is still judged" \
  "printf 'Session-fit: next (not this session) -- it needs its own PR\\n' > $BODY_DIR/nodir/b.md && gh issue create --title t --body-file $BODY_DIR/nodir/b.md" \
  "$TMPROOT" 2
# `--input` goes through the same path resolution as `--body-file`: a relative
# path is joined to the resolved cwd, and a payload written by a heredoc in the
# SAME command is read out of it.
printf '{"title":"t","body":"Session-fit: next (not this session) -- it needs its own PR"}\n' > "$BODY_DIR/rel-input.json"
run "gh api --input: a relative payload path resolves against the cwd" \
  "gh api repos/o/r/issues -f title=t --input rel-input.json" "$BODY_DIR" 2
# RELATIVE and heredoc-written at once: the heredoc lookup is handed BOTH the
# raw spelling and the resolved path, and only the raw one matches a command
# that writes `hd-input.json`. The RAW spelling is the load-bearing one --
# dropping it makes this case red; passing the resolved path twice does not.
run "gh api --input: a relative payload written by a heredoc in the same call" \
  "cat > hd-input.json <<'JSON'
{\"title\":\"t\",\"body\":\"Session-fit: next (not this session) -- it needs its own PR\"}
JSON
gh api repos/o/r/issues -f title=t --input hd-input.json" "$BODY_DIR" 2

# Round-3 review shapes, each measured before the fix and each killed by
# mutating its own line.
run "a GLUED -b multi-line body is restored too" \
  "gh issue create --title t -b'Session-fit: next (not this session) -- blocked on an AWS quota increase
Effort: large (L) -- a behavior change needing its own PR plus review'" "$TMPROOT" 0
# The fallback must be the SEGMENT plus the WRITER segments, never the whole
# command: with a writer AND a quoting sibling in one chain, a `$cmd` fallback
# refuses a clean body.
run "a writer and a quoting sibling in one chain do not collide" \
  "git commit -m 'quote: Session-fit: next (not this session) -- it needs its own PR' && printf 'ok\\n' > $BODY_DIR/nodir/b.md && gh issue create --title t --body-file $BODY_DIR/nodir/b.md" \
  "$TMPROOT" 0
run "an unresolvable body-file whose writer is in the command is judged" \
  "printf 'Session-fit: next (not this session) -- it needs its own PR\\n' > \"\$BODY\" && gh issue create --title t --body-file \"\$BODY\"" \
  "$TMPROOT" 2
# The restore lookup is scoped to this segment's raw slice: another segment's
# body must not decide this one's verdict.
run "a sibling comment body does not decide the create verdict" \
  "gh issue comment 1 --body 'Session-fit: now -- fine.
Session-fit: next (not this session) -- it needs its own PR' && gh issue create --title t --body 'Session-fit: now -- fine. Session-fit: next (not this session) -- it needs its own PR'" \
  "$TMPROOT" 0
# An EMPTY heredoc body is legal, so the STATUS reports whether a heredoc was
# found -- reading emptiness as "none" falls through to the stale file on disk.
printf '{"title":"t","body":"Session-fit: next (not this session) -- it needs its own PR"}\n' > "$BODY_DIR/stale-input.json"
run "gh api --input: an empty heredoc rewrite supersedes the stale payload" \
  "cat > $BODY_DIR/stale-input.json <<'JSON'
JSON
gh api repos/o/r/issues -f title=t --input $BODY_DIR/stale-input.json" "$TMPROOT" 0
run "gh api --input: a \$VAR payload written by a heredoc is still read" \
  "cat > \"\$P\" <<'JSON'
{\"title\":\"t\",\"body\":\"Session-fit: next (not this session) -- it needs its own PR\"}
JSON
gh api repos/o/r/issues -f title=t --input \"\$P\"" "$TMPROOT" 2
# The URL carve-out excepts a SCHEME, not any `Key:/value` -- a bare `:([^/]|$)`
# folded a `Repro:/tmp/x` continuation into the reason and refused a legitimate
# `next`.
run "a Key:/value continuation still ends the reason" \
  "gh issue create --title t --body 'Session-fit: next (not this session) -- blocked on an AWS quota increase
Repro:/tmp/x it needs its own PR'" "$TMPROOT" 0

# Round-4 blockers, each measured before the fix.
# `index` alone hands the SECOND of two segments that collapse to identical
# text the FIRST one's raw slice, so a flat PR-shaped filing passed on its
# twin's newline placement. The ordinal selects the right occurrence.
run "twin segments do not share one raw slice" \
  "gh issue create --title t --body 'Session-fit: next (not this session)
Severity: high it needs its own PR' && gh issue create --title t --body 'Session-fit: next (not this session) Severity: high it needs its own PR'" \
  "$TMPROOT" 2
# `PR` / `pull request` / `own-PR` are SPELLINGS of one noun. A passing mention
# of somebody else's pull request is not a PR-shaped REASON and must still pass.
run "own pull request, spelled out" \
  "gh issue create --title t --body 'Session-fit: next (not this session) -- it needs its own pull request'" \
  "$TMPROOT" 2
run "own-PR, hyphenated" \
  "gh issue create --title t --body 'Session-fit: next (not this session) -- it needs its own-PR'" \
  "$TMPROOT" 2
run "a passing mention of an upstream pull request still passes" \
  "gh issue create --title t --body 'Session-fit: next (not this session) -- blocked on upstream pull request aws/aws-cdk#123 landing'" \
  "$TMPROOT" 0

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

# --- the shared GATE_PERL_WORD value class, and its guard --------------------
# Ported with the class from go-to-k/cdkd#2639. Three spellings were LIVE
# fail-opens here before the port, each measured rc=0 where the plain path gave
# 2: a quoted path containing a SPACE, a BACKSLASH-escaped one, and the GLUED
# `-F<path>` gh accepts. They are cases rather than a note because a value
# class that enumerates quote POSITIONS grows a new hole every time gh accepts
# another spelling.
GWDIR="$TMPROOT/gw dir"
mkdir -p "$GWDIR"
DEFER_BODY='Session-fit: next (not this session) -- it needs its own PR'
printf '%s\n' "$DEFER_BODY" > "$GWDIR/defer.md"
printf 'Session-fit: next (not this session) -- a new fixture must be written\n' > "$GWDIR/ok.md"
run "spaced --body-file path, double-quoted, blocks" \
  "gh issue create -t x --body-file \"$GWDIR/defer.md\"" "$TMPROOT" 2
run "spaced --body-file path, backslash-escaped, blocks" \
  "gh issue create -t x --body-file ${GWDIR// /\\ }/defer.md" "$TMPROOT" 2
run "glued -F<spaced path> blocks" \
  "gh issue create -t x -F\"$GWDIR/defer.md\"" "$TMPROOT" 2
run "spaced --body-file path, compliant reason, passes" \
  "gh issue create -t x --body-file \"$GWDIR/ok.md\"" "$TMPROOT" 0

# The guard itself. `[ -n "$GATE_PERL_WORD" ]` cannot see a prelude that is
# present but does not COMPILE, and every extraction runs perl with stderr
# discarded -- so the gate would extract nothing and PASS. The payload below is
# one this gate NORMALLY PASSES, so exit 2 can only come from the guard.
GWBROKEN="$TMPROOT/brokenlib"
mkdir -p "$GWBROKEN"
cp "$HOOK" "$GWBROKEN/"
sed "s|^  my \$GW = qr/.*|  my \$GW = qr/(((unclosed/;|" \
  "$(dirname "$HOOK")/_command-match.sh" > "$GWBROKEN/_command-match.sh"
if grep -q 'unclosed' "$GWBROKEN/_command-match.sh" \
   && ! grep -q 'my \$GW = qr/(?:' "$GWBROKEN/_command-match.sh"; then
  gw_rc=0
  jq -n --arg c "gh issue create -t x --body-file \"$GWDIR/ok.md\"" --arg d "$TMPROOT" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}' \
    | "$GWBROKEN/$(basename "$HOOK")" >/dev/null 2>&1 || gw_rc=$?
  if [ "$gw_rc" = "2" ]; then
    echo "PASS: a non-compiling GATE_PERL_WORD fails CLOSED (exit 2)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: a non-compiling GATE_PERL_WORD returned $gw_rc, expected 2"
    FAIL=$((FAIL + 1))
  fi
else
  # A probe that silently does not run is the failure mode this file is about.
  echo "FAIL: could not stage a broken GATE_PERL_WORD (sed anchor drifted)"
  FAIL=$((FAIL + 1))
fi
# And it must not be switchable off from the ENVIRONMENT: the memo is an
# ordinary shell variable, so without a reset at library load `__GATE_PW_OK=1`
# made the probe report a working prelude it never ran.
if [ -f "$GWBROKEN/_command-match.sh" ]; then
  gw_env_rc=0
  jq -n --arg c "gh issue create -t x --body-file \"$GWDIR/ok.md\"" --arg d "$TMPROOT" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}' \
    | __GATE_PW_OK=1 "$GWBROKEN/$(basename "$HOOK")" >/dev/null 2>&1 || gw_env_rc=$?
  if [ "$gw_env_rc" = "2" ]; then
    echo "PASS: __GATE_PW_OK=1 cannot disable the prelude guard (exit 2)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: __GATE_PW_OK=1 disabled the prelude guard (exit $gw_env_rc, expected 2)"
    FAIL=$((FAIL + 1))
  fi
fi

echo ""
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" -eq 0 ]

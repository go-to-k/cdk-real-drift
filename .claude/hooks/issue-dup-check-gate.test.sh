#!/usr/bin/env bash
# Smoke tests for issue-dup-check-gate.sh
#
# The gate blocks `gh issue create` unless the body carries a `Dup-check:`
# line. Asserts, in both directions:
#   - PASS  when a --body-file / -F body=@ / inline --body carries the marker
#   - BLOCK when it does not, including when the named body file is unreadable
#   - PASS  for the verbs deliberately NOT gated (edit / comment), which is the
#           whole point: folding into an existing issue must stay cheaper than
#           minting a new one
#   - BLOCK for chained and `cd` spellings, which is where the line-start-anchored
#           ancestors of this gate family leaked (go-to-k/cdk-real-drift#1803)
#   - PASS  for a command that merely QUOTES the trigger
#   - PASS  in a repo that never opted in (no `.markgate.yml`)
#
# Measured rather than asserted (see the PR body): an always-`exit 0` stub and
# an always-`exit 2` stub each fail a large number of these, and every fence in
# the gate was mutation-probed individually — removing the opt-in guard, the
# file-scan anchor, the `gh api` arm, the segment scoping, the heredoc fallback,
# or the fail-closed library guard each fails exactly its own cases.
#
# Run in place, from `.claude/hooks/` — the harness resolves its subject from its
# own path (asserted by tests/skill-doc-paths.test.ts), so a copy parked
# elsewhere fails every case on exit 127.

set -u

HOOK="$(cd "$(dirname "$0")" && pwd)/issue-dup-check-gate.sh"
PASS=0
FAIL=0
# Two fixture trees, because the gate is repo-opt-in:
#   $TMPROOT  — a git repo carrying `.markgate.yml`, so the gate fires
#   $NOOPTIN  — a git repo without it, so the gate must stay silent
# Real repos rather than mocks: the opt-in decision is exactly what
# `git rev-parse --show-toplevel` reports, so mocking it would test nothing.
TMPBASE=$(mktemp -d)
trap 'rm -rf "$TMPBASE"' EXIT
TMPROOT="$TMPBASE/optin"
NOOPTIN="$TMPBASE/no-optin"
for d in "$TMPROOT" "$NOOPTIN"; do
  mkdir -p "$d"
  git -C "$d" init -q 2>/dev/null
done
printf 'gates: {}\n' > "$TMPROOT/.markgate.yml"

# run_msg <name> <command> <cwd> <expected-exit> <substring the stderr must carry>
# Both refusal arms exit 2, so the exit code alone cannot tell them apart —
# deleting one arm's message would otherwise leave the suite green.
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
    printf '%s\n' "$out" | sed 's/^/      /' | head -4
    FAIL=$((FAIL + 1))
  fi
}

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
    echo "$out" | sed 's/^/      /' | head -5
    FAIL=$((FAIL + 1))
  fi
}

# run_nonbash <name> <expected-exit>
run_nonbash() {
  local payload out rc
  payload=$(jq -n '{tool_name:"Edit", tool_input:{file_path:"/tmp/x"}}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$2" ]; then echo "PASS: $1 (exit $rc)"; PASS=$((PASS + 1))
  else echo "FAIL: $1 (exit $rc, expected $2)"; FAIL=$((FAIL + 1)); fi
}

WITH="$TMPROOT/with.md"
WITHOUT="$TMPROOT/without.md"
LIST="$TMPROOT/list.md"
LOWER="$TMPROOT/lower.md"
printf 'Some defect.\n\nDup-check: searched open issues for `overrides reader` -- none covers this root cause\n' > "$WITH"
printf 'Some defect.\n\nSession-fit: next (not this session) -- needs a new fixture\n' > "$WITHOUT"
printf 'Some defect.\n\n- Dup-check: searched open issues for `drift baseline` -- none covers this\n' > "$LIST"
printf 'Some defect.\n\ndup-check: searched open issues -- none covers this root cause\n' > "$LOWER"
MIDLINE="$TMPROOT/midline.md"
PLUSLIST="$TMPROOT/plus.md"
COMMITMSG="$TMPBASE/commit-msg.txt"
# The marker only mid-sentence. This is what fences MARKER_RE_LINE's ANCHOR:
# with the anchor swapped for the loose form, the split the gate calls
# load-bearing would have no discriminating case at all.
printf 'Some defect.\n\nWe ran a dup-check: nothing turned up, honest.\n' > "$MIDLINE"
printf 'Some defect.\n\n+ Dup-Check: searched open issues -- none covers this\n' > "$PLUSLIST"
# A commit message that QUOTES the marker at LINE START, which is the realistic
# shape — the commit introducing this gate carries `Dup-check:` in its own body.
# Mid-sentence would make this fixture pass for the WRONG reason: the anchor
# rejects it regardless of scoping, so the case would stay green with the
# segment scoping removed and would fence nothing.
printf 'chore: add the gate\n\nThe body must carry a line of this form:\n\nDup-check: searched open issues -- none covers this root cause\n' > "$COMMITMSG"

# --- the two directions, file-borne -----------------------------------------
run "body-file carries Dup-check"        "gh issue create --title t --body-file $WITH"    "$TMPROOT" 0
run "body-file lacks Dup-check"          "gh issue create --title t --body-file $WITHOUT" "$TMPROOT" 2
run "marker as a list item"              "gh issue create --title t --body-file $LIST"    "$TMPROOT" 0
run "marker lowercased"                  "gh issue create --title t --body-file $LOWER"   "$TMPROOT" 0
run "-F body=@ form carries marker"      "gh issue create -F body=@$WITH"                 "$TMPROOT" 0
run "-F body=@ form lacks marker"        "gh issue create -F body=@$WITHOUT"              "$TMPROOT" 2
run "bare -F <file> carries marker"      "gh issue create -F $WITH"                       "$TMPROOT" 0

# An unreadable body file must BLOCK, not pass. "Cannot read" being treated as
# "nothing to object to" is the fail-open shape that made sibling gates inert.
run "body-file path does not exist"      "gh issue create --body-file $TMPROOT/nope.md"   "$TMPROOT" 2

# Relative --body-file resolves against the payload cwd, and against a `cd` in
# command position before the verb.
run "relative body-file via payload cwd" "gh issue create --body-file with.md"                     "$TMPROOT" 0
run "relative body-file via leading cd"  "cd $TMPROOT && gh issue create --body-file with.md"      "/"        0
run "relative body-file, cd, no marker"  "cd $TMPROOT && gh issue create --body-file without.md"   "/"        2

# --- the two directions, inline ---------------------------------------------
run "inline --body carries marker"       "gh issue create --title t --body 'Bug. Dup-check: searched open issues -- none covers this'" "$TMPROOT" 0
run "inline --body lacks marker"         "gh issue create --title t --body 'Bug. Nothing else.'"                                       "$TMPROOT" 2

# --- verbs deliberately NOT gated -------------------------------------------
# Folding a finding into an existing issue is the outcome the gate steers
# toward, so these must never be taxed.
run "gh issue edit passes"               "gh issue edit 12 --body-file $WITHOUT"          "$TMPROOT" 0
run "gh issue comment passes"            "gh issue comment 12 --body-file $WITHOUT"       "$TMPROOT" 0
run "gh pr create passes"                "gh pr create --body-file $WITHOUT"              "$TMPROOT" 0
run "gh issue list passes"               "gh issue list --state open --search foo"        "$TMPROOT" 0

# --- spellings the line-start-anchored ancestors leaked ---------------------
run "chained after && blocks"            "git push && gh issue create --body-file $WITHOUT" "$TMPROOT" 2
run "chained after ; blocks"             "echo done; gh issue create --body-file $WITHOUT"  "$TMPROOT" 2
run "subshell blocks"                    "(gh issue create --body-file $WITHOUT)"           "$TMPROOT" 2
run "command substitution blocks"        "URL=\$(gh issue create --body-file $WITHOUT)"     "$TMPROOT" 2

# --- the repo-selecting flags: the MIRROR FLOW's own spelling ---------------
# `gh -R <owner/repo> issue create` is how §10-c files a mirrored issue into a
# sibling repo, and that flow is this gate's entire rationale — a gate blind to
# its primary shape would be close to inert. The verb regexes therefore use the
# SCOPED `GATE_GH_CR` (`-C` plus `-R` / `--repo`) rather than this repo's
# `-C`-only `GATE_GH_C`, which the five `GATE_RE_GH_PR_*` gates keep using.
#
# IF THESE CASES START FAILING, someone reverted the regexes to `GATE_GH_C`.
run "gh -R <repo> issue create blocks"   "gh -R go-to-k/cdk-real-drift issue create --body-file $WITHOUT" "$TMPROOT" 2
run "gh -R <repo> with marker passes"    "gh -R go-to-k/cdk-real-drift issue create --body-file $WITH"    "$TMPROOT" 0
run "gh --repo <repo> issue create blocks" "gh --repo go-to-k/cdk-local issue create --body-file $WITHOUT" "$TMPROOT" 2
run "gh --repo=<repo> issue create blocks" "gh --repo=go-to-k/cdk-local issue create --body-file $WITHOUT" "$TMPROOT" 2
# The mirror flow verbatim: filing into a SIBLING repo from an opted-in cwd. The
# cwd decides the policy, not `-R` — `-R` names where the issue LANDS.
run "-R sibling from an opted-in cwd"    "gh -R go-to-k/cdk-local issue create --body-file $WITHOUT"      "$TMPROOT" 2
run "gh -R … api issues POST blocks"     "gh -R go-to-k/cdk-local api repos/go-to-k/cdk-local/issues -f title=t" "$TMPROOT" 2
run "repeated flags absorbed"            "gh -C $TMPROOT -R go-to-k/cdk-local issue create --body-file $WITHOUT" "$TMPROOT" 2
# The control that keeps the block above from passing merely because the gate is
# broken: `-C` was already absorbed before `GATE_GH_CR` existed, and must stay so.
run "gh -C <dir> issue create blocks"    "gh -C $TMPROOT issue create --body-file $WITHOUT" "$TMPROOT" 2

# --- quoted-body false-positive cases ---------------------------------------
# A command that merely NAMES the trigger must not fire the gate.
run "quoted mention in commit message"   "git commit -m 'docs: explain gh issue create --body-file flow'" "$TMPROOT" 0
run "quoted mention in echo"             "echo 'run: gh issue create --body-file x.md'"                   "$TMPROOT" 0

# --- repo opt-in scope ------------------------------------------------------
# A repo that never opted in must not inherit this repo's filing discipline.
# The control directly above keeps this from passing merely because the gate is
# broken.
run "no .markgate.yml: not gated"        "gh issue create --body-file $NOOPTIN/x.md"       "$NOOPTIN" 0
run "outside any git repo: not gated"    "gh issue create --body-file $TMPBASE/x.md"       "$TMPBASE" 0

# --- the marker must be a LINE in a body file, not a passing mention --------
run "body-file marker only mid-sentence" "gh issue create --body-file $MIDLINE"  "$TMPROOT" 2
run "+ list prefix and odd caps accepted" "gh issue create --body-file $PLUSLIST" "$TMPROOT" 0

# --- the scans are scoped to the gh SEGMENT --------------------------------
# `-F` is `git commit`'s flag as well as gh's short `--body-file`, so an
# unscoped extraction read the COMMIT MESSAGE and found the marker there. Both
# orderings, because scoping only "after the verb" fixes just one of them.
run "commit -F before, gh after"  "git commit -F $COMMITMSG && gh issue create --body-file $WITHOUT" "$TMPROOT" 2
run "gh before, commit -F after"  "gh issue create --body-file $WITHOUT && git commit -F $COMMITMSG" "$TMPROOT" 2
run "grep -F pattern is not a body" "grep -F dup-check: $COMMITMSG && gh issue create --body-file $WITHOUT" "$TMPROOT" 2

# --- the opt-in `cd` must survive an EARLIER gh ----------------------------
# `gate_target_dir` breaks at the first segment matching the regex it is given,
# so a bare `gh` would make it stop at `gh issue list` and miss the `cd`. That
# is exactly the search-then-file chain this gate's own message prescribes.
run "search, cd, then file (no marker)" "gh issue list --state open --search x && cd $TMPROOT && gh issue create --body-file without.md" "$TMPBASE" 2
run "search, cd, then file (marker)"    "gh issue list --state open --search x && cd $TMPROOT && gh issue create --body-file with.md"    "$TMPBASE" 0

# --- the REST mint --------------------------------------------------------
run "gh api issues POST, no marker" "gh api repos/go-to-k/cdk-real-drift/issues -f title=t -f body=x"                  "$TMPROOT" 2
run "gh api issues POST, marker"    "gh api repos/go-to-k/cdk-real-drift/issues -f title=t -f 'body=x Dup-check: none'" "$TMPROOT" 0
run "gh api comments is not a mint" "gh api repos/go-to-k/cdk-real-drift/issues/5/comments -f body=x"                   "$TMPROOT" 0
run "gh api issue edit is not a mint" "gh api -X PATCH repos/go-to-k/cdk-real-drift/issues/5 -f body=x"                 "$TMPROOT" 0

# --- more body-file spellings ----------------------------------------------
run "--body-file=<p> form"          "gh issue create --body-file=$WITH"        "$TMPROOT" 0
run "--body-file=<p> without"       "gh issue create --body-file=$WITHOUT"     "$TMPROOT" 2
run "quoted --body-file path"       "gh issue create --body-file \"$WITHOUT\"" "$TMPROOT" 2
run "--field body=@ without"        "gh issue create --field body=@$WITHOUT"   "$TMPROOT" 2
run "--raw-field body=@ with"       "gh issue create --raw-field body=@$WITH"  "$TMPROOT" 0

# --- both refusal arms carry their own message ------------------------------
run_msg "missing-marker message"    "gh issue create --body-file $WITHOUT" "$TMPROOT" 2 "carries no"
run_msg "unreadable-path message"   "gh issue create --body-file $TMPROOT/nope.md" "$TMPROOT" 2 "No readable --body-file"
# An unexpanded variable is refused through its OWN arm: a bare "check the path"
# is unclearable when the file does carry the line.
run_msg "unexpanded \$VAR message"  "gh issue create --body-file \"\$BODY\"" "$TMPROOT" 2 "unexpanded variable"

# --- the library guard must FAIL CLOSED ------------------------------------
# Swapping the whole guard for `. lib || exit 0` leaves every other case green.
lib_fail_closed() {
  local tmp out rc
  tmp=$(mktemp -d)
  cp "$HOOK" "$tmp/gate.sh"          # no _command-match.sh beside it
  chmod +x "$tmp/gate.sh"
  out=$(jq -n '{tool_name:"Bash", tool_input:{command:"gh issue create --body-file /nope.md"}, cwd:"/"}' \
        | "$tmp/gate.sh" 2>&1) && rc=0 || rc=$?
  rm -rf "$tmp"
  if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qF "_command-match.sh"; then
    echo "PASS: unloadable library fails CLOSED (exit $rc)"; PASS=$((PASS + 1))
  else
    echo "FAIL: unloadable library should exit 2 naming the library (got $rc)"; FAIL=$((FAIL + 1))
  fi
}
lib_fail_closed

# --- the hook is actually REGISTERED ---------------------------------------
# The suite invokes the hook directly, so it would not otherwise notice the
# hook being dropped from .claude/settings.json. (Registration is not execution:
# tests/gate-if-matchers-1801.test.ts checks the `if` patterns that SELECT it.)
registration_check() {
  local settings
  settings="$(cd "$(dirname "$0")/../.." && pwd)/.claude/settings.json"
  if [ -f "$settings" ] && grep -q 'issue-dup-check-gate.sh' "$settings"; then
    echo "PASS: registered in .claude/settings.json"; PASS=$((PASS + 1))
  else
    echo "FAIL: not registered in .claude/settings.json"; FAIL=$((FAIL + 1))
  fi
}
registration_check

# --- heredoc -> file -> --body-file in ONE command --------------------------
# The file does not exist at PreToolUse time. It must PASS when the heredoc body
# carries the marker at line start — and still BLOCK when it does not.
HD_OK="cat > $TMPROOT/hd.md <<'EOF'
Some defect.

Dup-check: searched open issues -- none covers this root cause
EOF
gh issue create --body-file $TMPROOT/hd.md"
HD_NO="cat > $TMPROOT/hd2.md <<'EOF'
Some defect, nothing else.
EOF
gh issue create --body-file $TMPROOT/hd2.md"
run "heredoc body carries the marker" "$HD_OK" "$TMPROOT" 0
run "heredoc body lacks the marker"   "$HD_NO" "$TMPROOT" 2
# The fallback uses the ANCHORED marker, so a passing mention does not satisfy it.
HD_MID="cat > $TMPROOT/hd3.md <<'EOF'
We ran a dup-check: nothing turned up.
EOF
gh issue create --body-file $TMPROOT/hd3.md"
run "heredoc body mentions it mid-line" "$HD_MID" "$TMPROOT" 2

run "empty command passes" "" "$TMPROOT" 0

run_nonbash "non-Bash tool passes" 0

echo ""
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" -eq 0 ]

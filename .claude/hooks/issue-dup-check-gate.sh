#!/usr/bin/env bash
# issue-dup-check-gate.sh — block `gh issue create` unless the body carries a
# `Dup-check:` line recording that the OPEN issue list was searched for an
# issue already covering this root cause.
#
# WHY — AND THIS REPO'S CASE IS THE WEAKEST OF THE THREE. SAY SO.
#
# Measured 2026-08-25 in go-to-k/cdk-real-drift:
#
#   open issues                                       0
#
# cdkd's justification is NOT repeated here, because here it is simply false.
# There the argument is that the backlog COUNT does not converge — 115 open,
# 94 of them carrying `Session-fit: next`, and all four of the oldest
# umbrella-shaped. This repo has ZERO open issues. Nothing local is failing to
# converge, and no number from cdkd was copied into this file.
#
# The sibling port into cdk-local rests on two VERIFIED duplicate filings on
# the cross-repo mirror path (go-to-k/cdk-local#528 and go-to-k/cdk-local#531, nine minutes apart, one a
# strict subset of the other). There is no such instance here either. A
# title-prefix scan over this repo's `chore(work-issues): mirror …` filings
# surfaces exactly one candidate pair — go-to-k/cdk-real-drift#1786 and
# go-to-k/cdk-real-drift#1799 — and reading both shows they are NOT duplicates:
# #1786 mirrors three lessons from cdk-local's 2026-08-19 run (flake-fix ship
# order, explicit-`cd` marker calls, one gated command per Bash call), #1799
# mirrors three from cdkd's go-to-k/cdkd#2125 (a
# green fixture is not a working fix, a pre-run `cleanup` that deletes what the
# run needs, contradicting reviewers). Different source repos, different
# lessons, no overlap; both closed. That candidate is recorded here so it is
# not mistaken for evidence by a later reader.
#
# So the honest case for this gate here is PROPHYLACTIC:
#
#   - this repo sits on the same cross-repo mirror flow that /work-issues
#     section 10-c ALREADY documents as a duplicate GENERATOR — one issue body
#     written once and filed into two sibling repos;
#   - that flow demonstrably produced a duplicate pair in a sibling;
#   - the check costs one `gh issue list` and one line in the body.
#
# That is the whole argument. It is prevention with no local incident behind
# it, and it is deliberately not dressed up as more. If this repo's backlog
# stays at zero, this gate will have cost one line per filing and prevented
# nothing measurable — which is the expected outcome of a prophylactic, not a
# sign it should be removed.
#
# WHAT IS AND IS NOT GATED
#
#   gated:      gh issue create      — the only verb that MINTS a new issue
#               gh api …/issues        the same mint through the REST verb
#   not gated:  gh issue edit        — folding a finding into an issue that
#               gh issue comment       already names its root cause is the
#                                      outcome this gate steers toward; taxing
#                                      it would penalise the cheap path and
#                                      leave the costly one free
#
# THIS GATE DOES NOT SUPPRESS FINDINGS, AND MUST NEVER BE USED TO.
# /work-issues section 10-0 is explicit that `filed <= closed` is not a target
# and that an unfiled finding is strictly worse than a filed one, because it
# removes the defect from the record while leaving it in the product. Nothing
# here changes the threshold for writing a defect down. It changes only WHERE
# it gets written: into the open issue that already names its root cause, as a
# checklist row, rather than into a new issue number.
#
# If the search genuinely finds nothing, say so on the line and file: that is a
# PASS, and with this repo's backlog at zero it is the expected outcome for
# essentially every filing.
#
# ACCEPTED FORMS (any line in the body starting with `Dup-check:`)
#
#   Dup-check: searched open issues for `overrides reader` + `field drop`
#     -- none covers this root cause
#   Dup-check: searched open issues for `mirror lesson` -- #1799 is the same
#     FLOW but a different source run (it mirrors cdkd's #2125; this mirrors
#     cdk-local's 2026-08-19 run)
#
# No bypass marker, matching non-english-text-gate.sh: running the search and
# writing one line is the entire ask, and a bypass would defeat the gate.
#
# WHY THE VERB REGEXES USE `GATE_GH_CR` AND NOT `GATE_GH_C`
#
# `gh -R <owner/repo> issue create` is the mirror flow's own spelling, and the
# mirror flow is this gate's whole rationale — so missing that shape would leave
# the gate close to inert against the one case it exists for. This repo's
# `GATE_GH_C` absorbs a single `-C <path>` and nothing else.
#
# The fix is SCOPED rather than global: `_command-match.sh` grows a separate
# `GATE_GH_CR` (`-C` plus `-R` / `--repo`, quoted and `=`-joined forms included)
# used ONLY by `GATE_RE_GH_ISSUE_CREATE` and `GATE_RE_GH_API_ISSUE_CREATE`. The
# five gates that reach `gh` through `GATE_RE_GH_PR_*` — verify-pr, ci-green,
# non-english-text, bughunt-clean, branch — keep referencing `GATE_GH_C`, so
# their trigger surface is untouched. Widening THEIRS is a defensible change
# (cdkd made it, after measuring `gh -R owner/repo pr merge` walk past every
# merge gate there), but it is a change to five gates and belongs in its own PR.
#
# Both harnesses pin `gh -R … issue create` as BLOCKING, with a `-C` control and
# a marker-carrying `-R` case beside it, so reverting either regex to
# `GATE_GH_C` fails exactly those cases and points back here.

set -u

__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash issue-dup-check-gate.sh` from inside the hooks dir).
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
# shellcheck source=_command-match.sh
# FAIL CLOSED: a gate that cannot evaluate the command must not wave it
# through. A `|| exit 0` here is what silently disabled ten sibling gates in
# go-to-k/cdkd#2130's review, and what left all eight of THIS repo's gates
# inert for a day (go-to-k/cdk-real-drift#1801) — in both cases an unevaluated
# command looks exactly like one that passed.
if ! . "$__hook_dir/_command-match.sh" 2>/dev/null \
  || ! declare -F gate_matches >/dev/null \
  || ! declare -F gate_segments >/dev/null \
  || ! declare -F gate_target_dir >/dev/null \
  || [ -z "${GATE_RE_GH_ISSUE_CREATE:-}" ] \
  || [ -z "${GATE_RE_GH_API_ISSUE_CREATE:-}" ]; then
  echo "Blocked: .claude/hooks/_command-match.sh is missing, unloadable, or" >&2
  echo "predates GATE_RE_GH_ISSUE_CREATE, so issue-dup-check-gate cannot" >&2
  echo "evaluate the command. Restore the file; do not work around the gate." >&2
  exit 2
fi

input=$(cat 2>/dev/null || true)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
[ "$tool_name" = "Bash" ] || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

# Command-position matching, so a body or comment that merely QUOTES
# `gh issue create` does not arm the gate.
gate_matches "$cmd" "$GATE_RE_GH_ISSUE_CREATE" \
  || gate_matches "$cmd" "$GATE_RE_GH_API_ISSUE_CREATE" || exit 0

# --- 0. resolve the target directory ONCE -----------------------------------
# The opt-in check below and the relative `--body-file` resolution later need
# the same directory and must agree.
#
# `gate_target_dir` stops at the FIRST segment matching the regex it is given,
# and only `cd`s BEFORE that segment count. So the regex must be THIS gate's
# verb, not a bare `gh`: with a bare `gh`,
# `gh issue list --search x && cd <repo> && gh issue create …` — the
# search-then-file chain this gate's own message prescribes — breaks at the
# `gh issue list`, never sees the `cd`, resolves the opt-in against the payload
# cwd, and exits 0. That is the fail-open cdkd's review found in this exact
# gate; the ERE is therefore DERIVED from the shared constants rather than
# hand-rolled, so a local copy cannot drift from what `gate_matches` triggered
# on above.
VERB_ERE="^((${GATE_RE_GH_ISSUE_CREATE#^})|(${GATE_RE_GH_API_ISSUE_CREATE#^}))"
target_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$VERB_ERE" 2>/dev/null || true)
[ -n "$target_dir" ] || target_dir="${hook_cwd:-$PWD}"

# TWO unexpanded-`$VAR` policies in this file, deliberately OPPOSITE, because
# they answer different questions.
#
#   - a `cd "$WT"` before the verb: `gate_target_dir` SKIPS it and keeps the
#     payload cwd (this repo's function differs from cdkd's `cmd_last_cd_target`
#     only in shape here, not in outcome). That is a SCOPE decision — which
#     repo's policy applies — and falling back to the payload cwd is the
#     conservative answer: in an opted-in cwd the gate still fires, and outside
#     one it was never this repo's business.
#   - a `--body-file "$BODY"`: REFUSED below, through its own message arm. That
#     is a RESOLUTION decision — whether the body carries the line — and there
#     is no conservative fallback, because the file that would answer it cannot
#     be opened from command TEXT. Guessing "it probably has the line" is the
#     fail-open this whole family exists to end.
#
# Stated because the pair looks inconsistent at a glance and someone will
# otherwise "fix" one of them into the other.

# --- 0b. repo opt-in --------------------------------------------------------
# A session in this repo regularly files issues in unrelated personal repos,
# where this repo's root-cause-unit discipline is not the local convention and
# a refusal is pure friction. So the gate fires only in a repo that opts in by
# carrying `.markgate.yml` at its root.
#
# The CWD's repo decides, not any `-R <owner/repo>` in the command, and that is
# deliberate: `-R` names where the issue LANDS, while the cwd names which
# project's policy the session is operating under. Section 10-c's cross-repo
# mirror flow is exactly the case that makes the difference matter — it files
# into a sibling FROM this repo's worktree, and those filings are precisely the
# ones this repo wants checked, since that flow is itself the documented
# duplicate generator this gate is aimed at.
#
# Unresolvable cwd, or a cwd outside any repo, means NOT gated. This is a
# discipline aid, not a safety boundary, so a rare miss costs less than a
# refusal in a context that never opted in.
optin_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$optin_top" ] || exit 0
[ -f "$optin_top/.markgate.yml" ] || exit 0

# TWO spellings of the same marker, and the difference is not cosmetic.
#
# In a body FILE the line structure is real, so the marker is anchored at the
# start of a line (optionally as a list item) — which keeps a passing mention
# inside a sentence from satisfying the gate.
#
# In the raw COMMAND there is no such structure: an inline
# `--body 'Bug. Dup-check: …'` is one line, so the same anchor never matches
# and the gate would refuse a body that carries exactly what it asks for. The
# command scan is therefore unanchored. The threat model is FORGETTING to run
# the search, not defeating the gate: someone who types the line without
# searching has already decided to, and no regex reaches that.
# `-i` on the greps rather than a `[Dd]` class, so `Dup-Check:` is accepted:
# refusing a capitalisation variant teaches people the gate is capricious, and
# nothing is gained by the strictness.
MARKER_RE_LINE='^[[:space:]]*([-*+>][[:space:]]+)?dup-check:'
MARKER_RE_LOOSE='dup-check:'

# BOTH scans are scoped to the SEGMENT that is the `gh issue create`, never to
# the whole command, and that scoping is load-bearing rather than tidy.
#
# Unscoped, the gate has a demonstrated FAIL-OPEN in the shape this flow writes
# most: `git commit -F <msg> && gh issue create --body-file <no-marker>` passes,
# because `-F` is `git commit`'s flag as well as gh's short `--body-file`, so
# the extraction reads the COMMIT MESSAGE and finds the marker there. Commit
# messages quote the lines they describe — the commit that introduces this gate
# contains `Dup-check:` in its own body — so the false pass is not exotic. The
# loose inline scan has the same hole for the same reason, in either command
# order.
#
# Every matching segment must carry the marker: a command opening two issues
# must record the search for both.
seg_has_marker() {
  local seg="$1" f

  # inline `--body '…'`: the marker is in the segment text itself.
  if printf '%s' "$seg" | grep -qiE "$MARKER_RE_LOOSE"; then
    return 0
  fi

  while IFS= read -r f; do
    [ -n "$f" ] || continue
    # An unexpanded `$VAR` or a substitution cannot be resolved from command
    # TEXT. Refuse, but through the dedicated message arm below: a bare "check
    # the path" is unclearable when the file does carry the line.
    case "$f" in
      *'$'*|*'`'*) unresolvable_path="$f"; return 1 ;;
    esac
    # A literal `~` in the command string is text, not something to expand — a
    # real tilde would already have been expanded by the shell before gh ran.
    # shellcheck disable=SC2088
    case "$f" in
      /*) ;;
      "~/"*) f="${HOME:-/nonexistent}/${f#\~/}" ;;
      *) f="$target_dir/$f" ;;
    esac
    if [ ! -f "$f" ]; then
      # The file may not exist YET. `heredoc -> file -> --body-file` in ONE
      # command is a legitimate publishing shape, and at PreToolUse time the
      # heredoc has not run. After the segment scoping above, treating that as
      # a miss would cost a false BLOCK on a shape the flow itself produces,
      # which is the worse direction.
      #
      # So fall back to the WHOLE command, with the ANCHORED marker: a heredoc
      # body carries real line structure, so the same line-start rule applies
      # and a passing mention inside a sentence still does not satisfy it. This
      # is the one place a cross-segment read is allowed, and its window is
      # narrow by construction — it opens only when the named body file cannot
      # be read at all.
      if printf '%s' "$cmd" | grep -qiE "$MARKER_RE_LINE"; then
        return 0
      fi
      continue
    fi
    found_body_file=1
    if grep -qiE "$MARKER_RE_LINE" "$f"; then
      return 0
    fi
  # This extraction is a NEAR-COPY of non-english-text-gate.sh's body-file
  # handling in spirit, deliberately not shared: it runs on ONE segment rather
  # than the whole command, it omits a `--notes-file` arm (a release note is not
  # an issue body), and its caller treats an unreadable path as a BLOCK. If you
  # fix a path-extraction bug in either, check the other.
  done < <(printf '%s' "$seg" | perl -0777 -ne '
      while (/--body-file[=\s]+(["\x27]?)([^"\x27\s]+)\1/g) { print "$2\n"; }
      while (/(?:--field|--raw-field|-F)[=\s]+(["\x27]?)body=\@([^"\x27\s]+)\1/g) { print "$2\n"; }
      while (/(?:^|\s)-F[=\s]+(["\x27]?)([^"\x27\s=]+)\1(?=\s|$)/g) { print "$2\n"; }
    ' 2>/dev/null)
  return 1
}

found_body_file=0
unresolvable_path=""
offending=""
while IFS= read -r seg; do
  [[ "$seg" =~ $GATE_RE_GH_ISSUE_CREATE ]] || [[ "$seg" =~ $GATE_RE_GH_API_ISSUE_CREATE ]] || continue
  if ! seg_has_marker "$seg"; then
    offending="$seg"
    break
  fi
done < <(gate_segments "$cmd")

[ -n "$offending" ] || exit 0

if [ -n "$unresolvable_path" ]; then
  {
    echo "Blocked by issue-dup-check-gate: the --body-file path \`$unresolvable_path\`"
    echo "carries an unexpanded variable or substitution, and this gate reads the"
    echo "command TEXT rather than the shell's expansion of it, so it cannot open"
    echo "the file to look for the \`Dup-check:\` line."
    echo ""
    echo "This refuses rather than guessing: there is no conservative fallback for"
    echo "a body it cannot read. Two ways to clear it, both of which leave the gate"
    echo "doing its job:"
    echo ""
    echo "  - pass the path literally:  gh issue create --body-file /abs/path.md"
    echo "  - or carry the line inline: gh issue create --body \"...Dup-check: ...\""
  } >&2
  exit 2
fi

{
  echo "Blocked by issue-dup-check-gate: this \`gh issue create\` body carries no"
  echo "\`Dup-check:\` line, so nothing records that the OPEN issue list was"
  echo "searched for an issue already covering this root cause."
  if [ "$found_body_file" = "0" ]; then
    echo ""
    echo "(No readable --body-file was found in the command either. If you passed"
    echo " one, check the path: an unreadable body file is treated as a miss, not"
    echo " as a pass.)"
  fi
  echo ""
  echo "Run the search first -- search the CONCEPT, not this instance's spelling,"
  echo "because an existing issue was written from a different site and names"
  echo "different symbols:"
  echo ""
  echo "  gh issue list --state open --limit 200 --search '<root-cause concept>' \\"
  echo "    --json number,title"
  echo "  gh issue list --state open --limit 200 --json number,title,body \\"
  echo "    --jq '.[] | select((.body // \"\") | test(\"<shared symbol / call / assumption>\";\"i\"))"
  echo "          | \"\\(.number)\\t\\(.title)\"'"
  echo ""
  echo "  (\`(.body // \"\")\`, not \`.body\`: one body-less issue makes \`test\` abort"
  echo "   the whole jq program and silently costs you the entire window.)"
  echo ""
  echo "On a HIT, do not create -- fold the finding into that issue as a"
  echo "checklist row, which keeps the defect on the record while the open count"
  echo "stays one-per-root-cause:"
  echo ""
  echo "  U=\$(mktemp)   # NOT a fixed /tmp path: parallel lanes share the scratchpad"
  echo "  gh issue view <hit> --json body -q .body > \"\$U\" \\"
  echo "    && [ -s \"\$U\" ] \\"
  echo "    && printf -- '- [ ] <site>: <one line, plus where the evidence is>\\n' >> \"\$U\" \\"
  echo "    && gh issue edit <hit> --body-file \"\$U\""
  echo ""
  echo "  The chaining and the -s test are load-bearing, not style: the redirect"
  echo "  truncates \$U before gh runs, so an unchained recipe whose \`view\` fails"
  echo "  (wrong number, transient error) replaces the issue's WHOLE body with"
  echo "  the single new row -- destroying every previously folded finding through"
  echo "  the very procedure meant to preserve them."
  echo ""
  echo "On a MISS -- with this repo's backlog at zero, the expected outcome --"
  echo "file it, and record the search in the body:"
  echo ""
  echo "  Dup-check: searched open issues for <terms> -- none covers this root cause"
  echo ""
  echo "This gate never asks you to drop a finding. /work-issues section 10-0 is"
  echo "explicit that \`filed <= closed\` is not a target and that an unfiled"
  echo "finding is worse than a filed one. It changes only WHERE the finding is"
  echo "written, so an open issue counts one unresolved root cause rather than"
  echo "one unfixed site."
  echo ""
  echo "Rule: .claude/skills/work-issues/SKILL.md section 5 (\"N sites of one root"
  echo "cause is ONE issue and ONE PR, never N issues\")."
} >&2
exit 2

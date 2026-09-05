#!/usr/bin/env bash
# issue-deferral-criteria-gate.sh — block `gh issue create` when the body's
# `Session-fit: next` line defers the work for a PR-SHAPED reason.
#
# WHY
#
# `Session-fit` answers ONE question: do I finish this in THIS session?
# `.claude/rules/session-report.md`'s own test for it is "before writing
# `Session-fit: next`, NAME the command that verifies the fix", and every answer
# it admits is about the VERIFIER -- it does not exist yet, it is bound to this
# run's live AWS state, it is bound to this host, or you cannot name it (which
# is an unbounded deferral, not a `next`). None of them is about the pull
# request. Splitting work across several PRs is normal, needs no permission and
# costs no session -- a lane can open two PRs in the same hour.
#
# That file also puts the PR cost where it belongs, under the `Effort` scale:
# "`large` = a NEW fixture has to be WRITTEN, or a behavior change needing its
# own PR plus review". Needing its own PR is a COST, and it is measured there.
#
# `.claude/skills/work-issues/references/triage.md` section 3-b already says so
# in this repo, in as many words:
#
#   "And 'it needs its own PR' is NOT a `next` reason. It is a `now` item that
#    gets its own PR. The bar is the SESSION, not the diff [...] Writing
#    'independent review surface' on a `Session-fit` line is the
#    classify-by-MEANS error this section already forbids, arriving through the
#    PR boundary instead of through the work's category."
#
# It was written down and violated anyway. On 2026-09-04 an agent in the sibling
# repo deferred THREE findings in one session on exactly that reasoning
# (go-to-k/cdkd#2587 / go-to-k/cdkd#2588 / go-to-k/cdkd#2590), all three were
# re-classified `Session-fit: now` later the same day, and all three were
# finished in that same session -- so the deferrals bought nothing and cost
# three issue numbers plus the context to re-acquire. The paragraph quoted above
# carries its own instance of the same failure from 2026-09-01, one repo over.
# `.claude/skills/work-issues/references/retro.md` is explicit about what
# happens next: a rule already in the text and violated anyway escalates to a
# MECHANISM. This is that mechanism, ported from cdkd's gate of the same name.
#
# WHAT IT ASKS FOR, AND WHAT IT DELIBERATELY DOES NOT
#
# It does NOT ask for a ritual. A gate that demands a "criteria audit" line in
# the body is satisfiable by boilerplate, and a gate a sentence can satisfy
# measures typing, not thinking. This one refuses the specific defect instead: a
# `next` line whose REASON is PR-shaped. Everything else passes untouched,
# including every legitimate `next` --
#
#   Session-fit: next (not this session) -- no fixture under tests/integration/
#     and no corpus case covers this shape; one has to be written
#   Session-fit: next (not this session) -- the verifier is the shared-name core
#     suite, which needs a global clean window in us-east-1
#   Session-fit: next (not this session) -- blocked on an AWS quota increase
#
# and it never argues with a `Session-fit: now`, whatever that line says.
#
# It is also NOT a filing threshold: nothing here makes a finding harder to
# write down (/work-issues section 10-0 -- an unfiled finding is strictly worse
# than a filed one, which is also why issue-dup-check-gate.sh leaves
# `gh issue edit` / `gh issue comment` alone). It changes one word in one line,
# or -- the outcome it actually steers toward -- it makes you notice that the
# item is a `now`.
#
# TWO CONTRADICTIONS IN THIS REPO'S OWN TEXT, RESOLVED 2026-09-05. Both were
# recorded here unedited when the hook landed -- a gate that quietly rewrites
# the rule it enforces is worse than no gate -- and the maintainer then decided
# them as cdkd did (go-to-k/cdkd#2597 / #2619). Each had blessed a spelling this
# gate refuses: the rule-offers-two-answers defect the gate exists for.
#
#   1. `.claude/skills/work-issues/references/implement.md` read "A sweep that
#      would make the PR unreviewable is a genuine `next`", and `unreviewable`
#      is in this gate's vocabulary, so a body citing it verbatim was refused.
#      It now reads "A sweep whose residue carries its OWN verification is a
#      genuine `next`" -- same umbrella-and-closed-sites requirement, with
#      review size named as the SIGNAL and the deferrable thing under it named
#      as verification the residue needs.
#   2. `.claude/rules/session-report.md` puts "a behavior change needing its own
#      PR plus review" under `Effort: large`, which is CORRECT -- then its
#      calibration paragraph listed "above all review of a larger diff, which
#      grows superlinearly" as a third thing to "defer on": the PR-shaped
#      criterion arriving through the back door inside the paragraph that had
#      just placed it correctly. That clause is now a following sentence -- the
#      cost is real, it argues for SPLITTING the PR rather than ending the
#      session, and it belongs under `Effort`. The defer list keeps WRITING a
#      new fixture and a run that FAILS.
#
# The gate follows triage.md section 3-b and the `Effort: large` placement,
# the passages written to settle the question, and all three repos running this
# skill now answer it identically. The bypass below stays for the case the gate
# cannot see (a body quoting PR-shaped reasoning to argue AGAINST it).
#
# WHAT IT CATCHES, AND WHAT NO CLOSED LIST EVER WILL
#
# Measured against the three motivating issues as they were actually filed
# (`gh issue view <n> --json body -q .body`, run in cdkd 2026-09-05):
#
#   go-to-k/cdkd#2590   exit 2   "it wants its own PR and review"
#   go-to-k/cdkd#2587   exit 0   "a fixture redesign plus its own real-AWS run
#                                 and review round"
#   go-to-k/cdkd#2588   exit 0   "a separate decision with its own blast radius
#                                 across future PRs"
#
# ONE of the three. That is not a defect to patch by adding `own .* review
# round` and `own blast radius`: a third spelling in a third round is the signal
# to change INSTRUMENT rather than to chase one more phrase. The two misses
# reason about a PR without ever making a PR-shaped CLAIM this vocabulary can
# recognise, and no closed list ever will.
#
# And measured over THIS repo's whole corpus, 2026-09-05 -- a rate needs its
# PREDICATE, because three plausible ones give three denominators:
#
#   corpus: `gh issue list -R go-to-k/cdk-real-drift --state all --limit 4000
#            --json number,body`  ->  661 issues
#   anchored `Session-fit:` FIELD line whose value is `next`   32 bodies
#   bare `Session-fit: next` substring anywhere                32 bodies
#   any prose mention of `Session-fit`                         34 bodies
#   replayed through this hook via --body-file, of the 32:      5 blocked
#                                        (#1803 #1825 #1845 #1858 #1863)
#
# 5/32 is the CHEAP-spelling share, not the gate's accuracy: the other 27
# `next`s are legitimate deferrals the gate is supposed to pass. The gate makes the CHEAP, REUSABLE
# spelling loud at the moment of filing; the prose in triage.md section 3-b is
# what addresses reasoning that never says "PR". Neither alone is the mechanism.
#
# WHAT IS AND IS NOT GATED
#
#   gated:      gh issue create   -- the site where a deferral is FIRST decided
#               gh api repos/<o>/<r>/issues -- the same mint through REST
#   not gated:  gh issue edit     -- re-classification is the outcome this gate
#               gh issue comment     wants; taxing it would penalise the fix
#
# Same split, and the same reasoning, as issue-dup-check-gate.sh. Repo opt-in is
# `.markgate.yml` at the resolved cwd's repo root, so filing into an unrelated
# personal repo is never refused. A foreign `-R <owner/repo>` is NOT refused
# here, matching issue-dup-check-gate.sh and unlike the gates that audit
# repo-specific state: `-R` names where the issue LANDS while the cwd names
# whose policy the session is operating under, and the cross-repo mirror flow
# files into a sibling from here.
#
# KNOWN LIMITS, all named rather than left to be rediscovered:
#
#   - AN INLINE `--body` HAS NO LINE STRUCTURE, even a multi-line one. The
#     shared matcher's `gate_segments` joins a quoted span's newlines into
#     spaces (measured: `gate_segments "gh issue create --body 'a<NL>b'"` prints
#     `--body 'a b'`), so the reason runs to the end of the whole body and a
#     PR-shaped phrase belonging to a LATER field is read as part of it.
#     Measured on this gate, same body both ways:
#
#       --body 'Session-fit: next ... quota increase<NL>Effort: large (L) --
#         a behavior change needing its own PR plus review'      rc=2 (FALSE)
#       the identical text via --body-file                        rc=0
#
#     It over-approximates -- a loud, clearable block, never a silent pass --
#     and the heredoc -> file -> `--body-file` shape this repo mandates does not
#     have it. Both directions are pinned by the harness so the limit stays a
#     measured fact rather than a surprise.
#   - A one-call body written to a path by something other than a heredoc
#     (`printf > f`, `python3 -c ... > f`) cannot be extracted from the command
#     text, so the scan falls back to what is on disk -- the PREVIOUS body. The
#     heredoc shape IS closed (see `segment_body_text` arm 1); this remainder is
#     the same limit issue-dup-check-gate.sh carries.
#   - The vocabulary is a closed list, so a reworded PR-shaped reason passes --
#     measured at two of its own three motivating issues, above.
#   - A PR-shaped reason quoted INLINE, in running prose, to argue against it
#     still needs the bypass. A quote inside a ``` fence does not: fenced blocks
#     are stripped before the scan.
#
# ESCAPE HATCH: CDKRD_SKIP_DEFERRAL_CRITERIA_GATE=1, honored from the hook's own
# process env AND from a leading assignment in the COMMAND TEXT -- an agent's
# Bash call cannot populate a PreToolUse hook's environment, so the text channel
# is the only one the refusal can advertise (an advertised remediation that
# silently does nothing is worse than none). The text check runs over a command
# with heredoc bodies blanked and quoted spans emptied, so a QUOTED mention
# inside a body bypasses nothing -- see `bypass_in_command_text`. cdkd does this
# with the shared matcher's `strip_noncommand_spans`; this repo's
# `_command-match.sh` has no such helper, so the narrow version lives here.

set -u

__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash issue-deferral-criteria-gate.sh` from inside the hooks dir).
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."

# The shared matcher lives at `_command-match.sh` here and at
# `lib/command-match.sh` in cdkd. Try both rather than forking the file: the two
# spellings are the ONLY difference between the copies, and a fork is how they
# drift. FAIL CLOSED -- a gate that cannot evaluate the command must not wave it
# through; `|| exit 0` here is what silently disabled ten sibling gates
# (go-to-k/cdkd#2130 review).
# shellcheck source=_command-match.sh
if ! . "$__hook_dir/_command-match.sh" 2>/dev/null \
  && ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null; then
  echo "Blocked: the shared command matcher (_command-match.sh or" >&2
  echo "lib/command-match.sh) is missing or unloadable, so" >&2
  echo "issue-deferral-criteria-gate cannot evaluate the command." >&2
  echo "Restore the file; do not work around the gate." >&2
  exit 2
fi
if ! declare -F gate_matches >/dev/null \
  || ! declare -F gate_segments >/dev/null \
  || [ -z "${GATE_RE_GH_ISSUE_CREATE:-}" ]; then
  echo "Blocked: the shared command matcher loaded but is missing gate_matches," >&2
  echo "gate_segments or GATE_RE_GH_ISSUE_CREATE, so" >&2
  echo "issue-deferral-criteria-gate cannot evaluate the command." >&2
  exit 2
fi

input=$(cat 2>/dev/null || true)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
[ "$tool_name" = "Bash" ] || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

[ "${CDKRD_SKIP_DEFERRAL_CRITERIA_GATE:-}" = "1" ] && exit 0

# Command-position matching, so a body or comment that merely QUOTES
# `gh issue create` does not arm the gate.
GATE_RE_API_MINT="${GATE_RE_GH_API_ISSUE_CREATE:-}"
gate_matches "$cmd" "$GATE_RE_GH_ISSUE_CREATE" \
  || { [ -n "$GATE_RE_API_MINT" ] && gate_matches "$cmd" "$GATE_RE_API_MINT"; } || exit 0

# The bypass's TEXT channel, in command position only.
#
# `gate_segments` cannot serve here: `gate_strip_prefix` removes leading env
# assignments from every segment, so the assignment this looks for is gone by
# the time a segment is printed. So the command is normalised locally instead --
# heredoc bodies blanked (the body of `cat > f <<EOF ... EOF` is DATA, and a
# line in it starting with the assignment must not disarm the gate) and quoted
# spans emptied (an inline `--body "... CDKRD_SKIP_...=1 ..."` likewise) -- and
# the assignment is then required at the start of a command: string start, a
# line start, or immediately after `|`, `;`, `&`, `&&` or `(`.
bypass_in_command_text() {
  CMD="$cmd" perl -0777 -e '
    my $c = $ENV{CMD};
    my @lines = split /\n/, $c, -1;
    my @out;
    my $i = 0;
    while ($i <= $#lines) {
      my $l = $lines[$i];
      push @out, $l;
      # `<<<` (a here-STRING) is not a heredoc: the char after `<<` is `<`,
      # which the delimiter class below cannot match, so it falls through.
      if ($l =~ /(<<-?)\s*(["\x27]?)([A-Za-z_][A-Za-z0-9_]*)\2/) {
        my $dash  = ($1 eq "<<-");
        my $delim = $3;
        my $j = $i + 1;
        while ($j <= $#lines) {
          my $probe = $lines[$j];
          # `<<-` strips leading TABS only. Stripping all whitespace would let
          # an indented `  EOF` inside the body end the blanking early.
          $probe =~ s/^\t+// if $dash;
          last if $probe eq $delim;
          push @out, "";
          $j++;
        }
        push @out, $lines[$j] if $j <= $#lines;
        $i = $j + 1;
        next;
      }
      $i++;
    }
    my $s = join("\n", @out);
    $s =~ s/"(?:[^"\\]|\\.)*"/""/gs;
    $s =~ s/\x27[^\x27]*\x27/\x27\x27/gs;
    exit 0 if $s =~ /(?:\A|\n|[|;&(]|&&)\s*CDKRD_SKIP_DEFERRAL_CRITERIA_GATE=1(?:\s|\z)/;
    exit 1;
  ' 2>/dev/null
}
bypass_in_command_text && exit 0

# --- resolve the target directory ONCE --------------------------------------
# Both the opt-in check and the relative `--body-file` resolution need the same
# directory and must agree. `cmd_last_cd_target` is guarded on `declare -F`:
# this repo's `_command-match.sh` does not carry it, so the gate degrades to the
# payload cwd rather than failing to load. When it IS present the verb ERE is
# DERIVED from the shared constant rather than hand-rolled -- a local copy drops
# GATE_FLAGS' quoted alternative, so `gh -C "/a b" issue create` matches no verb
# and a TRAILING `cd` steers the lookup instead.
target_dir="${hook_cwd:-$PWD}"
if declare -F cmd_last_cd_target >/dev/null 2>&1; then
  _cd_target=$(cmd_last_cd_target "$cmd" "$target_dir" \
    "${GATE_RE_GH_ISSUE_CREATE#^}" 2>/dev/null || true)
  [ -n "$_cd_target" ] && target_dir="$_cd_target"
fi

# --- repo opt-in ------------------------------------------------------------
optin_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$optin_top" ] || exit 0
[ -f "$optin_top/.markgate.yml" ] || exit 0

# --- the PR-shaped reason vocabulary ----------------------------------------
# Deliberately a SHORT closed list of the spellings this failure actually used,
# not an attempt to enumerate every way a person could say "PR". The threat
# model is an agent reaching for the cheap justification it has seen before, not
# one evading a regex: someone who rewords the reason to dodge this has had to
# read the criteria to do it, which is the entire ask.
#
# `prs?` is bounded by `([^[:alnum:]]|$)` rather than `\b` -- `\b` is a GNU
# extension that BSD regcomp does not carry, so on macOS it would match nothing
# and the gate would be inert.
PR_SHAPE_RE='(own|separate)[[:space:]]+prs?([^[:alnum:]]|$)'
PR_SHAPE_RE="$PR_SHAPE_RE"'|shar(e|es|ing)[[:space:]]+((a|an|the|its|their)[[:space:]]+)?prs?([^[:alnum:]]|$)'
PR_SHAPE_RE="$PR_SHAPE_RE"'|independent[[:space:]]+review[[:space:]]+surface'
PR_SHAPE_RE="$PR_SHAPE_RE"'|unreviewable'
PR_SHAPE_RE="$PR_SHAPE_RE"'|own[[:space:]]+review([^[:alnum:]]|$)'

OFFENDING_REASON=""

pr_shaped() { # <reason text> -> 0 when it is PR-shaped, and records it
  [[ $1 =~ $PR_SHAPE_RE ]] || return 1
  OFFENDING_REASON=$(printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  return 0
}

# Scan a body for a `Session-fit: next` line whose reason is PR-shaped.
#
# The reason continues onto WRAPPED lines, and that is not a refinement: an
# issue body written to 76 columns puts "needs its own PR" on the line AFTER
# `Session-fit: next (not this session) -- this touches a different subsystem
# and`, and a line-only scan would read the first half and pass. A continuation
# ends at a blank line, at the next `Key:` field (`Severity:` / `Effort:` /
# `Estimate:` / `Dup-check:`, list-prefixed or not), at a LIST ITEM, or at a
# markdown heading -- so a wrapped reason is read whole while the SIBLING
# fields, which are nobody's reason, are not folded in. CLAUDE.md's own template
# writes the four fields as a nested bullet list, so the LIST-ITEM boundary is
# the common case here, not an edge one:
#
#   - Session-fit: next (not this session) -- blocked on an AWS quota increase
#   - Severity: low -- internal tidiness
#
# without it the `Severity` bullet folds into the reason.
#
# FENCED CODE BLOCKS are removed before the scan. A body arguing ABOUT this rule
# quotes the refused line to do it, and quoting it inside a ```text fence is how
# a markdown body says "this is an exhibit, not an assertion". Without the strip
# the FIRST `Session-fit:` match wins and `break`s, so a body whose own
# classification is `Session-fit: now` is refused over the exhibit above it --
# and reaching for the bypass is exactly what a body of that shape should not
# have to do.
#
# A `**Session-fit:**` / `**Session-fit**:` spelling is read like the bare one.
#
# `nocasematch` is enabled for the duration of this function and restored on the
# way out rather than set once at the top of the file, and that scoping is
# load-bearing: the shared matcher's `gate_matches` is a `[[ =~ ]]` too, so a
# file-wide `nocasematch` would silently widen EVERY gate verb this hook matches
# (`GH ISSUE CREATE` would arm it). It is used instead of a `[Ss]`-class regex
# or a `tr` pass because the reason has to be REPORTED BACK in its original
# casing, and lowercasing to match would mean carrying two copies of every line.
scan_text() { # <body text> -> 0 when the body carries a PR-shaped deferral
  local text="$1" line rest active=0 reason="" rc=1 nocase_was=0 fence=0 fence_mark=""
  # A fence line is ``` or ~~~, indented or not. A fence OPENS only when its own
  # closer appears later, and closes only on the SAME marker. Both halves are
  # load-bearing: latching on any opener with no look-ahead makes an UNCLOSED
  # fence blank every remaining line (fail open), and ignoring the marker type
  # lets a ``` line inside a ~~~ block close it early.
  local fence_open_re='^[[:space:]]*(```|~~~)'
  # `[*_]*` on both sides of the colon accepts `**Severity:**` and
  # `**Severity**:`. Keeping the boundary tests in sync with the key spelling
  # `session_fit_re` accepts is load-bearing: a body that bolds one field bolds
  # them all, so a bold-blind boundary would fold the whole field block in.
  local key_re='^[[:space:]]*([-*+>][[:space:]]+)?[*_]*[A-Za-z][A-Za-z_-]*[*_]*:'
  local item_re='^[[:space:]]*([-*+]|[0-9]+[.)])[[:space:]]+'
  local session_fit_re='session-fit[*_]*:[*_]*(.*)$'
  case "$(shopt -p nocasematch)" in *-s*) nocase_was=1 ;; esac
  shopt -s nocasematch
  # Buffered into an array rather than streamed, because the fence opener has to
  # look AHEAD for its own closer. Built with a read loop, not `mapfile` -- the
  # hook harnesses run under macOS bash 3.2, where `mapfile` does not exist and
  # would be a runtime error, which for a gate is a silent pass.
  local -a lines=()
  local n=0
  while IFS= read -r line; do
    lines[$n]="$line"
    n=$((n + 1))
  done <<EOF
$text
EOF
  local i=0 j
  while [ "$i" -lt "$n" ]; do
    line="${lines[$i]}"
    i=$((i + 1))
    if [[ $line =~ $fence_open_re ]]; then
      local mark="${BASH_REMATCH[1]}" closes=0
      if [ "$fence" = "1" ]; then
        if [ "$mark" = "$fence_mark" ]; then fence=0; fence_mark=""; fi
        continue
      fi
      j=$i
      while [ "$j" -lt "$n" ]; do
        case "${lines[$j]}" in
          *"$mark"*)
            if [[ ${lines[$j]} =~ ^[[:space:]]*"$mark" ]]; then closes=1; break; fi
            ;;
        esac
        j=$((j + 1))
      done
      if [ "$closes" = "1" ]; then
        fence=1
        fence_mark="$mark"
        # A fenced block starts a new markdown block exactly like a heading
        # does, so it also closes an open continuation.
        if [ "$active" = "1" ]; then
          active=0
          if pr_shaped "$reason"; then rc=0; break; fi
        fi
        continue
      fi
      # Not a real fence -- fall through and treat it as ordinary text.
    fi
    if [ "$fence" = "1" ]; then
      continue
    fi
    if [ "$active" = "1" ]; then
      if [[ $line =~ ^[[:space:]]*$ ]] \
        || [[ $line =~ $key_re ]] \
        || [[ $line =~ $item_re ]] \
        || [[ $line =~ ^[[:space:]]*\# ]]; then
        active=0
        if pr_shaped "$reason"; then rc=0; break; fi
      else
        reason="$reason $line"
      fi
    fi
    if [[ $line =~ $session_fit_re ]]; then
      # A second `Session-fit:` closes whatever the first one opened.
      if [ "$active" = "1" ]; then
        if pr_shaped "$reason"; then rc=0; break; fi
      fi
      rest="${BASH_REMATCH[1]}"
      # ONLY `next` is gated. `now` is never refused, whatever its reason says
      # -- an agent talking itself INTO finishing the work needs no supervision.
      # A line stating neither token (an old packed body, a `Session-fit` in
      # prose) is not a deferral decision this gate can read, so it passes.
      if [[ $rest =~ ^[[:space:]]*next([^[:alpha:]]|$) ]]; then
        reason="$rest"
        active=1
      else
        active=0
        reason=""
      fi
    fi
  done
  if [ "$rc" != "0" ] && [ "$active" = "1" ]; then
    pr_shaped "$reason" && rc=0
  fi
  [ "$nocase_was" = "1" ] || shopt -u nocasematch
  return "$rc"
}

# --- heredoc extraction -----------------------------------------------------
# `cmd_writes` and `cmd_replaces` answer DIFFERENT questions and must not be
# collapsed: `>>` / `tee -a` APPEND, so what is on disk is the FIRST HALF of the
# body being submitted and still has to be scanned; only `>` / `tee` supersede
# it.
cmd_writes() { # <path as the command spells it>
  CMD="$cmd" TARGET="$1" perl -0777 -e '
    my $c = $ENV{CMD};
    my $t = quotemeta($ENV{TARGET});
    # The trailing class covers the TIGHT spellings -- `>f<<EOF`, `>f;`, `>f&&`
    # -- which a `(?:\s|$)` terminator misses, and `>f<<EOF` is the very shape
    # this exists for.
    exit 0 if $c =~ /(?:>>?|\btee\b(?:\s+-a)?)\s*(["\x27]?)$t\1(?:[\s;&|)<]|$)/;
    exit 1;
  ' 2>/dev/null
}

cmd_replaces() { # <path as the command spells it>
  CMD="$cmd" TARGET="$1" perl -0777 -e '
    my $c = $ENV{CMD};
    my $t = quotemeta($ENV{TARGET});
    exit 0 if $c =~ /(?:(?<!>)>(?!>)|\btee\b(?!\s+-a\b))\s*(["\x27]?)$t\1(?:[\s;&|)<]|$)/;
    exit 1;
  ' 2>/dev/null
}

# EVERY heredoc body that writes the path, in order. Both orders
# (`cat > f <<EOF` and `cat <<EOF > f`), quoted and unquoted delimiters, and
# `<<-`, whose terminator may be indented by TABS only. The STATUS, not the
# output, reports whether a heredoc was found: an empty heredoc body is legal
# and prints nothing.
heredoc_bodies_for() { # <path as the command spells it>
  CMD="$cmd" TARGET="$1" perl -0777 -e '
    my $c = $ENV{CMD};
    my $t = quotemeta($ENV{TARGET});
    my @lines = split /\n/, $c, -1;
    my @out;
    my $found = 0;
    for (my $i = 0; $i <= $#lines; $i++) {
      my $l = $lines[$i];
      next unless $l =~ /(?:>>?|\btee\b(?:\s+-a)?)\s*(["\x27]?)$t\1(?:[\s;&|)<]|$)/;
      next unless $l =~ /(<<-?)\s*(["\x27]?)([A-Za-z_][A-Za-z0-9_]*)\2/;
      my $dash  = ($1 eq "<<-");
      my $delim = $3;
      $found = 1;
      my $j = $i + 1;
      while ($j <= $#lines) {
        my $probe = $lines[$j];
        $probe =~ s/^\t+// if $dash;
        last if $probe eq $delim;
        push @out, $lines[$j];
        $j++;
      }
      # Resume AFTER this body and do NOT stop at the first: one path can be
      # written by more than one heredoc in one command.
      $i = $j;
    }
    print join("\n", @out), "\n" if @out;
    exit($found ? 0 : 1);
  ' 2>/dev/null
}

# Each matcher is offered BOTH spellings of the path -- the one the command
# writes and the one it hands to gh -- because they need not be the same string
# (`cat > /abs/b.md ... --body-file b.md`), and either half alone leaves that
# shape unscanned. The short-circuit on equality saves a perl spawn on the
# common absolute spelling.
cmd_writes_either() { # <raw spelling> <resolved path>
  cmd_writes "$1" && return 0
  [ "$1" = "$2" ] && return 1
  cmd_writes "$2"
}
cmd_replaces_either() { # <raw spelling> <resolved path>
  cmd_replaces "$1" && return 0
  [ "$1" = "$2" ] && return 1
  cmd_replaces "$2"
}
heredoc_bodies_either() { # <raw spelling> <resolved path>
  heredoc_bodies_for "$1" && return 0
  [ "$1" = "$2" ] && return 1
  heredoc_bodies_for "$2"
}

# The BODY text of ONE segment, in descending order of specificity:
#
#   1. the HEREDOC BODY that this command writes to the named `--body-file`,
#      when it writes one -- this is the arm that closes the fail-open
#   2. the contents of the file at that path, unless arm 1 fired AND the command
#      TRUNCATES the path (an APPEND leaves the existing content as the first
#      half of the submitted body)
#   3. the WHOLE command, when such a path was named, cannot be read, and no
#      heredoc writes it -- a `printf > f` body, or an unresolvable `$VAR` path
#   4. the inline `--body` value, plus the `-f`/`--field` `body=` forms the REST
#      mint uses, quote-aware so a multi-word body stays one value
#
# ARM 1 IS NOT AN OPTIMISATION. The hook runs BEFORE the command, so in the
# one-call `heredoc -> file -> --body-file` shape this repo mandates, the path
# either does not exist yet or still holds what a PREVIOUS call left there. A
# file-first read judges that previous body, so a stale-but-clean file makes the
# gate INERT against the body actually being submitted. Sibling
# issue-classification-label-gate.sh here still has the file-first shape and
# therefore still has that window; this gate does not.
#
# There is deliberately NO last-resort "scan the whole segment" arm, which is
# where this diverges from issue-classification-label-gate.sh. That gate must
# find a value SOMEWHERE or its labels mean nothing; this one objects to content
# it FINDS, so a fallback that folds `--title` and `--label` text in can only
# manufacture false blocks -- a title reading `Session-fit: next handling for
# its own PR` is a title about the rule, not a deferral.
segment_body_text() { # <segment>
  local seg="$1" f f_raw out="" hd have_hd
  while IFS= read -r f_raw; do
    [ -n "$f_raw" ] || continue
    # An unexpanded `$VAR` or a substitution cannot be resolved from command
    # TEXT. Treat it like an unreadable path and fall back to the whole command
    # rather than refusing: unlike dup-check, this gate demands nothing be
    # PRESENT, so "cannot read" is not evidence of a violation.
    case "$f_raw" in
      *'$'*|*'`'*) out="$out
$cmd"; continue ;;
    esac
    # BOTH spellings are kept. `f` is the path to READ; `f_raw` is the path as
    # the command SPELLS it, and the write-detection above matches against the
    # RAW COMMAND TEXT -- handed only the resolved absolute path it matches
    # nothing whenever the command writes a RELATIVE or `~/` path.
    #
    # A literal `~` in the command string is text, not something to expand -- a
    # real tilde would already have been expanded by the shell before gh ran.
    # shellcheck disable=SC2088
    f="$f_raw"
    case "$f" in
      /*) ;;
      "~/"*) f="${HOME:-/nonexistent}/${f#\~/}" ;;
      *) f="$target_dir/$f" ;;
    esac
    hd=""
    have_hd=0
    if [ ! -r "$f" ] || cmd_writes_either "$f_raw" "$f"; then
      hd=$(heredoc_bodies_either "$f_raw" "$f") && have_hd=1
    fi
    if [ "$have_hd" = "1" ]; then
      out="$out
$hd"
      # Only a TRUNCATING write supersedes what is on disk. After an append the
      # file is still the first half of the submitted body.
      if cmd_replaces_either "$f_raw" "$f"; then
        continue
      fi
    fi
    if [ -r "$f" ]; then
      out="$out
$(cat "$f" 2>/dev/null || true)"
    elif [ "$have_hd" != "1" ]; then
      out="$out
$cmd"
    fi
  # `body=@` is matched FIRST so an `-F body=@path` is not also read as a bare
  # `-F path`. The bare `-F <path>` arm is not optional: `-F` is gh's short
  # `--body-file`.
  done < <(printf '%s' "$seg" | perl -0777 -ne "$GATE_PERL_WORD"'
      # The value class is `$GW` from the SHARED `GATE_PERL_WORD` prelude in
      # _command-match.sh, not a local `(["\x27]?)([^"\x27\s]+)\1`. That local
      # shape ENUMERATES where a quote may sit instead of taking one shell WORD,
      # and it could not span a QUOTED PATH CONTAINING A SPACE, a
      # BACKSLASH-ESCAPED one, or the GLUED `-F<path>` gh accepts -- each
      # measured here as a FAIL-OPEN before this change (rc=0 where the plain
      # spelling gave 2). Ported from go-to-k/cdkd#2639; the full per-shape
      # table lives in the header of that constant, in _command-match.sh.
      # (No apostrophe anywhere in this comment: the whole perl program is a
      # SHELL single-quoted string, so one would end it and hand the rest to
      # bash as code.)
      while (/(?:--field|--raw-field|-F)[=\s]*($GW)/g) {
        my $v = gate_unq($1);
        next unless $v =~ s/^body=\@//;
        print "$v\n";
      }
      while (/--body-file[=\s]+($GW)/g) { print gate_unq($1), "\n"; }
      while (/(?:^|\s)-F[=\s]*($GW)(?=[\s;&|)]|$)/g) {
        my $v = gate_unq($1);
        next if $v =~ /^\w+=/;
        print "$v\n";
      }
    ' 2>/dev/null)

  if [ -n "$out" ]; then
    printf '%s' "$out"
    return 0
  fi

  printf '%s' "$seg" | perl -0777 -ne '
    while (/(?:^|\s)--body[=\s]+("(?:[^"\\]|\\.)*"|\x27[^\x27]*\x27|\S+)/g) {
      my $v = $1;
      $v =~ s/^["\x27]//; $v =~ s/["\x27]$//;
      print "$v\n";
    }
    while (/(?:^|\s)(?:-f|--field|--raw-field)[=\s]+("(?:[^"\\]|\\.)*"|\x27[^\x27]*\x27|\S+)/g) {
      my $v = $1;
      $v =~ s/^["\x27]//; $v =~ s/["\x27]$//;
      next unless $v =~ s/^body=//;
      next if $v =~ /^\@/;
      print "$v\n";
    }' 2>/dev/null
}

# EVERY scan is scoped to the SEGMENT that is the `gh issue create`, never to
# the whole command, and the scoping is load-bearing in BOTH directions here.
# `-F` is `git commit`'s flag as well as gh's short `--body-file`, so an
# unscoped extraction reads the COMMIT MESSAGE -- and commit messages quote the
# lines they describe (the commit introducing this gate quotes a PR-shaped
# `Session-fit: next` line as the thing it refuses). Unscoped, that commit's own
# `git commit -F <msg> && gh issue create --body-file <clean>` would have been
# refused over text that is not the issue body at all.
offending_seg=""
# `GATE_PERL_WORD` is one shared literal that several BLOCKING gates
# interpolate, and every extraction runs `perl ... 2>/dev/null`. A prelude
# that is present but does NOT COMPILE therefore produces no output, no
# stderr and no exit-code change -- the gate extracts nothing and PASSES
# what it exists to refuse. Measured in cdkd: one broken literal disarmed
# four gates at once. A non-empty test cannot see that, so probe it
# FUNCTIONALLY, once, after arming, and at TOP LEVEL -- the extraction
# helpers run inside `$( )`, where `exit 2` ends only the substitution
# subshell (measured: an in-function guard PRINTED its refusal and the
# hook still returned 0).
gate_perl_word_or_die issue-deferral-criteria-gate || exit 2

while IFS= read -r seg; do
  if ! gate_matches "$seg" "$GATE_RE_GH_ISSUE_CREATE"; then
    if [ -z "$GATE_RE_API_MINT" ] || ! gate_matches "$seg" "$GATE_RE_API_MINT"; then
      continue
    fi
  fi
  body_text=$(segment_body_text "$seg")
  [ -n "$body_text" ] || continue
  if scan_text "$body_text"; then
    offending_seg="$seg"
    break
  fi
done < <(gate_segments "$cmd")

[ -n "$offending_seg" ] || exit 0

{
  echo "Blocked by issue-deferral-criteria-gate: this \`gh issue create\` body"
  echo "defers the work with a PR-SHAPED reason:"
  echo ""
  echo "  Session-fit: ${OFFENDING_REASON}"
  echo ""
  echo "PR shape is not a \`Session-fit\` criterion. \`Session-fit\` answers one"
  echo "question -- do I finish this in THIS session? -- and splitting the work"
  echo "across several PRs is normal, needs no permission, and costs no session:"
  echo "one lane can open two PRs in the same hour. Decide the SPLIT on review"
  echo "surface; decide \`Session-fit\` on the criteria this repo states."
  echo ""
  echo ".claude/rules/session-report.md's test, in its own words: \"Before"
  echo "writing \\\`Session-fit: next\\\`, NAME the command that verifies the"
  echo "fix\" -- and every answer it admits is about the VERIFIER, not the PR:"
  echo ""
  echo "  - \"it does NOT EXIST yet and writing it is most of the work -- the one"
  echo "    case where \\\`next\\\` is unambiguously right\" (no fixture under"
  echo "    tests/integration/ and no case under tests/corpus/ covers the shape)"
  echo "  - \"bound to THIS run's live AWS state [...] or to credentials a fresh"
  echo "    session may not hold\" -- e.g. the shared-name core suite, which needs"
  echo "    a global clean window in us-east-1"
  echo "  - \"bound to THIS host (CPU architecture, an installed toolchain, a"
  echo "    pulled container image)\""
  echo "  - \"you cannot name it at all, which is an unbounded deferral\" -- that"
  echo "    one is NOT a \`next\`; do it now, or say why the fix would be"
  echo "    unverifiable"
  echo ""
  echo "And: \"RUNNING an existing verification is not a reason to defer\" -- a"
  echo "fix riding a fixture this session already runs costs zero."
  echo ""
  echo "Two ways out, both of which leave the gate doing its job:"
  echo ""
  echo "  - re-classify: \`Session-fit: now\` -- and do it in this session; the"
  echo "    review cost of a bigger diff is real, but it belongs under \`Effort:"
  echo "    large (L)\` (\"a behavior change needing its own PR plus review\"),"
  echo "    which is where .claude/rules/session-report.md already puts it"
  echo "  - re-state the real reason, if one of the criteria above genuinely"
  echo "    fires, and NAME the next session's verification command beside it"
  echo ""
  echo "Measured 2026-09-04 in the sibling repo: three findings were deferred in"
  echo "one session on this exact reasoning (go-to-k/cdkd#2587 /"
  echo "go-to-k/cdkd#2588 / go-to-k/cdkd#2590); all three were re-classified"
  echo "\`now\` and finished in that same session."
  echo ""
  echo "Deliberate exception (a body QUOTING PR-shaped reasoning INLINE, in"
  echo "prose, in order to argue against it -- a quote inside a \`\`\` fenced"
  echo "block needs no bypass; fenced blocks are not scanned):"
  echo ""
  echo "  CDKRD_SKIP_DEFERRAL_CRITERIA_GATE=1 gh issue create ..."
  echo ""
  echo "Rules: .claude/rules/session-report.md -> \"Before writing"
  echo "\\\`Session-fit: next\\\`, NAME the command that verifies the fix\";"
  echo ".claude/skills/work-issues/references/triage.md section 3-b (\"'it needs"
  echo "its own PR' is NOT a \\\`next\\\` reason\")."
} >&2
exit 2

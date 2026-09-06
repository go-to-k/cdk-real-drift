#!/usr/bin/env bash
# Smoke test for _command-match.sh, the shared segment matcher every gate uses.
# Run from the repo root: `bash .claude/hooks/_command-match.test.sh`
#
# The cases are the spellings go-to-k/cdk-real-drift#1803 measured running UNGATED
# against the old line-start-anchored regexes, plus the negatives that must stay
# out (a verb inside a string, a different verb, a lookalike).

set -u

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"

pass=0; fail=0

# want_match <expect 0|1> <label> <command> <regex>
want_match() {
  local want="$1" label="$2" cmd="$3" re="$4" got
  if gate_matches "$cmd" "$re"; then got=0; else got=1; fi
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want %s got %s) :: %s\n' "$label" "$want" "$got" "$cmd"
  fi
}

# want_dir <expected> <label> <command> <fallback> <regex>
want_dir() {
  local want="$1" label="$2" cmd="$3" fallback="$4" re="$5" got
  got=$(gate_target_dir "$cmd" "$fallback" "$re")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n  want: %s\n  got:  %s\n' "$label" "$want" "$got"
  fi
}

C="$GATE_RE_GIT_COMMIT"
P="$GATE_RE_GIT_PUSH"
M="$GATE_RE_GH_PR_MERGE"

# --- the spellings that used to bypass ---------------------------------------
want_match 0 "bare git commit"              'git commit -m x' "$C"
want_match 0 "git add -A && git commit"     'git add -A && git commit -m x' "$C"
want_match 0 "cd && git commit"             'cd /w/t && git commit -m x' "$C"
want_match 0 "cd ; git commit"              'cd /w/t; git commit -m x' "$C"
want_match 0 "no spaces around &&"          'cd /w/t&&git commit -m x' "$C"
want_match 0 "subshell"                     '(cd /w/t && git commit -m x)' "$C"
want_match 0 "leading env assignment"       'GIT_EDITOR=true git commit -m x' "$C"
want_match 0 "env wrapper"                  'env git commit -m x' "$C"
want_match 0 "git -C <path> commit"         'git -C /w/t commit -m x' "$C"
want_match 0 "git -c k=v commit"            'git -c user.name=t commit -m x' "$C"
want_match 0 "three-segment chain"          'vp run check && git add -A && git commit -m x' "$C"
want_match 0 "pipe into another command"    'git commit -m x | tee log' "$C"
want_match 0 "gh pr merge after a push"     'git push && gh pr merge 1 --squash' "$M"
want_match 0 "git push in second position"  'echo go && git push origin HEAD' "$P"

# --- negatives ----------------------------------------------------------------
want_match 1 "verb inside a double-quoted string" 'echo "next: git commit -m x"' "$C"
want_match 1 "verb inside a single-quoted string" "echo 'run git commit later'" "$C"
want_match 1 "heredoc body mentioning the verb"   'cat <<EOF
git commit -m x
EOF' "$C"
want_match 1 "different verb"                     'git status --short' "$C"
want_match 1 "commit as an argument, not a verb"  'git log --grep commit' "$C"
want_match 1 "push is not commit"                 'git push origin HEAD' "$C"
want_match 1 "gh pr create is not merge"          'gh pr create --fill' "$M"

# --- target directory ---------------------------------------------------------
want_dir "/fallback"  "no cd, no -C"           'git commit -m x' /fallback "$C"
want_dir "/w/t"       "leading cd"             'cd /w/t && git commit -m x' /fallback "$C"
want_dir "/w/t"       "cd in an earlier segment" 'cd /w/t && git add -A && git commit -m x' /fallback "$C"
want_dir "/w/b"       "chained cd"             'cd /w && cd /w/b && git commit -m x' /fallback "$C"
want_dir "/fallback/rel" "relative cd"         'cd rel && git commit -m x' /fallback "$C"
want_dir "/w/t"       "git -C beats cd"        'cd /other && git -C /w/t commit -m x' /fallback "$C"
want_dir "/w/t"       "gh -C on a merge"       'gh -C /w/t pr merge 1 --squash' /fallback "$M"
want_dir "/fallback"  "cd AFTER the verb does not count" 'git commit -m x && cd /w/t' /fallback "$C"

# --- the review findings from go-to-k/cdk-local#542 --------------------------
# Every one of these was measured WRONG in the first version of this helper.
want_match 0 "bare & separator"              'sleep 0 & git commit -m x' "$C"
want_match 0 "command substitution"          'echo $(git commit -m x)' "$C"
want_match 0 "substitution into a variable"  'SHA=$(git commit -m x)' "$C"
want_match 0 "backtick substitution"         'echo `git commit -m x`' "$C"
want_match 0 "bash -c wrapper"               'bash -c "git commit -m x"' "$C"
want_match 0 "if/then compound"              'if true; then git commit -m x; fi' "$C"
want_match 0 "for/do compound"               'for f in a; do git commit -m x; done' "$C"
want_match 0 "timeout wrapper"               'timeout 60 git commit -m x' "$C"
want_match 0 "time wrapper"                  'time git commit -m x' "$C"
want_match 0 "nested subshells"              '( ( git commit -m x ) )' "$C"
want_match 0 "backslash continuation"        'git \
  commit -m x' "$C"
want_match 0 "quoted -C path with a space"   'git -C "/w t" commit -m x' "$C"

# The quote machinery only earns its keep on a separator INSIDE a string: without
# it these match, and the gates start blocking ordinary `echo`s.
want_match 1 "&& inside a quoted string"     'echo "step && git commit -m x"' "$C"
want_match 1 "; inside a quoted string"      "echo 'step ; git commit -m x'" "$C"
want_match 1 "| inside a quoted string"      'echo "step | git commit -m x"' "$C"
# A quoted span survives a NEWLINE: a `--body "…"` argument is one span, and this
# repo writes PR bodies that quote shell examples.
want_match 1 "multi-line quoted body" 'gh pr create --body "line one
line two && git commit -m x
line three"' "$C"
want_match 1 "CRLF heredoc terminator" 'cat <<EOF
body
EOF
echo done' "$C"

want_dir "/w t"   "quoted cd path"   'cd "/w t" && git commit -m x' /fb "$C"
want_dir "/w t"   "quoted -C path"   'git -C "/w t" commit -m x' /fb "$C"
want_dir "/fb"    "-C in a NON-matched segment is ignored" \
  'git -C /elsewhere status && git commit -m x' /fb "$C"

# --- heredoc termination (go-to-k/cdkd#2130, found porting this to cdkd) -------
# An opener whose delimiter never appears again does NOT open a heredoc. Honouring
# it swallowed the rest of the command: `cat <<EOF` + prose + a real commit was a
# NO MATCH — fail open, and the shape a PR-body-writing session produces daily.
want_match 0 "unterminated heredoc does not swallow the command" 'cat <<EOF
some prose
git commit -m x' "$C"
want_match 1 "terminated heredoc blanks its body" 'cat <<EOF
git commit -m x
EOF' "$C"
want_match 0 "command AFTER a terminated heredoc still matches" 'cat <<EOF
prose
EOF
git commit -m x' "$C"
want_match 1 "a body-only mention is not a command" 'gh pr create --body-file - <<EOF
run git commit when done
EOF' "$C"

# --- quote recovery + quoted heredoc mention (go-to-k/cdkd#2130) --------------
# An apostrophe in a word is not a quote: treating it as one left the span open
# and swallowed every command after it.
want_match 0 "apostrophe in a word, then a real commit" "echo don't; git commit -m y" "$C"
want_match 0 "apostrophe with && after it" "echo it's fine && git commit -m x" "$C"
# A heredoc opener inside a quoted span is a MENTION, not an opener.
want_match 0 "quoted <<X mention does not open a heredoc" 'echo "use <<EOF here"
git commit -m x
EOF' "$C"
# Balanced quotes must still hide their contents.
want_match 1 "balanced quotes still hide a separator" 'echo "step && git commit -m x"' "$C"
want_match 1 "balanced single quotes still hide one" "echo 'step ; git commit -m x'" "$C"

# --- compound statements, wrappers, process substitution (go-to-k/cdkd#2130) ---
# Every one of these ran UNGATED before, and each is a regression against the
# unanchored greps some gates used to carry.
want_match 0 "if ... then <verb>"        'if true; then git commit -m x; fi' "$C"
want_match 0 "while ... do <verb>"       'while :; do git commit -m x; done' "$C"
want_match 0 "until ... do <verb>"       'until false; do git commit -m x; done' "$C"
want_match 0 "negation"                  '! git commit -m x' "$C"
want_match 0 "sudo wrapper"              'sudo git commit -m x' "$C"
want_match 0 "xargs wrapper"             'xargs -I{} git commit -m {}' "$C"
want_match 0 "case arm"                  'case a in a) git commit -m x;; esac' "$C"
want_match 0 "process substitution"      'diff <(git commit -m x) /dev/null' "$C"
want_match 0 "output process substitution" 'tee >(git commit -m x) < f' "$C"

# A quoted span that CONTINUES past the newline is one argument: its lines are
# not separate commands, even when one of them starts with a gated verb.
want_match 1 "multi-line quoted body line starting with the verb" 'gh pr create --body "intro
git commit -m x was the step
end"' "$C"
# ... and a QUOTED heredoc tag is an ordinary opener, so its body is still data.
want_match 1 "quoted heredoc tag still hides its body" "cat <<'EOF'
git commit -m x
EOF" "$C"

want_dir "/tmp/a&b" "quoted path containing an ampersand" \
  'cd "/tmp/a&b" && git commit -m x' /fb "$C"

# --- unexpanded paths (go-to-k/cdkd#2130 spec review) -------------------------
# `cd "$WT" && …` is the spelling this flow MANDATES. Resolving it literally gave
# `<cwd>/$WT`, which no `git -C` can read, so the gate could not resolve a tree
# and exited 0. Falling back to the payload cwd fails CLOSED instead.
want_dir "/base" "cd with an unexpanded variable falls back" 'cd "$WT" && git commit -m x' /base "$C"
want_dir "/base" "cd with a command substitution falls back" 'cd "$(pwd)" && git commit -m x' /base "$C"
want_dir "/base" "-C with an unexpanded variable falls back" 'git -C "$WT" commit -m x' /base "$C"
want_dir "/real/path" "a real quoted path still resolves" 'cd "/real/path" && git commit -m x' /base "$C"
# The verb is still SEEN in all of those — only the directory falls back.
want_match 0 "unexpanded cd still matches the verb" 'cd "$WT" && git commit -m x' "$C"
want_match 0 "xargs behind a pipe" 'echo f | xargs git commit -m x' "$C"

# --- go-to-k/cdkd#2130 test review: two real defects, and the unpinned rest ----
want_match 0 "bash -c with an inner chain" 'bash -c "cd /w && git commit -m x"' "$C"
want_match 0 "process substitution"        'diff <(git commit -m x) b' "$C"
# An escaped separator outside quotes is LITERAL — one `echo`, not two commands.
want_match 1 "escaped semicolon is literal" 'echo a\; git commit -m x' "$C"
# Behaviour that was already right but pinned by nothing.
want_match 1 "ANSI-C quoting hides its contents" "echo \$'x; git commit'" "$C"
want_match 0 "parameter expansion default runs"  'echo ${V:-a; git commit -m x}' "$C"
want_match 1 "# comment holding the verb"        'echo hi # git commit -m x' "$C"
want_match 1 "grep pattern is not a verb"        'git log --grep commit' "$C"
want_match 1 "grep=pattern is not a verb"        'git log --grep=commit' "$C"
want_match 1 "an ordinary task run"              'vp run test' "$C"
# The quoted-span protection is what stops a gate firing on prose: pin it with a
# separator INSIDE the quotes, which is the only shape that can distinguish it.
want_match 1 "separator inside a quoted body" 'gh issue create --body "run vp check && git commit -m x"' "$C"

# --- the issue-mint verbs (issue-dup-check-gate) -----------------------------
I="$GATE_RE_GH_ISSUE_CREATE"
A="$GATE_RE_GH_API_ISSUE_CREATE"
want_match 0 "gh issue create"                 'gh issue create --title t'              "$I"
want_match 0 "gh issue create, chained"        'git push && gh issue create --title t'  "$I"
want_match 1 "gh issue edit is not a mint"     'gh issue edit 12 --body x'              "$I"
want_match 1 "gh issue comment is not a mint"  'gh issue comment 12 --body x'           "$I"
want_match 1 "quoted mention is not a verb"    "echo 'run gh issue create'"             "$I"
want_match 0 "gh api repos/o/r/issues"         'gh api repos/o/r/issues -f title=t'     "$A"
want_match 1 "gh api .../issues/5/comments"    'gh api repos/o/r/issues/5/comments -f body=x' "$A"
want_match 1 "gh api .../issues/5 (an edit)"   'gh api -X PATCH repos/o/r/issues/5 -f body=x' "$A"
# The repo-selecting flags. `GATE_GH_C` was widened to `GATE_FLAGS`-style
# tokenisation on 2026-08-25 after `gh -R <owner/repo> pr merge` was measured
# walking past verify-pr-gate, ci-green-gate and bughunt-clean-gate. All three
# separator spellings gh accepts are covered — space, `=`, and GLUED — the last
# being the one a hand-written `(-C|-R|--repo)` alternation misses.
want_match 0 "gh -R <repo> issue create"        'gh -R o/r issue create --title t'      "$I"
want_match 0 "gh --repo <repo> issue create"    'gh --repo o/r issue create --title t'  "$I"
want_match 0 "gh --repo=<repo> issue create"    'gh --repo=o/r issue create --title t'  "$I"
want_match 0 "gh -R <repo> api issues"          'gh -R o/r api repos/o/r/issues -f t=1' "$A"
want_match 0 "repeated -C then -R absorbed"     'gh -C /w -R o/r issue create --title t' "$I"
want_match 0 "quoted -C path with spaces"       'gh -C "/a b" issue create --title t'   "$I"
want_match 0 "glued -R<repo> issue create"       'gh -Ro/r issue create --title t'       "$I"
want_match 0 "-R=<repo> issue create"           'gh -R=o/r issue create --title t'      "$I"
want_match 0 "control: gh -C <dir> issue create" 'gh -C /w issue create --title t'      "$I"
# THE BYPASS CASES. `gh -R o/r pr merge` used to match NOTHING, so it merged past
# verify-pr-gate, ci-green-gate and bughunt-clean-gate (each measured plain rc=2,
# `-R` rc=0 on 2026-08-25). This assertion was INVERTED from `want_match 1` — an
# earlier revision of this lane pinned the old behaviour as intentional scoping,
# which was wrong: those gates are SUPPOSED to match a `-R` merge.
want_match 0 "gh -R <repo> pr merge"            'gh -R o/r pr merge 1 --squash'         "$M"
want_match 0 "gh --repo <repo> pr merge"        'gh --repo o/r pr merge 1 --squash'     "$M"
want_match 0 "gh --repo=<repo> pr merge"        'gh --repo=o/r pr merge 1 --squash'     "$M"
want_match 0 "gh -R=<repo> pr merge"            'gh -R=o/r pr merge 1 --squash'         "$M"
want_match 0 "glued gh -R<repo> pr merge"       'gh -Ro/r pr merge 1 --squash'          "$M"
# Widening the flag absorber must not make prose match: the quoted-span and
# command-position protections still carry the false-positive load.
want_match 1 "quoted -R merge in prose"         "echo 'gh -R o/r pr merge 1'"           "$M"
want_match 1 "gh -R <repo> pr view is not merge" 'gh -R o/r pr view 1'                  "$M"

# --- gate_pr_selector: the selector comes from the MATCHED verb + SEGMENT ----
#
# Two blockers, and the second was introduced by the fix for the first. A
# literal `.*gh( -C <p>)? pr merge` strip failed to apply under any other global
# flag and returned the command name `gh`; its replacement anchored the number
# IMMEDIATELY after the verb, which `gh` does not require, so a flag-first
# spelling lost it -- a red-CI bypass that did not exist before that change. And
# both scanned the WHOLE command, so a quoted mention in another segment donated
# its number.
want_sel() {
  local expect="$1" name="$2" cmd="$3" got
  got=$(gate_pr_selector "$cmd" "$GATE_RE_GH_PR_MERGE")
  if [ "$got" = "$expect" ]; then
    pass=$((pass + 1)); printf 'OK   sel %s\n' "$name"
  else
    fail=$((fail + 1)); printf 'FAIL sel %s (got %s, want %s)\n' "$name" "${got:-<empty>}" "${expect:-<empty>}"
  fi
}

want_sel 2195 "plain"                    'gh pr merge 2195 --squash'
want_sel 2195 "-R space"                 'gh -R go-to-k/x pr merge 2195 --squash'
want_sel 2195 "--repo space"             'gh --repo go-to-k/x pr merge 2195 --squash'
want_sel 2195 "--repo="                  'gh --repo=go-to-k/x pr merge 2195 --squash'
want_sel 2195 "-R="                      'gh -R=go-to-k/x pr merge 2195 --squash'
want_sel 2195 "-R glued"                 'gh -Rgo-to-k/x pr merge 2195 --squash'
want_sel 2195 "-C then -R"               'gh -C /tmp -R go-to-k/x pr merge 2195 --squash'
# BLOCKER 1: gh accepts the selector after the flags, in either order.
want_sel 1    "FLAG FIRST: --squash then 1"        'gh pr merge --squash 1'
want_sel 1    "FLAG FIRST under -R"                'gh -R go-to-k/x pr merge --squash 1'
want_sel 2195 "two flags then the number"          'gh pr merge --delete-branch --squash 2195'
# A numeric token belonging to an EARLIER command must not win.
want_sel 2195 "leading sleep 30 does not win"      'sleep 30 && gh -R go-to-k/x pr merge 2195 --squash'
# BLOCKER 2: the selector comes from the MATCHED SEGMENT only.
want_sel ""   "quoted mention in a --body"         'gh pr create --body "later: gh pr merge 42 --squash"'
want_sel ""   "quoted mention cannot donate to a bare merge" \
  'gh pr create --body "then run gh pr merge 9 --squash" && gh pr merge'
want_sel ""   "no number given"                    'gh pr merge --squash'
want_sel ""   "quoted mention only"                'echo "gh pr merge 5"'

# FLAG VALUES ARE NOT SELECTORS. Skipping tokens that start with `-` but not
# their VALUES made the value the selector — strictly worse than the literal
# strip it replaced, where a non-numeric selector came back empty and the caller
# fell back to the current branch (which BLOCKED). Measured before the fix:
# `-t msg 2195` -> msg, `--body-file 7 2195` -> 7 (audits PR 7).
want_sel 2195 "short flag with a value"            'gh pr merge -t msg 2195 --squash'
want_sel 2195 "long flag with a value"             'gh pr merge --match-head-commit abc 2195'
want_sel 2195 "QUOTED flag value stays one token"  'gh pr merge --subject "chore: x" 2195 --squash'
want_sel 2195 "numeric flag value is not the PR"   'gh pr merge --body-file 7 2195 --squash'
want_sel 2195 "-F <file> then the number"          'gh pr merge -F notes.md 2195 --squash'
want_sel 2195 "valueless flags are not consumed"   'gh pr merge --admin --delete-branch 2195'
want_sel 2195 "-R glued before the verb"           'gh -Rgo-to-k/x pr merge 2195'
# The staleness direction: an UNKNOWN flag is assumed to take a value, so it eats
# the number and the selector comes back EMPTY. Callers then fall back or refuse.
# The opposite polarity (enumerating value-takers) would leave the value in place
# and audit the WRONG PR.
want_sel ""   "unknown flag eats the number (SAFE)" 'gh pr merge --future-flag 552'
# The numeric guard: anything that is not a PR number comes back empty.
want_sel ""   "branch name is not a PR number"      'gh pr merge feature-branch --squash'
want_sel ""   "URL is not a PR number"              'gh pr merge https://github.com/o/r/pull/5'

# BOTH SPELLINGS. The list carried only the long forms, so every 2-char short
# flag fell to the value-consuming arm and ATE the number. Taken from
# `gh help pr merge`, which documents -s/--squash -m/--merge -r/--rebase
# -d/--delete-branch.
want_sel 2195 "short -s"                           'gh pr merge -s 2195'
want_sel 2195 "short -d"                           'gh pr merge -d 2195'
want_sel 2195 "short -m"                           'gh pr merge -m 2195'
want_sel 2195 "short -r"                           'gh pr merge -r 2195'
want_sel 2195 "long then short, both valueless"    'gh pr merge --squash -d 2195'
want_sel 2195 "--admin --auto then the number"     'gh pr merge --admin --auto 2195'

# gate_pr_selector_ate_number: "no selector given" vs "a flag swallowed one".
# Reported identically as an empty selector, and ci-green-gate must treat them
# differently — the first is a legitimate current-branch merge, the second audits
# a PR the user never named.
want_ate() {
  local expect="$1" name="$2" cmd="$3" got=no
  gate_pr_selector_ate_number "$cmd" "$GATE_RE_GH_PR_MERGE" && got=yes
  if [ "$got" = "$expect" ]; then pass=$((pass + 1)); printf 'OK   ate %s\n' "$name"
  else fail=$((fail + 1)); printf 'FAIL ate %s (got %s, want %s)\n' "$name" "$got" "$expect"; fi
}
want_ate yes "unknown flag swallowed the number" 'gh pr merge --future-flag 552'
want_ate no  "no selector given at all"          'gh pr merge --squash'
want_ate no  "selector present and resolved"     'gh pr merge -s 2195'
want_ate no  "flag value is not numeric"         'gh pr merge -t msg 2195'


# --- gate_repo_flag / slug normalisation ------------------------------------
want_slug() {
  local expect="$1" name="$2" cmd="$3" got
  got=$(gate_repo_flag "$cmd" "$GATE_RE_GH_PR_MERGE")
  got=$(gate_normalize_repo_slug "$got")
  if [ "$got" = "$expect" ]; then pass=$((pass + 1)); printf 'OK   slug %s\n' "$name"
  else fail=$((fail + 1)); printf 'FAIL slug %s (got %s, want %s)\n' "$name" "${got:-<empty>}" "${expect:-<empty>}"; fi
}
# Every spelling gh accepts for the SAME repo must normalise identically, or the
# foreign-repo refusal fires on this repo's own name and tells you to run the
# command from a checkout you are already in.
want_slug o/r "plain slug"        'gh -R o/r pr merge 5'
want_slug o/r "host-qualified"    'gh -R github.com/o/r pr merge 5'
want_slug o/r "https URL"         'gh -R https://github.com/o/r pr merge 5'
want_slug o/r "URL with .git"     'gh -R https://github.com/o/r.git pr merge 5'
want_slug o/r "scp-style remote"  'gh -R git@github.com:o/r.git pr merge 5'
want_slug o/r "case-insensitive"  'gh -R O/R pr merge 5'
want_slug o/r "--repo= spelling"  'gh --repo=o/r pr merge 5'
want_slug o/r "glued -R"          'gh -Ro/r pr merge 5'
# A `-R` inside a QUOTED value is text, not a flag.
want_slug ""  "-R inside a quoted value" 'gh pr merge --subject "compare with -R other/repo" 5'
want_slug ""  "no repo named"     'gh pr merge 5 --squash'

# gate_local_repo_slug against REAL remotes. This needs its own direct fence:
# when the slug comes back empty, every `-R` reads as foreign and every gate
# REFUSES — so the parity and ci-green suites stayed green over the bug, because
# an assertion that a gate blocks is satisfied by a gate blocking for any reason.
# (Measured: `url="${url##*/[a-z]/}"` ate the owner of
# `https://github.com/a/b.git`, yielding an empty slug.)
want_local_slug() {
  local expect="$1" name="$2" url="$3" d got
  d=$(mktemp -d)
  git -C "$d" init -q 2>/dev/null
  git -C "$d" remote add origin "$url" 2>/dev/null
  got=$(gate_local_repo_slug "$d")
  rm -rf "$d"
  if [ "$got" = "$expect" ]; then pass=$((pass + 1)); printf 'OK   local-slug %s\n' "$name"
  else fail=$((fail + 1)); printf 'FAIL local-slug %s (got %s, want %s)\n' "$name" "${got:-<empty>}" "${expect:-<empty>}"; fi
}
want_local_slug a/b "https remote with .git" 'https://github.com/a/b.git'
want_local_slug a/b "https remote bare"      'https://github.com/a/b'
want_local_slug a/b "scp-style remote"       'git@github.com:a/b.git'
want_local_slug a/b "ssh:// remote"          'ssh://git@github.com/a/b.git'
want_local_slug a/b "uppercase remote"       'https://github.com/A/B.git'
want_local_slug a/b "trailing slash after .git" 'https://github.com/a/b.git/'

# --- gate_verb_args_dir (main-tree-branch-gate) --------------------------------
#
# The per-segment walk: one "<dir><TAB><args-after-the-verb>" line per matching
# segment. What it must NOT be is `gate_target_dir` + a separate argument walk:
# that function BREAKS at the first matching segment, so segment 1's tree decides
# every segment. Measured HERE, driving main-tree-branch-gate against THIS repo's
# real main checkout and its real linked worktree with a payload cwd of the MAIN
# checkout, once with the tree resolved outside the walk and once per segment:
#
#   git -C <wt> switch -c a && git switch -c b       rc=0, want 2  BYPASS
#   git switch main && git -C <wt> switch -c a       rc=2, want 0  FALSE BLOCK
SW="$GATE_RE_GIT_SWITCH"

# want_lines <expected-with-\n> <label> <command> <fallback> <regex>
want_lines() {
  local want="$1" label="$2" cmd="$3" fallback="$4" re="$5" got
  got=$(gate_verb_args_dir "$cmd" "$fallback" "$re" | tr '\t' '|')
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n  want: [%s]\n  got:  [%s]\n' "$label" "$want" "$got"
  fi
}

want_lines '/w/t|-c feat' "one segment, fallback dir" \
  'git switch -c feat' '/w/t' "$SW"
want_lines '/other|-c feat' "the segment's own -C wins over the fallback" \
  'git -C /other switch -c feat' '/w/t' "$SW"
want_lines '/other|-c feat' "glued -C<path> is read too (gate_target_dir cannot)" \
  'git -C/other switch -c feat' '/w/t' "$SW"
want_lines '/other|-c feat' "-C=<path> is read too" \
  'git -C=/other switch -c feat' '/w/t' "$SW"
want_lines '/a b|-c feat' "a quoted -C path containing a space survives" \
  'git -C "/a b" switch -c feat' '/w/t' "$SW"
want_lines '/wt|-c a
/wt|-c b' "a cd PERSISTS into every later segment" \
  'cd /wt && git switch -c a && git switch -c b' '/w/t' "$SW"
want_lines '/wt|-c a
/w/t|-c b' "a -C binds ONLY its own segment, and does not leak forward" \
  'git -C /wt switch -c a && git switch -c b' '/w/t' "$SW"
want_lines '/w/t|main
/wt|-c a' "EVERY matching segment is emitted, each with its OWN tree" \
  'git switch main && git -C /wt switch -c a' '/w/t' "$SW"
want_lines '' "a quoted mention emits nothing" \
  'echo "do not run: git switch -c feat"' '/w/t' "$SW"
# A RELATIVE `cd` resolves against the running target, and nothing pinned it: the
# `[[ "$cd_target" != /* ]] && cd_target="$target/$cd_target"` line could be
# deleted with this suite at 177/0 and the gate suite at 54/0. The parity block
# below covers a relative `-C`, which is the OTHER branch of the same rule.
want_lines '/w/t/sub|-c feat' "a RELATIVE cd resolves against the running target" \
  'cd sub && git switch -c feat' '/w/t' "$SW"
want_lines '/w/t/sub/deeper|-c feat' "relative cds COMPOSE across segments" \
  'cd sub && cd deeper && git switch -c feat' '/w/t' "$SW"
# ...and its control: an ABSOLUTE cd replaces the target rather than extending it,
# so the two cases above are not satisfied by "always concatenate".
want_lines '/elsewhere|-c feat' "an ABSOLUTE cd replaces the running target" \
  'cd sub && cd /elsewhere && git switch -c feat' '/w/t' "$SW"

# PARITY PIN. The cd / -C reading here is a deliberate COPY of gate_target_dir's,
# because that function breaks at the verb and has other callers riding on it. A
# copy that nothing compares is a copy that drifts, so the two are pinned against
# each other on the SINGLE-segment shape, where they must agree by construction.
want_parity() {
  local label="$1" cmd="$2" fallback="$3" re="$4" a b
  a=$(gate_target_dir "$cmd" "$fallback" "$re")
  b=$(gate_verb_args_dir "$cmd" "$fallback" "$re" | head -1)
  b="${b%%	*}"
  if [ "$a" = "$b" ]; then
    pass=$((pass + 1)); printf 'OK   parity %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL parity %s (gate_target_dir=%s gate_verb_args_dir=%s)\n' "$label" "$a" "$b"
  fi
}
want_parity "bare verb"            'git switch -c feat' '/w/t' "$SW"
want_parity "leading cd"           'cd /wt && git switch -c feat' '/w/t' "$SW"
want_parity "spaced -C"            'git -C /other switch -c feat' '/w/t' "$SW"
want_parity "quoted -C with space" 'git -C "/a b" switch -c feat' '/w/t' "$SW"
want_parity "relative -C"          'git -C sub switch -c feat' '/w/t' "$SW"
want_parity "unexpanded cd \$VAR"  'cd "$WT" && git switch -c feat' '/w/t' "$SW"
want_parity "unexpanded -C \$VAR"  'git -C "$WT" switch -c feat' '/w/t' "$SW"
want_parity "relative cd"          'cd sub && git switch -c feat' '/w/t' "$SW"


# --- gate_argv ------------------------------------------------------------------
#
# `gate_tokens` splits SHELL WORDS; this splits git's ARGV, which is what an
# option parse actually reads. The difference is not cosmetic: a redirection, its
# spaced target, a trailing `&` and a `#` comment are all WORDS and none of them
# is an ARGUMENT, and counting them as arguments is what made
# `git checkout <branch> 2>/dev/null` read as a two-positional file restore and
# PASS through main-tree-branch-gate (measured rc=0, want 2, on a command that
# really moves HEAD).
argv_case() { # name, text, expected newline-joined argv, expected rc
  local name="$1" text="$2" want="$3" wantrc="${4:-0}" got gotrc
  got=$(gate_argv "$text"); gotrc=$?
  if [ "$got" = "$want" ] && [ "$gotrc" = "$wantrc" ]; then
    pass=$((pass + 1)); printf 'OK   gate_argv: %s\n' "$name"
  else
    fail=$((fail + 1))
    printf 'FAIL gate_argv: %s\n  text: [%s]\n  want: [%s] rc=%s\n  got : [%s] rc=%s\n' \
      "$name" "$text" "$want" "$wantrc" "$got" "$gotrc"
  fi
}
argv_case "plain words are argv unchanged" " -b feat" "$(printf -- '-b\nfeat')"
argv_case "a glued redirection is dropped" " feat 2>/dev/null" "feat"
argv_case "two glued redirections are dropped" " feat >/dev/null 2>&1" "feat"
argv_case "an append redirection is dropped" " feat 2>>log" "feat"
argv_case "a SPACED redirection drops its target too" " feat > /dev/null" "feat"
argv_case "a numbered spaced redirection drops its target" " feat 2> log" "feat"
argv_case "an input redirection is dropped" " feat < in" "feat"
argv_case "a trailing & is dropped" " feat &" "feat"
argv_case "a comment ends the argv" " feat # switch lane" "feat"
argv_case "a comment ends it even mid-list" " a # b -- c" "a"
# The COMMENT rule keys on an UNQUOTED leading `#`. A quoted one is an argument
# the shell passes through, and the token still carries its quotes here.
argv_case "a QUOTED # is an argument, not a comment" " '#branch'" "'#branch'"
argv_case "a # inside a word is not a comment" " feat#1" "feat#1"
# CONTROLS: the things that look like the above and are NOT shell syntax.
argv_case "a bare -- survives" " feat -- README.md" "$(printf -- 'feat\n--\nREADME.md')"
argv_case "a digit-only word is not a redirection" " --unified 3 feat" "$(printf -- '--unified\n3\nfeat')"
argv_case "a quoted span survives whole" ' -c "wt feat new"' "$(printf -- '-c\n"wt feat new"')"
# An UNBALANCED quote cannot be split at all. Reporting it is the whole point:
# `gate_tokens` used to return the prefix it managed and rc=0, so `-b
# agent's-branch` yielded the single token `-b` and the gate read a bare
# `git checkout`.
argv_case "an unbalanced quote returns 1 and nothing" " -b agent's-branch" "" 1
argv_case "an unbalanced quote at the start returns 1" " a'unbalanced" "" 1
argv_case "empty text is not a truncation" "" "" 0
# CONTROL, not a fence: `gate_argv` feeds its loop from a HEREDOC, and a heredoc
# delimiter is matched in the SCRIPT text rather than in an expansion -- so a
# token that happens to spell the delimiter cannot end the body early. Nothing
# reddens this today; it is here so a rewrite that re-scans the value (an `eval`,
# a here-string built from it) has a case to fail.
argv_case "a token spelling the heredoc delimiter survives" " EOF -- x" "$(printf -- 'EOF\n--\nx')"


# A FLOOR on the case total, for the same reason the gate suite carries one:
# deleting a case removes its assertions SILENTLY while the tally still reads
# `fail: 0`, so without a floor the sixteen `gate_verb_args_dir` cases added for
# main-tree-branch-gate could be dropped and this file would still report green.
# Raise it when cases are added; never lower it to make a red run green.
# --- gate_word_is_literal -------------------------------------------------------
#
# The INVERTED default. `gate_argv` above splits words; this answers whether a
# word reaches the command as the text it carries, and it answers NO by default.
# Three rounds of `main-tree-branch-gate` fixes each taught the stripper one more
# shell form and each time the next round found the form still missing -- last
# `$EMPTY` (an empty expansion VANISHES, so the gate counted a positional git
# never receives) and `{fd}>/dev/null` (bash's fd-variable redirection, a word
# git never receives at all). Both turned a real branch switch into a two-
# positional file restore and PASSED.
#
# The cases below are therefore in two halves, and the SECOND half is what makes
# the first mean anything: if the inert list quietly shrank, the refusals would
# all still pass while every ordinary command started blocking.
lit_case() { # name, word, want-rc
  local name="$1" word="$2" wantrc="$3" gotrc
  gate_word_is_literal "$word"; gotrc=$?
  if [ "$gotrc" = "$wantrc" ]; then
    pass=$((pass + 1)); printf 'OK   gate_word_is_literal: %s\n' "$name"
  else
    fail=$((fail + 1))
    printf 'FAIL gate_word_is_literal: %s\n  word: [%s]\n  want rc=%s got rc=%s\n' \
      "$name" "$word" "$wantrc" "$gotrc"
  fi
}
# REFUSED -- every one of these is a word the shell may rewrite or remove.
lit_case "an unquoted \$ expansion is refused" '$EMPTY' 1
lit_case "a braced \$ expansion is refused" '${EMPTY}' 1
lit_case "a \$ inside DOUBLE quotes is still refused" '"$f"' 1
lit_case "a backtick substitution is refused" '`date`' 1
lit_case "a backslash escape is refused" 'a\b' 1
lit_case "the fd-variable redirection prefix is refused" '{fd}>/dev/null' 1
lit_case "a brace word is refused" '{a,b}' 1
lit_case "a glob star is refused" '*.ts' 1
lit_case "a glob question mark is refused" 'a?b' 1
lit_case "a bracket expression is refused" 'a[bc]' 1
lit_case "a leading tilde is refused" '~/x' 1
lit_case "a history bang is refused" 'a!b' 1
lit_case "a metacharacter that reached here is refused" 'a;b' 1
lit_case "a pipe is refused" 'a|b' 1
lit_case "a redirection character is refused" '>x' 1
lit_case "a subshell paren is refused" '(x)' 1
lit_case "a leading # is refused (it opens a comment)" '#branch' 1
lit_case "an unbalanced quote is refused" "'open" 1
lit_case "the empty word is refused" '' 1
# ADMITTED -- the other half. Each of these is an ordinary git argument, and the
# gate's ALLOW arms are unreachable without them.
lit_case "a plain name is literal" 'feat' 0
lit_case "a slashed, dotted, dashed name is literal" 'feat/x-1.2' 0
lit_case "a glued long-option value is literal" '--create=feat' 0
lit_case "a caret revision is literal" 'HEAD^' 0
lit_case "a # INSIDE a word is literal" 'has#hash' 0
lit_case "a comma is literal without a brace" 'a,b' 0
lit_case "a colon and an at-sign are literal" 'a:b@c' 0
lit_case "a plus and a percent are literal" 'a+b%c' 0
lit_case "a SINGLE-quoted \$ is literal" "'feat\$x'" 0
lit_case "a single-quoted space is literal" "'my branch'" 0
lit_case "a DOUBLE-quoted plain word is literal" '"main"' 0
lit_case "an embedded quoted span is literal" 'core.pager="less"' 0

# --- gate_strip_comment ---------------------------------------------------------
#
# The cut happens BEFORE the split, which is the whole fix: an apostrophe inside
# a comment used to be weighed as a quote, so `git checkout main # don't switch
# lanes` came back a truncation and the gate blocked a command bash calls valid
# and git answers with "Already on 'main'".
cut_case() { # name, text, want
  local name="$1" text="$2" want="$3" got
  got=$(gate_strip_comment "$text")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   gate_strip_comment: %s\n' "$name"
  else
    fail=$((fail + 1))
    printf 'FAIL gate_strip_comment: %s\n  text: [%s]\n  want: [%s]\n  got : [%s]\n' \
      "$name" "$text" "$want" "$got"
  fi
}
cut_case "a comment is cut at the word start" 'main # switch lane' 'main '
cut_case "an APOSTROPHE inside the comment does not poison it" \
  "main # don't switch lanes" 'main '
cut_case "a # mid-word is not a comment" 'feat#1' 'feat#1'
cut_case "a # inside a quoted span is not a comment" "main -- 'a#b'" "main -- 'a#b'"
# The DISCRIMINATING half of that pair: with a SPACE before it, the `#` sits at
# what would be a word start if the quotes were not tracked, so a cut here is
# exactly what dropping the quote state produces. The case above cannot see
# that -- its `#` is preceded by `a` either way.
cut_case "a # at a word start INSIDE quotes is still not a comment" \
  "main -- 'a #b' tail" "main -- 'a #b' tail"
cut_case "an escaped # is not a comment" 'main \# x' 'main \# x'
cut_case "text with no comment is unchanged" '-b feat' '-b feat'
# The SECOND PASS, the `ignore_q` trick `gate_segments_raw` already uses: the
# leading `'` never closes, so on the retry it is treated as literal and the
# comment is found. The result is still unsplittable, and `gate_argv` still
# refuses it -- correctly, since bash calls that text a syntax error.
cut_case "an unclosed quote is retried with the quote literal" \
  "'unbalanced # x" "'unbalanced "

# --- gate_argv: round 4 ---------------------------------------------------------
argv_case "a comment carrying an apostrophe no longer truncates" \
  " main # don't switch lanes" "main"
# SPACED redirection operators. Each of these drops BOTH words; dropping an
# operator from GATE_REDIR_TOKEN makes the operator itself read as an argument,
# which is the FAIL-OPEN direction (an extra positional relaxes the gate's
# verdict to "file restore").
argv_case "a spaced append redirection drops its target" " feat 2>> log" "feat"
argv_case "a spaced clobber redirection drops its target" " feat >| out" "feat"
argv_case "a spaced dup-out redirection drops its target" " feat >& out" "feat"
argv_case "a spaced dup-in redirection drops its target" " feat <& 3" "feat"
argv_case "a spaced &> redirection drops its target" " feat &> out" "feat"
argv_case "a spaced &>> redirection drops its target" " feat &>> out" "feat"

CASE_FLOOR=246
ran=$((pass + fail))
if [ "$ran" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  printf 'FAIL case floor: only %s cases ran, expected at least %s\n' "$ran" "$CASE_FLOOR"
fi
# --- gate_perl_word_ok must reject a STALE prelude ---------------------------
#
# The guard exists to catch a library that is present but does not WORK, and the
# case it is most likely to meet is a SIBLING REPO one revision behind -- this
# prelude is copied between three repos on purpose. A four-dimension probe was
# measured certifying exactly that: the pre-`ebf5ac39` prelude (no mid-word
# ANSI-C arm, `gate_unq` decoding instead of returning bytes) passed every
# assertion, because all four inputs were pure ASCII at word position 0.
#
# Each case deletes ONE dimension from the REAL prelude and requires a
# rejection. A dimension whose deletion still passes is one the probe does not
# actually certify. Driven from a single python block rather than per-case shell
# arguments: the mutations are regex literals full of quotes and backslashes,
# and threading them through shell quoting broke the file twice.
__pr_out=$(python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/testdata/probe-rejects.py" \
             "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh" 2>&1)
__pr_rc=$?
printf '%s\n' "$__pr_out"
__pr_ok=$(printf '%s\n' "$__pr_out" | grep -c '^OK   probe-rejects:')
__pr_bad=$(printf '%s\n' "$__pr_out" | grep -c '^FAIL probe-rejects:')
# The COUNT is asserted, not just the failures: a script that dies early prints
# nothing and would otherwise read as six silent passes.
if [ "$__pr_rc" != 0 ] || [ "$__pr_ok" -ne 7 ] || [ "$__pr_bad" -ne 0 ]; then
  fail=$((fail + 1))
  printf 'FAIL probe-rejects: expected 7 OK / 0 FAIL, got %s / %s (rc=%s)\n' "$__pr_ok" "$__pr_bad" "$__pr_rc"
  fail_log+="FAIL probe-rejects: expected 7 OK / 0 FAIL, got $__pr_ok / $__pr_bad\n"
else
  pass=$((pass + __pr_ok))
fi

printf '\npass: %s  fail: %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

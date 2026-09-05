#!/usr/bin/env bash
# _command-match.sh — shared command matching for the PreToolUse gate hooks.
# SOURCED, never executed: `. "$(dirname "${BASH_SOURCE[0]}")/_command-match.sh"`.
#
# WHY (go-to-k/cdk-real-drift#1803): every gate used to decide whether it applied
# with a LINE-START-anchored regex tolerating at most one leading `cd <path> &&`,
# so a gated verb anywhere else was invisible and the command ran UNGATED —
# `git add -A && git commit`, `cd <wt>; git commit`, `(cd <wt> && git commit)`,
# `GIT_EDITOR=true git commit`, all measured reaching git.
#
# The model: a Bash tool call is a COMMAND LIST. Segment it, then ask whether any
# SEGMENT is the gated command.
#
# Quoting is handled by NEUTRALISING separators inside quoted spans rather than
# blanking the span. The first version blanked them, which also erased the PATH in
# `cd "<worktree>" && git commit` and `git -C "<path>" commit`, so target-dir
# resolution silently fell back to the payload cwd and the gate passed a commit it
# should have blocked — a regression against the pre-refactor gates, caught in
# review of go-to-k/cdk-local#542. Segments therefore carry their original text;
# only the separator CHARACTERS inside quotes are swapped for placeholders while
# splitting, and swapped back afterwards. A verb inside a string still does not
# match, because the per-verb regexes are anchored at the segment START.

# Placeholders for separators that live inside quoted spans (never in real input).
GATE_SEP_AMP=$'\001'
GATE_SEP_SEMI=$'\002'
GATE_SEP_PIPE=$'\003'
GATE_SEP_SUBST=$'\004'

# One awk pass: join `\`-continuations, blank heredoc BODIES, neutralise
# separators inside quotes, and turn every real separator into a newline. Command
# substitutions (`$(...)` and backticks) become separators too — the text inside
# one RUNS, so `echo "$(git commit -m x)"` is a commit.
gate_segments_raw() {
  awk '
    # `q` (the open quote character) is GLOBAL: a quoted span survives a newline,
    # and a `--body "…multi-line…"` argument is ONE span. Resetting it per line
    # split a PR body into segments and matched a `&& git commit` inside the
    # prose (go-to-k/cdk-local#542 review).
    #
    # `ignore_q` is set on the SECOND pass: if the whole input ends with a quote
    # still open, that character was not a quote at all (an apostrophe in
    # `echo dont do it`), and treating it as one swallowed every command after it
    # — fail open. The pass is redone with that character literal
    # (go-to-k/cdkd#2130).
    function flush_line(line,   i, n, c, out) {
      out = ""; n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (q == "") {
          # An escaped character outside quotes is LITERAL: `echo a\; git commit`
          # is ONE echo, and splitting on that `;` blocked it (go-to-k/cdkd#2130
          # test review).
          if (c == "\\") { out = out c substr(line, i + 1, 1); i++; continue }
          if ((c == "\"" || c == "'"'"'") && c != ignore_q) { q = c; out = out c; continue }
          if (c == "$" && substr(line, i + 1, 1) == "(") { out = out "\n"; i++; continue }
          # Process substitution runs its body too: `diff <(git commit) …`.
          if ((c == "<" || c == ">") && substr(line, i + 1, 1) == "(") { out = out "\n"; i++; continue }
          if (c == "`") { out = out "\n"; continue }
          if (c == "&" || c == ";" || c == "|") { out = out "\n"; continue }
          out = out c
          continue
        }
        if (c == "\\" && q == "\"") { out = out c substr(line, i + 1, 1); i++; continue }
        if (c == q) { q = ""; out = out c; continue }
        if (c == "&") { out = out SEP_AMP; continue }
        if (c == ";") { out = out SEP_SEMI; continue }
        if (c == "|") { out = out SEP_PIPE; continue }
        if (c == "$" && substr(line, i + 1, 1) == "(") { out = out SEP_SUBST "("; i++; continue }
        out = out c
      }
      return out
    }
    # The line with every QUOTED span blanked, for the heredoc-opener test only:
    # `echo "use <<EOF here"` is a mention, and honouring it blanked the rest of
    # the command (go-to-k/cdkd#2130).
    function unquoted_part(line,   i, n, c, out, inq, prev2) {
      out = ""; inq = ""; n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        prev2 = (i > 2) ? substr(line, i - 2, 2) : ""
        if (inq == "") {
          # A quote right after `<<` (or `<<-`) is part of a heredoc TAG, not a
          # span: `cat <<'"'"'EOF'"'"'` is an ordinary opener. Blanking it lost the tag,
          # so the body was treated as commands and this repo blocked its own
          # scripts (go-to-k/cdkd#2130 review).
          if ((c == "\"" || c == "'"'"'") && (prev2 == "<<" || substr(line, i - 1, 1) == "-" && substr(line, i - 3, 2) == "<<")) { out = out c; continue }
          if ((c == "\"" || c == "'"'"'") && c != ignore_q) { inq = c; out = out " "; continue }
          out = out c
        } else {
          if (c == inq) inq = ""
          out = out " "
        }
      }
      return out
    }
    # Does a line equal to `t` appear later? An opener whose delimiter never
    # reappears is not a heredoc; honouring it swallowed the rest of the command
    # (go-to-k/cdkd#2130, fixed for the same shape in go-to-k/cdkd#1455).
    function terminated(t, from,   k, probe) {
      for (k = from; k <= total; k++) {
        probe = raw[k]
        sub(/\r$/, "", probe)
        gsub(/^[ \t]+|[ \t]+$/, "", probe)
        if (probe == t) return 1
      }
      return 0
    }
    function emit(i,   line, t, neutral, bare) {
      line = raw[i]
      sub(/\r$/, "", line)
      if (tag != "") {                      # heredoc body: data, not commands
        t = line
        gsub(/^[ \t]+|[ \t]+$/, "", t)
        if (t == tag) tag = ""
        outbuf[++outn] = ""
        return
      }
      if (pending != "") { line = pending line; pending = "" }
      if (line ~ /\\$/) {                   # `\`-continuation
        sub(/\\$/, "", line)
        pending = line
        return
      }
      neutral = flush_line(line)
      bare = unquoted_part(line)
      if (match(bare, /<<-?[ \t]*["'"'"']?[A-Za-z_][A-Za-z0-9_]*["'"'"']?/)) {
        t = substr(bare, RSTART, RLENGTH)
        gsub(/^<<-?[ \t]*|["'"'"']/, "", t)
        if (terminated(t, i + 1)) tag = t
      }
      # A quoted span that continues past the newline is ONE argument, so its
      # lines must not become separate segments: a `--body "…"` whose second
      # line STARTS with a gated verb was matched and blocked (go-to-k/cdkd#2130
      # review). Join the continuation onto the segment that opened the span.
      if (open_span != "") {
        outbuf[outn] = outbuf[outn] " " neutral
      } else {
        outbuf[++outn] = neutral
      }
      open_span = q
    }
    function run_pass(   i) {
      q = ""; tag = ""; pending = ""; outn = 0; open_span = ""
      for (i = 1; i <= total; i++) emit(i)
      if (pending != "") outbuf[++outn] = flush_line(pending)
    }
    BEGIN { ignore_q = "" }
    { raw[NR] = $0; total = NR }
    END {
      run_pass()
      if (q != "") { ignore_q = q; run_pass() }   # that quote was not a quote
      for (i = 1; i <= outn; i++) print outbuf[i]
    }
  ' SEP_AMP="$GATE_SEP_AMP" SEP_SEMI="$GATE_SEP_SEMI" SEP_PIPE="$GATE_SEP_PIPE" \
    SEP_SUBST="$GATE_SEP_SUBST" <<< "$1"
}

# Leading words that introduce a command without being one: env assignments,
# wrappers, and the keywords that open a compound statement.
gate_strip_prefix() {
  local s="$1" prev=""
  s="${s#"${s%%[![:space:]]*}"}"
  # Strip leaders until stable: a `case <word> in` opener, a `<pattern>)` arm
  # label, compound-statement keywords, wrappers, and env assignments can nest
  # (`case a in a) sudo git commit`). `if|while|until|!|sudo|xargs` were missing,
  # so `if <verb>; then …`, `! <verb>` and `sudo <verb>` ran UNGATED — a
  # regression for every gate that traded an unanchored grep for this matcher
  # (go-to-k/cdkd#2130 review).
  while [ "$s" != "$prev" ]; do
    prev="$s"
    if [[ "$s" =~ ^[[:space:]]*case[[:space:]]+[^[:space:]]+[[:space:]]+in[[:space:]]+(.*)$ ]]; then
      s="${BASH_REMATCH[1]}"
    fi
    if [[ "$s" =~ ^[[:space:]]*[^\(\)\|\;\&[:space:]]+\)[[:space:]]*(.*)$ ]]; then
      s="${BASH_REMATCH[1]}"
    fi
    if [[ "$s" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|env|command|nohup|time|timeout[[:space:]]+[^[:space:]]+|exec|then|do|else|elif|if|while|until|!|sudo|xargs|-[A-Za-z][^[:space:]]*|\{|\()[[:space:]]+(.*)$ ]]; then
      s="${BASH_REMATCH[2]}"
    fi
    s="${s#"${s%%[![:space:]]*}"}"
  done
  # Any remaining grouping punctuation at either end (nested subshells).
  while [[ "$s" =~ ^[[:space:]]*[\(\{][[:space:]]*(.*)$ ]]; do s="${BASH_REMATCH[1]}"; done
  while [[ "$s" =~ ^(.*[^[:space:]])[[:space:]]*[\)\}][[:space:]]*$ ]]; do s="${BASH_REMATCH[1]}"; done
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Strip one surrounding quote pair from a whole argument (the `bash -c` body).
gate_unquote_span() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}

# Print one command segment per line, in the ORIGINAL text (placeholders restored).
gate_segments() {
  local segment
  while IFS= read -r segment; do
    # NOT `${segment//"$GATE_SEP_AMP"/&}`: since bash 5.2 an `&` in the
    # replacement means the MATCHED TEXT, so the placeholder survived and a
    # quoted path containing `&` came back corrupted — the gate then failed to
    # resolve the tree and exited 0 (go-to-k/cdkd#2130 review). Version-dependent:
    # macOS bash 3.2 masks it.
    while [[ "$segment" == *"$GATE_SEP_AMP"* ]]; do
      segment="${segment%%"$GATE_SEP_AMP"*}&${segment#*"$GATE_SEP_AMP"}"
    done
    segment="${segment//"$GATE_SEP_SEMI"/;}"
    segment="${segment//"$GATE_SEP_PIPE"/|}"
    segment="${segment//"$GATE_SEP_SUBST"/$}"
    segment=$(gate_strip_prefix "$segment")
    # `bash -c "<cmd>"` RUNS its argument, and that argument is a command LIST:
    # matching it as ONE segment missed `bash -c "cd /w && git commit"`
    # (go-to-k/cdkd#2130 test review). Recurse ONLY here — re-segmenting every
    # segment would split a quoted `--body` whose prose contains `&&`.
    if [[ "$segment" =~ ^(bash|zsh|ksh|sh)[[:space:]]+-[a-z]*c[[:space:]]+(.*)$ ]]; then
      gate_segments "$(gate_unquote_span "${BASH_REMATCH[2]}")"
      continue
    fi
    # An `if`, not `[ … ] && printf`: under a caller's `set -e` the trailing
    # false test aborts the whole function, and the segments after it are never
    # emitted — a silent fail-open that depends on which gate sources this.
    if [ -n "$segment" ]; then printf '%s\n' "$segment"; fi
  done < <(gate_segments_raw "$1")
}

# gate_matches <cmd> <extended-regex>
# 0 when any segment matches. Bash-native `=~` rather than a `grep` per segment:
# these hooks run on every matching Bash tool call, and the fork per segment per
# gate was measured at ~5x the whole gate suite's latency in review of
# go-to-k/cdk-local#542.
gate_matches() {
  local cmd="$1" re="$2" segment
  while IFS= read -r segment; do
    [[ "$segment" =~ $re ]] && return 0
  done < <(gate_segments "$cmd")
  return 1
}

# A path token: a quoted span (either quote character) or a bare run of
# non-space. Held in a variable because a literal `[[ =~ ]]` pattern cannot carry
# both quote characters inside one bracket expression.
GATE_PATH_TOKEN='("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]]+)'

# The regexes, kept here so every gate spells its verb the same way. Each is
# anchored at the START of a segment; `git -C <path>` / `git -c k=v` and
# `gh -C <path>` are absorbed — including a QUOTED path containing spaces, which
# an earlier version could not parse, so `git -C "/a b" commit` matched nothing
# and ran ungated (go-to-k/cdk-local#542 review).
GATE_FLAGS='([[:space:]]+-[^[:space:]]+([[:space:]]+("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]-][^[:space:]]*))?)*'
# Every gh GLOBAL FLAG that can sit before the subcommand, not just `-C`.
#
# WIDENED 2026-08-25 after measuring a LIVE BYPASS, not a coverage gap. With the
# `-C`-only form, `-R <owner/repo>` before the verb made the verb unreachable, so
# `gh -R go-to-k/cdk-real-drift pr merge 1 --squash` matched NOTHING and walked
# past the merge gates while the identical command without `-R` was refused.
# Driven directly against each hook on a fixture repo with a src/** diff, no
# markers and an armed bug-hunt sentinel:
#
#   gate                    plain   -R form
#   verify-pr-gate            2        0      <- merges past /verify-pr
#   ci-green-gate             2        0      <- merges past red CI
#   bughunt-clean-gate        2        0      <- merges with live AWS resources
#
# `-R` names where the PR LIVES; it changes nothing about what the command DOES,
# so a gate that reads one verdict for `gh pr merge` and another for
# `gh -R o/r pr merge` is simply wrong. cdkd hit the same measurement and widened
# its copy first. `gh-repo-flag-parity.test.sh` now asserts the equality directly
# against each gate, which is the assertion that would have caught this.
#
# Repeated and `=`-joined forms are absorbed (`gh -C /w -R o/r pr merge`,
# `gh --repo=o/r pr merge`), and quoted values survive. `-C` is kept even though
# `gh` HAS NO `-C` FLAG: this matches command TEXT, where over-approximating the
# trigger is free. Same shape as GATE_FLAGS, and like it this contributes
# multiple capture groups.
#
# IT IS `GATE_FLAGS`, NOT A HAND-WRITTEN `(-C|-R|--repo)` ALTERNATION, and the
# reason is the GLUED spelling. `gh` accepts a flag value with a space, with `=`,
# or with NO SEPARATOR AT ALL -- verified against gh 2.89.0, all three returning
# the same PR number:
#
#   gh pr list --repo=go-to-k/cdkd   -> 2195
#   gh pr list -R=go-to-k/cdkd       -> 2195
#   gh pr list -Rgo-to-k/cdkd        -> 2195   <- no separator
#
# `GATE_FLAGS`' flag token is `-[^[:space:]]+`, which swallows `--repo=X`, `-R=X`
# and `-RX` as ONE token, leaving the optional value group needed only for the
# space form. An explicit alternation gets the first two and misses the third:
# the first revision of this change used `(-C|-R|--repo)([[:space:]]+|=)` and
# `gh -Rgo-to-k/x issue create` did NOT match. A flag list also has to be
# maintained as gh grows global flags; a tokeniser does not.
#
# `-C` is still absorbed even though `gh` HAS NO `-C` FLAG: this matches command
# TEXT, where over-approximating the trigger costs nothing. Contributes THREE
# capture groups, like GATE_FLAGS -- no caller indexes BASH_REMATCH off these.
GATE_GH_C="$GATE_FLAGS"

GATE_RE_GIT_COMMIT="^git${GATE_FLAGS}[[:space:]]+commit([[:space:]]|$)"
GATE_RE_GIT_PUSH="^git${GATE_FLAGS}[[:space:]]+push([[:space:]]|$)"
GATE_RE_GH_PR_CREATE="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+create([[:space:]]|$)"
GATE_RE_GH_PR_EDIT="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+edit([[:space:]]|$)"
GATE_RE_GH_PR_MERGE="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)"
# issue-dup-check-gate: the one verb that MINTS a new issue. `edit` and
# `comment` are deliberately absent — folding a finding into an issue that
# already exists is the outcome that gate exists to steer toward, so gating it
# would tax the cheap path and leave the expensive one untouched.
#
# `GATE_GH_C` absorbs `-R` / `--repo` as of 2026-08-25 (see its header), which
# matters here beyond tidiness: the cross-repo mirror flow files with
# `gh -R <owner/repo> issue create`, so a `-C`-only absorber would have left this
# gate blind to its own primary shape. An earlier revision solved that with a
# scoped `GATE_GH_CR` used only by these two regexes; the widening made it
# redundant and it was DELETED rather than left beside its live twin.
GATE_RE_GH_ISSUE_CREATE="^gh${GATE_GH_C}[[:space:]]+issue[[:space:]]+create([[:space:]]|$)"
# The same mint through the REST verb. `gh api repos/<o>/<r>/issues` with a
# `title=` field creates an issue; the path must NOT continue past `issues`,
# which is what separates it from `/issues/<n>/comments` (a comment) and
# `/issues/<n>` (an edit) — neither of which mints anything. Over-approximate
# the TRIGGER, be strict on RESOLUTION: the gate re-reads the body itself.
GATE_RE_GH_API_ISSUE_CREATE="^gh${GATE_GH_C}[[:space:]]+api([[:space:]]|$).*repos/[^[:space:]/]+/[^[:space:]/]+/issues([[:space:]]|$|\")"
# issue-classification-label-gate: the CLAIM site. Most open bodies are still in
# the old packed shape and are upgraded to the four-line shape when the issue is
# claimed, so `edit` -- not `create` -- is where `Severity` first exists for the
# bulk of the backlog. `comment` stays absent: a comment is not the issue's
# classification. (`create` and the REST mint are the constants above; that gate
# uses all three.)
GATE_RE_GH_ISSUE_EDIT="^gh${GATE_GH_C}[[:space:]]+issue[[:space:]]+edit([[:space:]]|$)"

# main-tree-branch-gate: the two verbs that move a working tree onto another
# branch.
#
# TWO CONSTANTS, NOT ONE `(switch|checkout)` ALTERNATION, and that is forced
# rather than stylistic: the gate's verdict depends on the TAIL, and the tail
# cannot be read without knowing which verb fired. `-c` CREATES a branch under
# `switch` and is a per-command CONFIG OVERRIDE under `checkout`; `-b` creates
# under `checkout` and does not exist under `switch`. A combined regex arms the
# gate correctly and then leaves it guessing which grammar to parse.
GATE_RE_GIT_SWITCH="^git${GATE_FLAGS}[[:space:]]+switch([[:space:]]|$)"
GATE_RE_GIT_CHECKOUT="^git${GATE_FLAGS}[[:space:]]+checkout([[:space:]]|$)"

# gate_re_any <ere>... — combine several anchored segment regexes into ONE.
#
# Gates that guard more than one verb used to HAND-ROLL a combined regex, and
# every hand-rolled copy drifted from the shared constants: on 2026-08-25
# verify-pr-gate, non-english-text-gate and bughunt-clean-gate each carried their
# own `gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?` and therefore missed
# `gh -R <owner/repo> pr merge` even after `GATE_GH_C` was widened here. A local
# copy of a shared pattern is a copy that stops being shared.
#
# Each input keeps its own `^`; they are stripped and re-anchored once so the
# result still means "at the START of a segment".
gate_re_any() {
  local out="" re
  for re in "$@"; do
    re="${re#^}"
    out="${out:+$out|}($re)"
  done
  printf '^(%s)' "$out"
}

# A token that keeps a QUOTED value whole. A plain word-split makes
# `--subject "chore: x" 2195` three tokens, so a flag consumes `"chore:` and the
# walk then reads `x"` — the same tokenisation defect as a `-C` inside a quoted
# path. Held in a variable because a literal `[[ =~ ]]` pattern cannot carry both
# quote characters inside one bracket expression.
GATE_EMBEDDING_TOKEN='(("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]"'"'"'])+)'

# gate_tokens <string>
# One shell-ish token per line, quoted spans kept whole.
gate_tokens() {
  local s="$1"
  while [[ "$s" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN ]]; do
    printf '%s\n' "${BASH_REMATCH[1]}"
    s="${s:${#BASH_REMATCH[0]}}"
  done
  # TRUNCATION IS REPORTED, not swallowed. An UNBALANCED quote cannot be split
  # into words at all: `"[^"]*"` needs its closing quote and the bare-run
  # alternative excludes quote characters, so the pattern stops dead at the
  # opening one. Measured before this line existed: `gate_tokens "a'unbalanced"`
  # printed NOTHING and returned 0, and `gate_tokens "-b agent's-branch"`
  # printed only `-b` -- so a caller parsing an option grammar saw a command
  # with no arguments and allowed it. Silence is the one answer that is wrong
  # here; a caller can now refuse, or fall back to a coarser scan, but it can no
  # longer mistake a truncation for a short command line.
  [ -z "${s//[[:space:]]/}" ]
}

# gate_word_is_literal <word>
#
# 0 when this shell WORD provably reaches the command as exactly the text it
# already carries; 1 when it does not, OR when this function cannot prove that
# it does. It is the SHELL-side twin of `main-tree-branch-gate.sh`'s "AN
# INCOMPLETE PARSE MAY NOT ALLOW": that gate refuses to relax a verdict on a GIT
# OPTION it cannot resolve, and this refuses to hand it a WORD whose expansion
# it cannot see.
#
# THE DEFAULT IS INVERTED, and that is the whole of this function. `gate_argv`
# below used to ENUMERATE the words the shell owns -- a redirection, a trailing
# `&`, a `#` comment -- and pass everything else through as an argument. Three
# rounds of fixes each added another spelling to that list, and each time the
# next round found the spelling still missing. Measured, in all three repos,
# with a branch that exists locally and the payload cwd set to the main tree:
#
#   git checkout <branch> $EMPTY            rc=0, want 2   HEAD MOVED
#   git checkout <branch> ${EMPTY}          rc=0, want 2   HEAD MOVED
#   git checkout <branch> {fd}>/dev/null    rc=0, want 2   HEAD MOVED
#   git checkout <branch> {fd}<f.txt        rc=0, want 2   HEAD MOVED
#
# An empty expansion VANISHES, so the gate counted a positional git never
# receives; bash's fd-variable redirection is a word git never receives at all.
# Both turned `git checkout <branch> <word>` into a two-positional FILE RESTORE
# and PASSED a command that really moves HEAD.
#
# So the question here is not "is this word one of the shell forms I know?" but
# "is every character in it one I can prove the shell leaves alone?".
#
# HOW A SHAPE NOBODY HAS THOUGHT OF LANDS ON REFUSE. Every shell construct is
# SPELLED, and spelled with characters. `GATE_INERT_CHARS` is a CLOSED list of
# characters that trigger no shell processing at all, so a construct built from
# anything else -- a syntax added to a future bash, one this file's author never
# met, one nobody has written down -- necessarily contains a character outside
# that list, and is refused without anyone having had to think of it. The only
# way a new construct could pass is by being spelled ENTIRELY in inert
# characters, which is a contradiction in terms: an inert character is one the
# shell does not act on. The list, not the construct catalogue, is therefore the
# thing to audit, and every member carries the reason it is inert.
#
# THE INERT SET, one character at a time. `A-Z a-z 0-9` need no argument.
#
#   _ - . / :   no shell meaning in any position. A leading `-` only makes the
#               word look like a flag, which is git's business, not the shell's.
#   @ +         special only as the extglob prefixes `@(...)` / `+(...)`, which
#               need `(`, and `(` is NOT inert.
#   ^           special only inside a `[^...]` bracket expression, which needs
#               `[`, and `[` is NOT inert. (History's `^old^new` is line-initial
#               and interactive-only.) `HEAD^` needs it.
#   %           special only as a JOB SPEC, and only as an argument to `jobs` /
#               `kill` / `fg` / `bg` -- never to `git`.
#   ,           special only inside a brace expansion, which needs `{`, and `{`
#               is NOT inert.
#   =           an assignment only in the COMMAND-word position, and every word
#               asked about here is an argument, past the verb. It must be here:
#               `--create=feat` is an ordinary long option.
#   #           a comment only as the FIRST character of a word, which is
#               rejected explicitly below. `has#hash` is a legal branch name and
#               the shell passes it through untouched.
#
# WHAT IS DELIBERATELY OUT, so the cost is visible rather than guessed. `$` and
# a backtick (an expansion this cannot see). `\` (an escape). `*` `?` `[` `]`
# (pathname expansion -- and under `nullglob` a non-matching pattern expands to
# NO words, the vanishing case again). `{` `}` (brace expansion, and the
# fd-variable redirection prefix `{fd}>`). `~` (tilde expansion). `!` (history
# expansion: off in a non-interactive shell, but this cannot see which shell it
# is). Every shell METACHARACTER -- `| & ; ( ) < >` and whitespace -- which the
# segmenter and tokenizer normally consume, so one arriving here is by
# definition unaccounted for. Two exclusions are strictly OVER-strict: `a~b` and
# `feat!` are literal to bash and this refuses them anyway. Over-strict means
# BLOCK, which is the direction this gate exists to fail in.
#
# QUOTING IS TRACKED, because it is what makes the punctuation above reachable.
# A word may EMBED quoted spans rather than BE one (see GATE_EMBEDDING_TOKEN),
# so the walk carries a quote state:
#   - inside a SINGLE-quoted span every character is literal, so nothing is
#     refused there;
#   - inside a DOUBLE-quoted span only `$`, a backtick and `\` stay active, so
#     only those three are refused;
#   - outside quotes the inert list decides.
# That is what keeps `git checkout -b 'feat$x'` an ordinary branch creation --
# a literal `$` in a branch name still behaves -- while an unquoted `$EMPTY` is
# refused.
#
# A word whose quote is still open at the end is refused too: it cannot be split
# into shell words at all, which is the same thing `gate_tokens` reports.
#
# WHAT THIS DOES NOT DECIDE: whether the word is an ARGUMENT. A redirection is
# spelled with `>` and would be refused here, yet it is perfectly accounted for
# -- `gate_argv` recognises it and drops it BEFORE asking this. Recognising a
# shell construct positively and proving a word literal are two different jobs,
# and only the second one has to fail closed.
GATE_INERT_CHARS='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-./:@+%,^=#'
# The same set as a GLOB CLASS, so a whole SPAN is decided in one operation
# rather than one character at a time. That is not a micro-optimisation: a hook
# runs on EVERY Bash tool call, and a per-character walk here is quadratic,
# because `${s:i:1}` in a UTF-8 locale walks to offset `i` every time. Measured
# on this machine (bash 5.3.9, en_US.UTF-8), an index-only loop over a string:
# 1 000 chars 0.010 s, 4 000 chars 0.043 s, 16 000 chars 0.478 s -- 16x the
# input for 48x the time. The chunked form below is 0.032 s at 16 000.
#
# `-` is LAST and `^` is not first, which is what keeps both LITERAL inside a
# bracket expression; `!` negates.
GATE_NOT_INERT_GLOB='*[!A-Za-z0-9_./:@+%,^=#-]*'
# Active inside a DOUBLE-quoted span: an expansion, a command substitution, an
# escape. Written with `$'...'` so the backslash and the backtick survive.
GATE_DQ_ACTIVE_GLOB=$'*[\\\\$\140]*'
GATE_QUOTE_CLASS=$'["\047]'
GATE_SQ=$'\047'
# The characters that end a scanning chunk. `$'[\\\\"\047#]'` yields `[\\"'#]`,
# and that doubling is load-bearing: `[\"'#]` does NOT contain a backslash --
# there the backslash escapes the quote and the class silently loses it.
# Verified in BOTH bash 3.2.57 and 5.3.9 against `ab\cd`, `ab"cd`, `ab'cd`,
# `abc#d` and `abcd`.
GATE_CHUNK_STOP=$'[\\\\"\047#]'
GATE_CHUNK_STOP_DQ=$'[\\\\"]'

gate_word_is_literal() {
  local w="$1" rest="$1" chunk q=""
  [ -n "$w" ] || return 1
  # A word STARTING with `#` opens a comment: the shell discards it and every
  # word after it, so it reaches the command as nothing at all.
  case "$w" in '#'*) return 1 ;; esac
  # The walk advances by SPANS, not characters: everything up to the next quote
  # character is tested with one glob, so the number of iterations is the number
  # of quote characters in the word rather than its length.
  while [ -n "$rest" ]; do
    if [ -z "$q" ]; then
      chunk="${rest%%$GATE_QUOTE_CLASS*}"
      case "$chunk" in $GATE_NOT_INERT_GLOB) return 1 ;; esac
      [ "$chunk" = "$rest" ] && break
      rest="${rest#"$chunk"}"
      q="${rest%"${rest#?}"}"
      rest="${rest#?}"
    elif [ "$q" = "$GATE_SQ" ]; then
      # Inside a SINGLE-quoted span every character is literal, so there is
      # nothing to test -- only the closer to find.
      chunk="${rest%%$GATE_SQ*}"
      [ "$chunk" = "$rest" ] && break
      rest="${rest#"$chunk"}"
      rest="${rest#?}"
      q=""
    else
      chunk="${rest%%\"*}"
      case "$chunk" in $GATE_DQ_ACTIVE_GLOB) return 1 ;; esac
      [ "$chunk" = "$rest" ] && break
      rest="${rest#"$chunk"}"
      rest="${rest#?}"
      q=""
    fi
  done
  # A quote still open means the word cannot be split into shell words at all.
  [ -z "$q" ]
}

# gate_strip_comment <text>
#
# <text> truncated at the first `#` that opens a shell COMMENT -- one at a WORD
# START (the beginning of the text, or after a space or tab) and outside any
# quoted span. Prints the text unchanged when there is none.
#
# WHY IT RUNS BEFORE THE SPLIT, which is the bug it fixes. `gate_argv` used to
# ask `gate_tokens` to split the WHOLE text and refuse on an unbalanced quote,
# then drop the comment inside the walk. An apostrophe INSIDE the comment is
# therefore weighed as a quote, so
#
#   git checkout main # don't switch lanes
#
# came back as a truncation and the gate blocked it -- measured rc=2 against a
# command that leaves HEAD exactly where it was ("Already on 'main'"). The
# comment justifying that order claimed "the text is a shell syntax error in the
# first place, so nothing legitimate is lost". That claim is FALSE and is not
# repeated: `bash -n "git checkout main # don't switch lanes"` reports VALID
# syntax, because the apostrophe is inside a comment and bash never sees it as a
# quote either. Cutting the comment first makes this file agree with the shell.
#
# The unbalanced-quote refusal it is often confused with survives untouched:
# `-b agent's-branch` has no comment to cut, so the text reaches `gate_tokens`
# whole and is still refused.
#
# THE SECOND PASS is `gate_segments_raw`'s `ignore_q` trick, for the same reason
# and with the same shape. If the first walk reaches the end with a quote still
# open, that character may not have been a quote at all, so the walk is redone
# with it literal and a comment is looked for again. `'unbalanced # x` then cuts
# to `'unbalanced `, which `gate_tokens` still refuses -- correctly: bash calls
# that one "unexpected EOF while looking for matching `''".
GATE_COMMENT_CUT=""
GATE_COMMENT_OPENQ=""
_gate_comment_cut() {
  local s="$1" iq="$2" rest="$1" pos=0 chunk c q="" prev=" "
  GATE_COMMENT_CUT="$s"
  GATE_COMMENT_OPENQ=""
  # A text with NO `#` anywhere can carry no comment, and that is the shape
  # essentially every command has. Returning here keeps the walk below off the
  # hot path entirely -- measured, 16 000 characters go from 0.92 s to 0.002 s.
  case "$s" in *'#'*) ;; *) return 0 ;; esac
  # SPANS, not characters, for the reason recorded on GATE_NOT_INERT_GLOB above:
  # a per-character walk is quadratic here. Each iteration jumps to the next
  # quote / backslash / `#`, so the iteration count is the number of those
  # characters rather than the length of the text. Only the CUT OFFSET is
  # tracked; the text is sliced once, at the end.
  while [ -n "$rest" ]; do
    if [ -z "$q" ]; then
      chunk="${rest%%$GATE_CHUNK_STOP*}"
    elif [ "$q" = "$GATE_SQ" ]; then
      chunk="${rest%%$GATE_SQ*}"
    else
      chunk="${rest%%$GATE_CHUNK_STOP_DQ*}"
    fi
    [ "$chunk" = "$rest" ] && break
    if [ -n "$chunk" ]; then
      prev="${chunk#"${chunk%?}"}"
      pos=$((pos + ${#chunk}))
      rest="${rest#"$chunk"}"
    fi
    c="${rest%"${rest#?}"}"
    if [ -z "$q" ]; then
      case "$c" in
        # An escaped character outside quotes is LITERAL, `\#` included. The
        # slice is `${rest:2}` rather than `${rest#??}`: with ONE character left
        # the `##` form matches nothing, leaves `rest` unchanged, and the loop
        # never terminates.
        '\') pos=$((pos + 2)); rest="${rest:2}"; prev=x; continue ;;
        '#') case "$prev" in
               ' '|'	') GATE_COMMENT_CUT="${s:0:pos}"; return 0 ;;
             esac ;;
        '"') [ "$c" = "$iq" ] || q="$c" ;;
        *) [ "$c" = "$GATE_SQ" ] && { [ "$c" = "$iq" ] || q="$c"; } ;;
      esac
    else
      if [ "$c" = '\' ] && [ "$q" = '"' ]; then
        pos=$((pos + 2)); rest="${rest:2}"; prev=x; continue
      fi
      [ "$c" = "$q" ] && q=""
    fi
    prev="$c"
    pos=$((pos + 1))
    rest="${rest#?}"
  done
  GATE_COMMENT_CUT="$s"
  GATE_COMMENT_OPENQ="$q"
  [ -z "$q" ]
}

gate_strip_comment() {
  if _gate_comment_cut "$1" ""; then
    printf '%s' "$GATE_COMMENT_CUT"
    return 0
  fi
  _gate_comment_cut "$1" "$GATE_COMMENT_OPENQ"
  printf '%s' "$GATE_COMMENT_CUT"
  return 0
}

# gate_argv <text>
#
# The ARGV a shell would hand the command, one token per line: the SHELL's own
# words are dropped -- a comment and everything after it, a redirection and,
# when it is not glued, its target. Returns 1 having printed nothing when the
# text cannot be split into words at all (the `gate_tokens` truncation), so a
# caller can refuse rather than parse a fragment.
#
# WHY THIS IS A SEPARATE FUNCTION FROM `gate_tokens`, and why an option parse
# must call THIS one. A gate that reads an option grammar is reading ARGV -- the
# vector the command itself receives -- and a shell WORD is not an ARGUMENT.
# `2>/dev/null`, `>`, `/dev/null` and `# switch lane` are all words, and git
# never sees any of them. Measured against the gate that first parsed
# `gate_tokens` output directly, with a branch that existed locally:
#
#   git checkout <branch> 2>/dev/null      rc=0, want 2
#   git checkout <branch> >/dev/null 2>&1  rc=0, want 2
#   git checkout <branch> # switch lane    rc=0, want 2
#
# -- every one a command that really moves HEAD, waved through because the extra
# WORDS were counted as extra ARGUMENTS and the command therefore read as a file
# restore. Callers that genuinely want the shell's words (a `-C` scan, a heredoc
# probe) keep `gate_tokens`; callers that want git's argv use this.
#
# WHAT IT DOES NOT PROMISE, stated because an earlier revision's silence here is
# the defect round 4 fixed: a line printed by this function is a shell WORD that
# is not a redirection and not a comment. It is NOT a promise that the word
# reaches the command as the text printed. `$EMPTY` is printed and reaches the
# command as NOTHING; `{fd}>/dev/null` is printed and reaches it as nothing
# either. A caller that COUNTS these words, or compares one against a name, must
# put every word through `gate_word_is_literal` and refuse to relax its verdict
# on a word that fails -- which is exactly what `main-tree-branch-gate.sh` does
# with `parse_certain`. Enumerating more shell forms HERE is the losing move; it
# was tried three times.
#
# The comment strip is deliberately NOT in `gate_segments`: that splitter feeds
# every gate in this library, and widening it is a change to all of them. Here
# the effect is bounded to callers that asked for argv.
GATE_REDIR_TOKEN='^([0-9]*(>>|>[|]|>&|>|<<<|<<-|<<|<&|<)|&>>|&>)(.*)$'

gate_argv() {
  local words tok want_target=0 text
  # The comment goes FIRST, before the split, so an apostrophe inside one is
  # never weighed as a quote (see `gate_strip_comment`). That also makes the
  # in-loop `'#'*` arm this function used to carry unreachable, so it is gone
  # rather than left as a second spelling of the same rule.
  text=$(gate_strip_comment "$1")
  words=$(gate_tokens "$text") || return 1
  while IFS= read -r tok; do
    # `gate_tokens` never emits an empty token (its pattern needs one character
    # at least), so the single blank line a `printf` of empty output produces is
    # the only thing this skips.
    [ -n "$tok" ] || continue
    if [ "$want_target" -eq 1 ]; then
      # The spaced target of the redirection operator just seen (`> /dev/null`).
      # It is dropped WITHOUT asking `gate_word_is_literal`, deliberately: a
      # redirection target is never an argument whatever it expands to. An empty
      # expansion there makes bash refuse the command outright ("ambiguous
      # redirect"), and a multi-word one is the same error -- neither can put a
      # word into argv.
      want_target=0
      continue
    fi
    # A bare `&`. On the GATE's path this is dead -- `gate_segments_raw` has
    # already split on it -- and it is kept because a DIRECT caller (this
    # library's own suite, a future gate parsing a raw fragment) still meets it.
    # Labelled rather than removed so the next reader does not re-derive that.
    [ "$tok" = '&' ] && continue
    if [[ "$tok" =~ $GATE_REDIR_TOKEN ]]; then
      # `2>&1` and `>/dev/null` carry their target GLUED; a bare `>` or `2>`
      # takes the next word as its target.
      [ -n "${BASH_REMATCH[3]}" ] || want_target=1
      continue
    fi
    printf '%s\n' "$tok"
  done <<EOF
$words
EOF
  return 0
}



# `gh pr merge` / `gh pr edit` flags that take NO value. Everything else that
# looks like a flag is assumed to consume the next token.
#
# BOTH SPELLINGS OF EVERY FLAG. The first version listed only the long forms, so
# all four short ones fell to the value-consuming arm and ATE the PR number --
# `gh pr merge -s 2195`, `-d`, `-m`, `-r` and `--squash -d 2195` all returned an
# empty selector. Taken from `gh help pr merge` / `gh help pr edit` rather than
# from memory:
#
#   pr merge, valueless: --admin --auto --disable-auto -d/--delete-branch
#                        -m/--merge -r/--rebase -s/--squash --help
#   pr merge, VALUE:     -A/--author-email -b/--body -F/--body-file
#                        --match-head-commit -t/--subject -R/--repo
#   pr edit,  valueless: --remove-milestone --help
#
# `-m` COLLIDES: it is `--merge` (valueless) for `pr merge` and `--milestone`
# (value-taking) for `pr edit`, and this one list serves both. It is listed as
# VALUELESS because of what each mistake costs. Read as valueless on `pr edit`,
# `gh pr edit -m "Q3 milestone" 42` leaves a quoted non-numeric token that the
# numeric guard drops, so the selector is EMPTY -- a fallback. Read as
# value-taking on `pr merge`, `-s 2195` loses the number, which is the blocker
# above. Only a milestone literally NAMED a number could mis-resolve, and it
# would have to be the first token after the flag.
#
# ON THE STALENESS DIRECTION -- AND THE EARLIER VERSION OF THIS COMMENT WAS
# OVERSTATED, SO THE CORRECTION MATTERS MORE THAN THE CLAIM. It said enumerating
# valueless flags "goes stale the SAFE way: the selector comes back EMPTY and the
# caller falls back or refuses". Measured: empty does NOT make ci-green-gate
# refuse. It runs `gh pr checks` with no argument, which resolves the CURRENT
# BRANCH's PR -- correct from that PR's own worktree, wrong anywhere else -- and
# when nothing resolves at all the output matches its `no pull requests found`
# fail-open and the merge PASSES. `gh pr merge -s 2195` merged past red CI that
# way.
#
# The accurate statement: WRONG-PR IS SEVERE AND DETERMINISTIC; EMPTY-PR IS A
# FALLBACK WHOSE SAFETY DEPENDS ON THE CALLER. The polarity argument is real but
# BOUNDED, and it is not a substitute for listing both spellings of every flag.
# So this list is now exhaustive against `gh help`, and ci-green-gate no longer
# treats "empty" as automatically safe: `gate_pr_selector_ate_number` below tells
# "no selector was given" apart from "a flag swallowed one", and the gate refuses
# the second.
GATE_GH_PR_VALUELESS_FLAGS='--squash|-s|--merge|-m|--rebase|-r|--delete-branch|-d|--auto|--disable-auto|--admin|--remove-milestone|--help'

# gate_pr_selector <command> <verb-ere>
#
# The PR NUMBER after the matched verb, taken from the segment that matched.
# Empty when there is none, or when what is there is not a number.
#
# FOURTH ITERATION of the same bug, so the history is worth keeping. Each fix
# moved the bypass one step later rather than closing it:
#
#   1. a literal `${cmd##*gh pr merge}` strip — any global flag made it fail to
#      apply, and the caller read back the command name `gh`.
#   2. an anchor requiring the number IMMEDIATELY after the verb — `gh` does not
#      require that order, so `gh pr merge --squash 1` lost the selector.
#   3. skipping tokens that start with `-` but not their VALUES — so a flag value
#      became the selector. Measured before this fix:
#
#        gh pr merge -t msg 2195 --squash                sel=msg
#        gh pr merge --match-head-commit abc 2195        sel=abc
#        gh pr merge --subject "chore: x" 2195 --squash  sel=chore:
#        gh pr merge --body-file 7 2195 --squash         sel=7   <- audits PR 7
#        gh pr merge -F notes.md 2195 --squash           sel=notes.md
#
#      strictly worse than (1), where a non-numeric selector left the value empty
#      and gh fell back to the current branch, which BLOCKED.
#
# Three things close it, and all three are needed: consuming values for every
# flag not known to be valueless (above), keeping a quoted value in ONE token
# (GATE_EMBEDDING_TOKEN), and the final numeric guard below — the backstop that
# makes the flag list's staleness harmless, since every caller wants a NUMBER and
# anything else (branch, URL, slug, or a flag value that slipped through) must
# come back empty rather than be handed on.
#
# The verb regexes are anchored at `^`, so the match starts at offset 0 and its
# LENGTH is a safe strip; `${segment#${BASH_REMATCH[0]}}` is not, because the
# matched text would be treated as a glob pattern.
# _gate_pr_selector_walk <command> <verb-ere>
# Two lines: the selector (possibly empty), then 1/0 for "a flag consumed a
# purely NUMERIC token". One walk, two questions, so the two answers cannot drift
# apart the way two copies of a walk would.
_gate_pr_selector_walk() {
  local cmd="$1" re="$2" segment rest tok skip=0 v ate=0
  while IFS= read -r segment; do
    [[ "$segment" =~ $re ]] || continue
    rest="${segment:${#BASH_REMATCH[0]}}"
    skip=0; ate=0
    while IFS= read -r tok; do
      [ -n "$tok" ] || continue
      if [ "$skip" = "1" ]; then
        skip=0
        case "$(gate_unquote "$tok")" in
          ''|*[!0-9]*) ;;
          *) ate=1 ;;
        esac
        continue
      fi
      case "$tok" in
        # `--flag=value` / `-R=value` carry their own value.
        -*=*) continue ;;
        # A single-dash flag longer than two characters is a GLUED value
        # (`-Rowner/repo`), which pflag accepts and which is self-contained.
        -[!-]?*) continue ;;
        -*)
          [[ "$tok" =~ ^($GATE_GH_PR_VALUELESS_FLAGS)$ ]] || skip=1
          continue ;;
      esac
      v=$(gate_unquote "$tok")
      # THE NUMERIC GUARD. Not a PR number -> empty, never handed on.
      case "$v" in
        ''|*[!0-9]*) printf '\n%s\n' "$ate"; return 0 ;;
        *) printf '%s\n%s\n' "$v" "$ate"; return 0 ;;
      esac
    done < <(gate_tokens "$rest")
    printf '\n%s\n' "$ate"
    return 0
  done < <(gate_segments "$cmd")
  printf '\n0\n'
  return 0
}

gate_pr_selector() {
  _gate_pr_selector_walk "$1" "$2" | sed -n 1p
}

# gate_pr_selector_ate_number <command> <verb-ere>
# 0 when a FLAG consumed a purely numeric token. Callers use it to tell
# `gh pr merge --squash` (no selector given -- a legitimate current-branch
# operation) from `gh pr merge --future-flag 552` (a selector was given and a
# flag swallowed it), which the selector alone reports identically as empty.
gate_pr_selector_ate_number() {
  [ "$(_gate_pr_selector_walk "$1" "$2" | sed -n 2p)" = "1" ]
}

# gate_repo_flag <command> <verb-ere>
# The `-R` / `--repo` value carried by the MATCHED segment, in any spelling gh
# accepts (space, `=`, glued). Empty when the command names no repo.
#
# TOKENISED, so a `-R` inside a quoted value is not mistaken for the flag:
# `gh pr merge --subject "compare with -R other/repo" 5` names no repo.
gate_repo_flag() {
  local cmd="$1" re="$2" segment tok want
  while IFS= read -r segment; do
    [[ "$segment" =~ $re ]] || continue
    # Reset per segment: a dangling `want` from an earlier segment would make the
    # next segment's first token look like a repo value. Benign today (the walk
    # returns from the first matching segment) and one refactor away from not.
    want=0
    while IFS= read -r tok; do
      [ -n "$tok" ] || continue
      if [ "$want" = "1" ]; then printf '%s' "$(gate_unquote "$tok")"; return 0; fi
      case "$tok" in
        -R|--repo)  want=1 ;;
        -R=*)       printf '%s' "$(gate_unquote "${tok#-R=}")"; return 0 ;;
        --repo=*)   printf '%s' "$(gate_unquote "${tok#--repo=}")"; return 0 ;;
        -R?*)       printf '%s' "$(gate_unquote "${tok#-R}")"; return 0 ;;
      esac
    done < <(gate_tokens "$segment")
    return 0
  done < <(gate_segments "$cmd")
  return 0
}

# gate_normalize_repo_slug <value>
# `owner/repo`, lowercased, from any spelling gh itself accepts for `-R` or that
# a git remote can carry: `owner/repo`, `owner/repo.git`, `github.com/owner/repo`,
# `https://github.com/owner/repo.git`, `ssh://git@github.com/owner/repo`,
# `git@github.com:owner/repo.git`. Empty when there is no `owner/repo` in it.
#
# ONE normaliser for BOTH sides of the comparison, because the foreign-repo check
# refused gh's own spellings of the CURRENT repo — `-R github.com/owner/repo` and
# `-R Owner/Repo` (GitHub slugs are case-insensitive) were both reported foreign,
# and the refusal then told you to run the command from a checkout you were
# already standing in.
gate_normalize_repo_slug() {
  local v="$1"
  v="${v#*://}"          # scheme
  v="${v#*@}"            # user@
  v="${v/:/\/}"          # scp-style `host:owner/repo`
  v="${v%/}"
  v="${v%.git}"
  v="${v%/}"
  printf '%s' "$v" | awk -F/ 'NF>=2 { printf "%s/%s", $(NF-1), $NF }' | tr '[:upper:]' '[:lower:]'
}

# gate_local_repo_slug <dir>
# `owner/repo` from the git remote, WITHOUT calling gh — no network, no auth, so
# a gate can use it on a runner. Empty when there is no usable remote.
gate_local_repo_slug() {
  local dir="$1" url
  url=$(git -C "$dir" remote get-url origin 2>/dev/null) || return 0
  gate_normalize_repo_slug "$url"
}

# gate_foreign_repo <command> <verb-ere> <target-dir>
# The repo named on the command line when it is NOT the repo the command would
# otherwise be audited against. Empty when the command names none, or names this
# one. The NAMED value is printed unnormalised, so the refusal quotes what was
# actually typed.
#
# WHY GATES CARE. `-R` was matched by the flag absorber and then DISCARDED: every
# gate runs its probes from the RESOLVED CWD, so `gh -R foreign/repo pr merge 5`
# made each gate audit THIS repo and then permit a merge in one it never looked
# at.
#
# Unresolvable local slug counts as FOREIGN: if the gate cannot prove the named
# repo is the one it just audited, it has not audited the right thing.
gate_foreign_repo() {
  local named local_slug
  named=$(gate_repo_flag "$1" "$2")
  [ -n "$named" ] || return 0
  local_slug=$(gate_local_repo_slug "$3")
  [ "$(gate_normalize_repo_slug "$named")" = "$local_slug" ] && [ -n "$local_slug" ] && return 0
  printf '%s' "$named"
}

# Strip one layer of surrounding quotes from a path token.
gate_unquote() {
  local p="$1"
  p="${p%\"}"; p="${p#\"}"
  p="${p%\'}"; p="${p#\'}"
  printf '%s' "$p"
}

# gate_target_dir <cmd> <fallback> <extended-regex>
# The working tree the gated command will actually run in:
#   1. a `-C <path>` inside the MATCHED segment wins (git -C / gh -C), else
#   2. the last `cd <path>` segment BEFORE the matched one, else
#   3. the fallback (the hook payload's cwd).
# Quoted paths survive: segments carry their original text (see the header).
gate_target_dir() {
  local cmd="$1" fallback="$2" re="$3"
  local target="$fallback" segment cd_target c_target remaining
  while IFS= read -r segment; do
    if [[ "$segment" =~ ^cd[[:space:]]+$GATE_PATH_TOKEN ]]; then
      cd_target=$(gate_unquote "${BASH_REMATCH[1]}")
      # An UNEXPANDED path is not a path. `cd "$WT" && …` is the spelling this
      # flow mandates, and resolving it literally produced `<cwd>/$WT`, which no
      # `git -C` can read — so the gate could not resolve a tree and exited 0.
      # Skipping it falls back to the payload cwd, which fails CLOSED
      # (go-to-k/cdkd#2130 review).
      case "$cd_target" in *'$'*|*'`'*) continue ;; esac
      [ -z "$cd_target" ] && continue
      [[ "$cd_target" != /* ]] && cd_target="$target/$cd_target"
      target="$cd_target"
      continue
    fi
    [[ "$segment" =~ $re ]] || continue
    # Last `-C <path>` in this segment wins over any earlier cd.
    if [[ "$segment" =~ (git|gh)[[:space:]]+-C[[:space:]]+$GATE_PATH_TOKEN ]]; then
      c_target=""
      remaining="$segment"
      while [[ "$remaining" =~ (git|gh)[[:space:]]+-C[[:space:]]+$GATE_PATH_TOKEN ]]; do
        c_target="${BASH_REMATCH[2]}"
        remaining="${remaining#*"${BASH_REMATCH[0]}"}"
      done
      c_target=$(gate_unquote "$c_target")
      case "$c_target" in *'$'*|*'`'*) c_target="" ;; esac
      if [ -n "$c_target" ]; then
        [[ "$c_target" != /* ]] && c_target="$target/$c_target"
        target="$c_target"
      fi
    fi
    break
  done < <(gate_segments "$cmd")
  printf '%s' "$target"
}

# gate_verb_args_dir <cmd> <fallback-dir> <extended-regex>
#
# One "<dir><TAB><args-after-the-verb>" line per MATCHING SEGMENT: the working
# tree that segment runs in, and the text following the verb the ERE matched.
#
# WHY THE TREE HAS TO COME OUT OF THE SAME WALK AS THE ARGUMENTS.
# `gate_target_dir` answers for the WHOLE COMMAND — its walk BREAKS at the first
# matching segment — so a gate that judges every segment judges them all against
# segment 1's tree. That is a BYPASS in one direction and a FALSE BLOCK in the
# other, and both were measured live in the sibling repos before this shape
# landed, driving main-tree-branch-gate with a payload cwd of the MAIN checkout:
#
#   git -C <worktree> switch -c a && git switch -c b       rc=0, want 2  BYPASS
#   git -C <worktree> checkout -b a && git checkout -b b   rc=0, want 2  BYPASS
#   git switch main && git -C <worktree> switch -c a       rc=2, want 0  FALSE BLOCK
#
# The bypass lets a branch be created in the SHARED main checkout unjudged — the
# `git fetch && git switch -c` hole one operator further along. The false block
# refuses a branch creation INSIDE a linked worktree, which is exactly what the
# worktree convention mandates.
#
# WHY THE ARGUMENTS COME FROM `BASH_REMATCH[0]` rather than a local prefix strip:
# the strip is then the SAME constant that armed the gate, whatever flag run it
# swallowed, so a gate can never trigger one way and parse another. This is
# `gate_pr_selector`'s guarantee, given to callers that want something other than
# a PR number.
#
# Callers split the line with `${line%%<TAB>*}` / `${line#*<TAB>}`, NOT with
# `IFS=$'\t' read -r dir args`: tab is IFS whitespace, so that spelling folds a
# TAB RUN inside the args and silently drops one.
#
# The `cd` / `-C` reading is a deliberate COPY of `gate_target_dir`'s rather than
# a shared helper: that function BREAKS at the verb, which is the one thing this
# walk must not do, and it has other callers riding on that. `_command-match.test.sh`
# pins the two against each other on the single-segment shape so the copy cannot
# drift silently.
#
# The `-C` read goes through `gate_tokens` rather than `gate_target_dir`'s
# `(git|gh)[[:space:]]+-C[[:space:]]+` regex, so the GLUED spellings `-C=<path>`
# and `-C<path>` resolve here too. That is a deliberate DIVERGENCE from
# `gate_target_dir`, in the fail-closed direction: a `-C` this walk can read is a
# tree this walk can judge.
#
# BOUND, STATED RATHER THAN HIDDEN. An UNREADABLE `-C` value (an unexpanded
# `$VAR`, a backtick) is dropped and the segment falls back to the running `cd`
# state, exactly as `gate_target_dir` does. From the MAIN checkout — the case
# this gate exists for — that fallback IS the main tree, so the segment is still
# judged and the gate fails CLOSED. From inside a linked worktree it falls back
# to the worktree and passes; refusing there instead would need a
# `gate_refuse_unresolved_target` contract this repo's gates do not have, and
# adding one silently changes the verdict of every `$VAR`-carrying command.
gate_verb_args_dir() {
  local cmd="$1" fallback="$2" re="$3"
  local target="$fallback" segment cd_target c_target verb_run seg_target tok want_c
  while IFS= read -r segment; do
    if [[ "$segment" =~ ^cd[[:space:]]+$GATE_PATH_TOKEN ]]; then
      cd_target=$(gate_unquote "${BASH_REMATCH[1]}")
      # An UNEXPANDED path is not a path. Skipping it leaves the running target
      # where it was, which for this gate's own subject is the payload cwd — the
      # fail-CLOSED direction (go-to-k/cdkd#2130 review).
      case "$cd_target" in *'$'*|*'`'*) continue ;; esac
      [ -z "$cd_target" ] && continue
      [[ "$cd_target" != /* ]] && cd_target="$target/$cd_target"
      target="$cd_target"
      continue
    fi
    [[ "$segment" =~ $re ]] || continue
    # Saved BEFORE the token walk: every `[[ =~ ]]` below overwrites BASH_REMATCH.
    verb_run="${BASH_REMATCH[0]}"
    # A `cd` PERSISTS into the next segment; a `-C` binds only its own command.
    # So the segment starts from the running cd state and is overridden LOCALLY,
    # never written back to `target`.
    seg_target="$target"
    c_target=""
    want_c=0
    while IFS= read -r tok; do
      if [ "$want_c" = 1 ]; then c_target="$tok"; want_c=0; continue; fi
      case "$tok" in
        -C=*) c_target="${tok#-C=}" ;;
        -C) want_c=1 ;;
        -C?*) c_target="${tok#-C}" ;;
      esac
    done < <(gate_tokens "$verb_run")
    if [ -n "$c_target" ]; then
      c_target=$(gate_unquote "$c_target")
      case "$c_target" in *'$'*|*'`'*) c_target="" ;; esac
      if [ -n "$c_target" ]; then
        [[ "$c_target" != /* ]] && c_target="$seg_target/$c_target"
        seg_target="$c_target"
      fi
    fi
    printf '%s\t%s\n' "$seg_target" "${segment#"$verb_run"}"
  done < <(gate_segments "$cmd")
  return 0
}

# ---------------------------------------------------------------------------
# PORTED FROM cdkd (go-to-k/cdkd#2639, tip). Kept TEXTUALLY IDENTICAL to that
# copy apart from path references and the per-repo consumer list above, so a
# `diff` across the three repos is the review.
#
# The FIRST port of this block was one revision STALE and shipped two live
# fail-opens cdkd had already fixed (a mid-word `$'...'` span, and every path
# byte >= 0x80 turned into U+FFFD). It passed its own four-arm
# `gate_perl_word_ok` because all four assertions were pure ASCII at word
# position 0. That is why the probe now has SIX arms, two of them chosen to
# fail exactly that stale copy -- verified: the stale block passes its own
# probe and is rejected by this one.
# ---------------------------------------------------------------------------
# ── A shell WORD, for the gates that extract with PERL ─────────────────────
#
# `GATE_PATH_TOKEN` and `_GATE_WORD_CHAR` are bash EREs, usable only from
# `[[ =~ ]]`. THREE gates -- issue-deferral-criteria, issue-dup-check and issue-classification-label -- pull a `--body-file` / `-F` path or an
# inline `--body` value out of RAW command text with `perl -0777` instead,
# because they need a GLOBAL scan over a multi-line slurp and `[[ =~ ]]` gives
# neither. THIS LIST IS PER REPO: cdkd, which the class is ported from, has a
# larger set (it also has gh-body-english, pr-body-item-number and
# commit-prefix-scope). Derive it rather than trusting this sentence --
# `grep -l GATE_PERL_WORD .claude/hooks/*-gate.sh` -- because an earlier
# revision of this comment in cdkd said "three" while five files consumed it,
# which is the same stale-sibling-note class the constant exists to end. Derive the list rather than trusting this
# sentence -- `grep -l GATE_PERL_WORD .claude/hooks/*-gate.sh` -- because an earlier
# revision of THIS comment said "three" while five files consumed it, which is
# the same stale-sibling-note class the constant exists to end.
# All of them spelled the value class `(["']?)([^"'\s]+)\1`, and that shape had
# THREE MEASURED holes, all fail-OPEN (go-to-k/cdkd, 2026-09-05):
#
#   gh issue create --body-file "<dir with space>/x.md"
#     The bare class cannot span the space, and with the optional quote group
#     unset it cannot start on the quote either, so NOTHING is extracted and
#     the gate judges an empty body. Measured: issue-deferral-criteria-gate
#     rc=0 on a PR-shaped deferral where the unquoted spelling gave 2, and
#     gh-body-english-gate rc=0 on a JAPANESE body where the unquoted spelling
#     gave 2 -- the English-only rule was bypassable by putting the body file
#     in a directory whose name contains a space.
#
#   gh api repos/O/R/issues -f body='<text>'
#     gh's OWN documented spelling puts the quote INSIDE the value, after the
#     `body=`. An alternation tried AFTER the literal `body=` falls through to
#     `\S+` and captures `body='a`. Measured on issue-deferral-criteria-gate:
#     rc=0, where `-f 'body=<text>'` (quote OUTSIDE, the only shape its suite
#     covered) gave 2.
#
# So the value class is defined ONCE, here, rather than a fourth time in the
# next hook that needs it. `GATE_PERL_WORD` is a perl PRELUDE, not a regex: a
# caller prefixes it to its own program --
#
#   perl -0777 -ne "$GATE_PERL_WORD"'
#     while (/--body-file[=\s]+($GW)/g) { print gate_unq($1), "\n"; }'
#
# -- and it defines two names:
#
#   $GW        ONE shell word that may EMBED quoted spans: the perl twin of
#              `_GATE_WORD_CHAR`. `body='a b c'` is one word, `"/a b/x.md"` is
#              one word, and a bare run still stops at whitespace.
#   gate_unq   the shell's own unquoting of such a word, so a caller gets the
#              string gh actually receives: spans unwrapped, and `\X` unescaped
#              exactly where the shell would unescape it (inside a
#              double-quoted span only for `\ " $` and a backtick; never inside
#              a single-quoted one, which takes no escapes).
#
# UNBALANCED quotes are not a regression risk here: `$GW`'s bare alternative
# excludes both quote characters, so a word like `/tmp/o'neill/x.md` stops at
# the apostrophe -- which is exactly where the old class stopped too.
#
# A hook using this MUST also assert `GATE_PERL_WORD` is non-empty in its
# library-load guard. Left undefined, `$GW` interpolates as the EMPTY string,
# `($GW)` then matches empty at every position, and the extraction yields empty
# values that every caller skips -- a silent fail-open, which is the exact
# class this constant closes.
#
# The apostrophes below are spelled `\x27` -- a PERL escape, valid in a regex
# and in a substitution alike -- because this is a bash SINGLE-QUOTED string
# and a literal apostrophe would end it. The `'"'"'` idiom used elsewhere in
# this file would work too, and is unreadable at this density.
GATE_PERL_WORD='
  # ANSI-C quoting is the FIRST alternative on purpose. `$` is an ordinary
  # character to the bare class below, so without this arm `$\x27...\x27` was
  # split into a bare `$` plus a plain single-quoted span -- which took the body
  # LITERALLY, so `--body $\x27日本語\x27` reached the English-only
  # gate as the ASCII text `$日本語` and passed, while bash sent
  # Japanese. Its inner `\\.` also differs from the plain single-quote arm:
  # inside `$\x27...\x27` a backslash ESCAPES, so `\\\x27` does not close it.
  my $GW = qr/(?:\$\x27(?:[^\x27\\]|\\.)*\x27|"(?:[^"\\]|\\.)*"|\x27[^\x27]*\x27|\\.|[^\s"\x27;|&()<>\x60])+/;
  # Append-as-BYTES normaliser. Perl strings carry an internal
  # character-vs-bytes flag, and the callers of this prelude run under mixed
  # `-C` settings: the path extraction has none, the non-English body scan uses
  # `-CSD`, where the input is ALREADY decoded. Mixing the two in one result
  # produces a string that is half characters and half bytes -- which is exactly
  # how a literal accent beside an escape defeated the class test. Everything
  # here is bytes; whoever needs characters decodes once, at its own call site.
  sub gate_bytes {
    my ($t) = @_;
    utf8::encode($t) if utf8::is_utf8($t);
    return $t;
  }

  # ANSI-C escape decoding, used only by the `$\x27...\x27` arm of gate_unq.
  #
  # EVERYTHING IS NORMALISED TO BYTES AND DECODED ONCE AT THE END, and each half
  # of that is load-bearing:
  #
  #   bash itself is mixed -- `\xHH` and `\NNN` emit raw BYTES while `\uXXXX`
  #   emits a CHARACTER -- so the only representation both agree on is the byte
  #   string bash would actually pass. Hence `\u` is encoded rather than left
  #   wide.
  #
  #   The LITERAL run has to be encoded too, and missing that was a live
  #   BYPASS. The callers run under mixed `-C` settings: the path extraction has
  #   none, the non-English body scan uses `-CSD`, where the input string is
  #   ALREADY decoded. So a literal non-ASCII character sitting next to an
  #   escape produced a string that was half characters and half bytes, the
  #   closing `utf8::decode` refused it as invalid UTF-8, and the whole value
  #   stayed Latin-1 -- which `NON_ENGLISH_RE` (CJK / Hangul) never matches.
  #   Measured against the real hook:
  #
  #     --body $\x27\u65e5\u672c\u8a9e\x27         rc=2   blocked
  #     --body $\x27<one accent>\u65e5\u672c\u8a9e\x27  rc=0   BYPASS
  #     --body $\x27<one accent>\xe6\x97\xa5\x27        rc=0   BYPASS
  #
  #   Both bypasses publish Japanese, and the carrier is an ordinary Latin-1
  #   accent that is not itself blocked, so nothing looks wrong.
  #
  #   `utf8::is_utf8` guards the encode: encoding unconditionally is correct for
  #   the `-CSD` caller and DOUBLE-encodes for the byte-mode ones, which is the
  #   same defect facing the other way.
  #
  # A value that is not valid UTF-8 once assembled is left exactly as built --
  # utf8::decode returns false without modifying it, which is the right answer
  # for a genuinely binary `\xNN` payload.
  sub gate_ansi_c {
    my ($v) = @_;
    my %simple = ("a"=>"\a","b"=>"\b","e"=>"\e","E"=>"\e","f"=>"\f",
                  "n"=>"\n","r"=>"\r","t"=>"\t","v"=>"\013",
                  "\\"=>"\\","\x27"=>"\x27","\""=>"\"","?"=>"?");
    # `\G` + `pos()`, never a destructive `s/^...//`. Each substitution copies
    # the REMAINDER of the string, so a per-character loop over an n-character
    # value is O(n^2): measured at 0.36 s for 5k escapes, 2.7 s for 20k and
    # 14.5 s for 50k, against the 10 s PreToolUse timeout in
    # .claude/settings.json -- and a timed-out hook is, for a gate, a SILENT
    # PASS. Scanning leaves the string alone and is linear.
    pos($v) = 0;
    my $o = "";
    my $n = length($v);
    while (pos($v) < $n) {
      # `& 255`: bash truncates an escape to a byte, so `\400` is NUL, not U+0100.
      if    ($v =~ /\G\\x([0-9A-Fa-f]{1,2})/gc)  { $o .= chr(hex($1) & 255); }
      elsif ($v =~ /\G\\([0-7]{1,3})/gc)         { $o .= chr(oct($1) & 255); }
      elsif ($v =~ /\G\\u([0-9A-Fa-f]{1,4})/gc)  { $o .= gate_bytes(pack("U", hex($1))); }
      elsif ($v =~ /\G\\U([0-9A-Fa-f]{1,8})/gc)  { $o .= gate_bytes(pack("U", hex($1))); }
      elsif ($v =~ /\G\\c(.)/gcs)                { $o .= chr(ord(uc $1) & 255 ^ 64); }
      elsif ($v =~ /\G\\(.)/gcs)                 { $o .= gate_bytes(exists $simple{$1} ? $simple{$1} : "\\" . $1); }
      elsif ($v =~ /\G([^\\]+)/gcs)              { $o .= gate_bytes($1); }
      elsif ($v =~ /\G(.)/gcs)                   { $o .= gate_bytes($1); }
      else                                        { last; }
    }
    return $o;
  }

  # Byte string -> character string, lenient. The alternation is the standard
  # UTF-8 well-formedness table (RFC 3629): no overlongs, no surrogates, no
  # code point above U+10FFFF -- an over-permissive matcher here would decode a
  # surrogate-encoded sequence into a character the class test then treats as
  # ordinary text.
  sub gate_utf8_lenient {
    my ($b) = @_;
    pos($b) = 0;
    my $o = "";
    my $n = length($b);
    # `\G` + `pos()` for the same reason as gate_ansi_c: a destructive loop here
    # is O(n^2) and the hook timeout is a silent pass.
    while (pos($b) < $n) {
      if ($b =~ /\G((?:[\x00-\x7F]|[\xC2-\xDF][\x80-\xBF]|\xE0[\xA0-\xBF][\x80-\xBF]|[\xE1-\xEC\xEE\xEF][\x80-\xBF]{2}|\xED[\x80-\x9F][\x80-\xBF]|\xF0[\x90-\xBF][\x80-\xBF]{2}|[\xF1-\xF3][\x80-\xBF]{3}|\xF4[\x80-\x8F][\x80-\xBF]{2})+)/gcs) {
        my $t = $1;
        utf8::decode($t);
        $o .= $t;
      } elsif ($b =~ /\G./gcs) {
        $o .= "\x{FFFD}";
      } else {
        last;
      }
    }
    return $o;
  }
  sub gate_unq {
    my ($t) = @_;
    pos($t) = 0;
    my $o = "";
    my $n = length($t);
    # `\G` + `pos()`, not `s/^...//`: see gate_ansi_c. A value made of many
    # adjacent quoted chunks is a per-span loop, and the same O(n^2) applies.
    while (pos($t) < $n) {
      if ($t =~ /\G"((?:[^"\\]|\\.)*)"/gcs) {
        my $s = $1; $s =~ s/\\([\\"\$`])/$1/gs; $o .= gate_bytes($s);
      } elsif ($t =~ /\G\$\x27((?:[^\x27\\]|\\.)*)\x27/gcs) { $o .= gate_ansi_c($1);
      } elsif ($t =~ /\G\x27([^\x27]*)\x27/gcs)             { $o .= gate_bytes($1);
      } elsif ($t =~ /\G\\(.)/gcs)                          { $o .= gate_bytes($1);
      # `\$(?!\x27)`: an ordinary `$` is legitimate text (`cost $5`,
      # `hello$USER`) and must be consumed here, but a `$` that OPENS an ANSI-C
      # span must be left for the arm above. Without the look-ahead this run ate
      # the sigil greedily, so the ANSI-C arm only ever fired at word position 0
      # -- one ASCII character before it defeated the whole decode, and
      # `gh api -f body=$\x27...\x27` was bypassed UNCONDITIONALLY because
      # `body=` is always such a prefix.
      } elsif ($t =~ /\G((?:[^"\x27\\\$]|\$(?!\x27))+)/gcs) { $o .= gate_bytes($1);
      } elsif ($t =~ /\G(.)/gcs)                            { $o .= gate_bytes($1);
      } else { last; }
    }
    return $o;
  }
'

# `GATE_PERL_WORD` is one shared literal that five blocking gates interpolate,
# so its failure mode is the one this whole mechanism must not have: every
# consumer runs `perl ... 2>/dev/null`, so a prelude that is PRESENT but does
# not COMPILE produces no output, no stderr, and no exit-code change -- the
# gates simply extract nothing and pass. Measured: a non-empty, non-compiling
# prelude silently disarmed four gates at once (a Japanese body, a PR-shaped
# deferral, an unlabelled `Severity: high`, and a bare `#4` all reached rc=0).
#
# `[ -n "$GATE_PERL_WORD" ]` cannot see that, so it is not the guard -- it is
# only the cheap first half. This is the second half: run the prelude on a
# known input and require the known answer. Call it AFTER a gate has armed, not
# at library-load: the library is sourced by every hook on every Bash call,
# while an armed gate is already about to fork perl anyway.
#
# Returns 0 when the prelude is usable, 1 otherwise. Callers must fail CLOSED.
# Memoised fail-closed wrapper: probe once per process, at the first point a
# gate is actually about to extract, then remember. `$1` is the gate's own name
# so the refusal says which one refused.
# RESET AT LOAD. `__GATE_PW_OK` is an ordinary shell variable, so without this
# it is inheritable: `__GATE_PW_OK=1 gh issue create ...` made the probe report
# a working prelude it never ran, and a Japanese body passed at rc=0 against a
# deliberately broken library (measured). A guard whose whole job is to fail
# closed on a tampered library must not be disable-able by one env var.
__GATE_PW_OK=

gate_perl_word_or_die() {
  if [ "${__GATE_PW_OK:-}" != "1" ]; then
    if gate_perl_word_ok; then
      __GATE_PW_OK=1
    else
      echo "Blocked by $1: .claude/hooks/_command-match.sh defines GATE_PERL_WORD," >&2
      echo "but running it does not return the expected value -- the prelude is missing," >&2
      echo "outdated, or does not compile. Every extraction in this gate runs perl with" >&2
      echo "stderr discarded, so a broken prelude would silently extract NOTHING and the" >&2
      echo "gate would PASS whatever it was meant to refuse. Refusing instead." >&2
      echo "Fix the library (or restore it from origin/main) and retry." >&2
      return 1
    fi
  fi
  return 0
}

gate_perl_word_ok() {
  [ -n "${GATE_PERL_WORD:-}" ] || return 1
  # FOUR dimensions, not one. The first cut asserted a single quoted-span pair,
  # and a review measured two preludes that passed it while carrying a live
  # bypass: a one-revision-STALE library (no ANSI-C arm -- which is exactly the
  # state a sibling repo mid-port is in), and one hardcoded to the probe's own
  # input. A guard that pins one dimension certifies one dimension.
  #
  # Each line below is a different arm of `$GW` / `gate_unq`, chosen because
  # each was a measured fail-open in its own right:
  #   1  a QUOTED span containing a space
  #   2  a BACKSLASH-escaped space
  #   3  an ANSI-C span, decoded rather than taken literally
  #   4  the metacharacter STOP (the word must not swallow the `;`)
  gate_pw_probe_() {
    printf '%s' "$2" | perl -0777 -ne "$GATE_PERL_WORD"'
      while (/--body-file[=\s]+($GW)/g) { print gate_unq($1) }' 2>/dev/null
  }
  [ "$(gate_pw_probe_ q 'x --body-file "/a b/p.md"')" = '/a b/p.md' ] || return 1
  [ "$(gate_pw_probe_ b 'x --body-file /a\ b/p.md')"  = '/a b/p.md' ] || return 1
  [ "$(gate_pw_probe_ a "x --body-file \$'/a\\'b/p.md' rest")" = "/a'b/p.md" ] || return 1
  [ "$(gate_pw_probe_ m 'x --body-file /a/p.md; echo hi')" = '/a/p.md' ] || return 1
  # 5  a MID-WORD ANSI-C span. Added after a review measured the four arms above
  #    certifying a one-revision-STALE library -- the exact case the guard was
  #    written for. The bare-run arm used to eat the `$` sigil greedily, so the
  #    ANSI-C arm fired only at word position 0; every arm above sits at
  #    position 0 and none of them could see it.
  [ "$(gate_pw_probe_ w "x --body-file /a/b\$'\\x20'c.md")" = '/a/b c.md' ] || return 1
  # 6  BYTE FIDELITY. `gate_unq` must return the byte string bash would pass;
  #    decoding inside it corrupted every path carrying a byte >= 0x80 (measured
  #    128 of 255) while leaving all five assertions above green, because each of
  #    them is pure ASCII.
  [ "$(gate_pw_probe_ y "x --body-file \$'/a/\\xc3\\xa9.md'")" = "$(printf '/a/\303\251.md')" ] || return 1
  return 0
}

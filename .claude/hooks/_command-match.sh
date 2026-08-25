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
}

# `gh pr merge` / `gh pr edit` flags that take NO value. Everything else that
# looks like a flag is assumed to consume the next token.
#
# THE POLARITY IS THE WHOLE POINT, and it is the opposite of the obvious one.
# Enumerating VALUE-TAKERS goes stale the DANGEROUS way: an unlisted flag leaves
# its value in place, the value becomes the selector, and the gate audits the
# WRONG PR. Enumerating VALUELESS flags goes stale the SAFE way: an unlisted one
# eats the number, the selector comes back empty, and every caller either falls
# back to the current branch or refuses. Wrong-PR is severe; no-PR is not.
GATE_GH_PR_VALUELESS_FLAGS='--squash|--merge|--rebase|--auto|--disable-auto|--admin|--delete-branch'

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
gate_pr_selector() {
  local cmd="$1" re="$2" segment rest tok skip=0 v
  while IFS= read -r segment; do
    [[ "$segment" =~ $re ]] || continue
    rest="${segment:${#BASH_REMATCH[0]}}"
    skip=0
    while IFS= read -r tok; do
      [ -n "$tok" ] || continue
      if [ "$skip" = "1" ]; then skip=0; continue; fi
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
        ''|*[!0-9]*) return 0 ;;
        *) printf '%s' "$v"; return 0 ;;
      esac
    done < <(gate_tokens "$rest")
    return 0
  done < <(gate_segments "$cmd")
  return 0
}

# gate_repo_flag <command> <verb-ere>
# The `-R` / `--repo` value carried by the MATCHED segment, in any spelling gh
# accepts (space, `=`, glued). Empty when the command names no repo.
#
# TOKENISED, so a `-R` inside a quoted value is not mistaken for the flag:
# `gh pr merge --subject "compare with -R other/repo" 5` names no repo.
gate_repo_flag() {
  local cmd="$1" re="$2" segment tok want=0
  while IFS= read -r segment; do
    [[ "$segment" =~ $re ]] || continue
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

// Tiny glob matcher for stack-name selection:
//   *  matches any run of characters (including empty)
//   ?  matches exactly one character
//   \* \? \\  match a LITERAL `*` / `?` / `\` (backslash escape)
// Anchored full-string match; every other character (incl. regex metachars like
// `.` `+` `(`) is treated as a literal. No `[...]` classes, no `**` semantics.
//
// The `\`-escape exists so a rule can name a path segment that legitimately CONTAINS a
// `*` / `?` — an API Gateway `MethodSettings[*]` bracket key (from `HttpMethod: '*'`),
// an S3 lifecycle `Id: "clean*tmp"`, a free-form Glue/ECS map key — without the wildcard
// silently widening the rule to every sibling (issue #776). `ignoreRuleFor` escapes such
// literals when it writes a finding path into a rule, and the grammar honours them here.

/** True when `s` contains an UNESCAPED glob metachar (`*` or `?`). A `\*` / `\?` is a
 *  literal, not a wildcard, so a pattern made only of escaped metachars is NOT a glob. */
export function isGlob(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++; // skip the escaped char — it is a literal, not a metachar
      continue;
    }
    if (s[i] === '*' || s[i] === '?') return true;
  }
  return false;
}

/**
 * Collapse runs of consecutive UNESCAPED `*` to a single `*` (see `globToRegExp` for the
 * ReDoS rationale), leaving `\`-escaped sequences untouched. An escaped `\*` must NOT be
 * merged into (or collapsed with) an adjacent real `*` — `\**` is a literal `*` followed
 * by a wildcard, which must survive as two distinct tokens.
 */
function collapseStars(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '\\') {
      // copy the escape and its escaped char verbatim (the escaped char may be `*`)
      out += pattern.slice(i, i + 2);
      i += pattern[i + 1] === undefined ? 1 : 2;
    } else if (ch === '*') {
      out += '*';
      while (pattern[i] === '*') i++; // swallow the whole run of UNESCAPED stars
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Convert a glob pattern to an anchored RegExp (other metachars escaped to literals). */
export function globToRegExp(pattern: string): RegExp {
  let out = '^';
  // Collapse runs of consecutive UNESCAPED `*` to a single `*` FIRST: `***` is semantically
  // identical to `*` (any run of characters), but compiling each star to `.*` yields
  // `.*.*.*…` which backtracks CATASTROPHICALLY (O(len^N)) on a long non-matching
  // subject — a self-inflicted multi-second hang (ReDoS) on a user-authored glob like
  // `*****` (a natural gitignore-style attempt). One `.*` per run can't backtrack. The
  // collapse is escape-aware so a literal `\*` is not merged into an adjacent wildcard.
  const collapsed = collapseStars(pattern);
  for (let i = 0; i < collapsed.length; i++) {
    const ch = collapsed[i];
    // A backslash escapes the NEXT char to a literal (`\*` `\?` `\\`): emit that char as a
    // regex literal, never as a wildcard. A trailing lone `\` is treated as a literal `\`.
    if (ch === '\\') {
      const next = collapsed[i + 1] ?? '\\';
      out += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (collapsed[i + 1] !== undefined) i++;
    } else if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += (ch as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  out += '$';
  return new RegExp(out);
}

/** True when `name` matches the glob `pattern` (anchored full-string match). */
export function matchesGlob(pattern: string, name: string): boolean {
  return globToRegExp(pattern).test(name);
}

/**
 * Path-axis glob (for ignore-rule `path` patterns against a `<id>.<sub.path>` target):
 * a SEGMENT-aware variant where `*` / `?` do NOT cross a `.`, `[`, or `/` boundary. So
 * `*.DesiredCount` matches `<anyId>.DesiredCount` (the documented intent — `*` = one id
 * segment) but NOT a same-named leaf nested deeper (`Tbl.Config.DesiredCount`, or a
 * free-form-map key literally named `DesiredCount`). Subtree coverage of a PARENT rule
 * (`X.Policies` covering `X.Policies[Mp].Name`) is handled separately by the ancestor
 * walk in `pathMatches`, so bounding `*` here does not under-match. The stack/region
 * axes keep `matchesGlob` (their names contain no `.`/`[`, so it is equivalent there).
 *
 * `/` is ALSO a hard segment boundary: `applyIgnores` matches against `/`-joined
 * construct paths (`MyApi/Resource/Method`), so `MyApi/*` means "a direct child of
 * MyApi" — bounding `*` at `/` keeps it from leaking to arbitrarily deep descendants
 * (`MyApi/Resource/Method`). Deep-subtree coverage of a `/`-parent rule is still
 * handled by the ancestor walk in `pathMatches` (which trims at `.`, `[`, OR `/`, so a
 * `/`-parent rule's whole subtree is covered — symmetric with `.`). Inside a `[...]` bracket a `/`
 * is DATA, not a boundary — the brackets already delimit the key — so it stays literal
 * there, exactly like `.`.
 *
 * INSIDE a `[...]` bracket segment a `*` / `?` is UNBOUNDED within that bracket: the
 * brackets already delimit the key, so a `.` between them is DATA, not a segment
 * boundary — cdkrd's own canonical paths carry dotted bracket keys such as
 * `Alb.LoadBalancerAttributes[routing.http2.enabled]`. So `...[*]` and `...[routing.*]`
 * match those keys, while `.` OUTSIDE brackets stays a hard segment boundary. A `*`/`?`
 * inside a bracket may not cross the closing `]` (still one bracket segment).
 */
export function matchesPathGlob(pattern: string, target: string): boolean {
  let out = '^';
  let inBracket = false;
  const collapsed = collapseStars(pattern);
  for (let i = 0; i < collapsed.length; i++) {
    const ch = collapsed[i];
    // A backslash escapes the NEXT char to a literal (`\*` `\?` `\\`, or `\[` / `\]`): it
    // never wildcards and — for `\[` / `\]` — never toggles the bracket-segment state. A
    // trailing lone `\` is a literal `\`.
    if (ch === '\\') {
      const next = collapsed[i + 1] ?? '\\';
      out += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (collapsed[i + 1] !== undefined) i++;
    } else if (ch === '*') out += inBracket ? '[^\\]]*' : '[^.[/]*';
    else if (ch === '?') out += inBracket ? '[^\\]]' : '[^.[/]';
    else {
      if (ch === '[') inBracket = true;
      else if (ch === ']') inBracket = false;
      out += (ch as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  out += '$';
  return new RegExp(out).test(target);
}

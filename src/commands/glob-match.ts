// Tiny glob matcher for stack-name selection:
//   *  matches any run of characters (including empty)
//   ?  matches exactly one character
// Anchored full-string match; every other character (incl. regex metachars like
// `.` `+` `(`) is treated as a literal. No `[...]` classes, no `**` semantics.

/** True when `s` contains a glob metachar (`*` or `?`). */
export function isGlob(s: string): boolean {
  return s.includes('*') || s.includes('?');
}

/** Convert a glob pattern to an anchored RegExp (other metachars escaped to literals). */
export function globToRegExp(pattern: string): RegExp {
  let out = '^';
  // Collapse runs of consecutive `*` to a single `*` FIRST: `***` is semantically
  // identical to `*` (any run of characters), but compiling each star to `.*` yields
  // `.*.*.*…` which backtracks CATASTROPHICALLY (O(len^N)) on a long non-matching
  // subject — a self-inflicted multi-second hang (ReDoS) on a user-authored glob like
  // `*****` (a natural gitignore-style attempt). One `.*` per run can't backtrack.
  for (const ch of pattern.replace(/\*+/g, '*')) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
 * a SEGMENT-aware variant where `*` / `?` do NOT cross a `.` or `[` boundary. So
 * `*.DesiredCount` matches `<anyId>.DesiredCount` (the documented intent — `*` = one id
 * segment) but NOT a same-named leaf nested deeper (`Tbl.Config.DesiredCount`, or a
 * free-form-map key literally named `DesiredCount`). Subtree coverage of a PARENT rule
 * (`X.Policies` covering `X.Policies[Mp].Name`) is handled separately by the ancestor
 * walk in `pathMatches`, so bounding `*` here does not under-match. The stack/region
 * axes keep `matchesGlob` (their names contain no `.`/`[`, so it is equivalent there).
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
  for (const ch of pattern.replace(/\*+/g, '*')) {
    if (ch === '*') out += inBracket ? '[^\\]]*' : '[^.[]*';
    else if (ch === '?') out += inBracket ? '[^\\]]' : '[^.[]';
    else {
      if (ch === '[') inBracket = true;
      else if (ch === ']') inBracket = false;
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  out += '$';
  return new RegExp(out).test(target);
}

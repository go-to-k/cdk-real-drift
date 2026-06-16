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

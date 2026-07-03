// Semantic color helpers for human-facing output (R43). Call sites say WHAT a
// thing is (a drift verdict, an info footer), not what color it is.
//
// Colors are enabled ONLY when stdout is a real terminal and NO_COLOR is unset:
// piped / CI / --json output stays byte-identical plain text, so the
// CI-greppable invariant (`grep '^result:'`) and the `--json` contract are
// untouched. FORCE_COLOR is deliberately ignored — test runners set it for
// their own reporters, and honoring it would make committed-test output
// environment-dependent.
import pc from 'picocolors';

export interface Style {
  header: (s: string) => string; // === check/revert: ... === banners
  resultLabel: (s: string) => string; // the `result:` prefix — the conclusion anchor
  driftTier: (s: string) => string; // deleted / declared section titles
  undeclaredTier: (s: string) => string; // the differentiator tier title
  // Secondary UI chrome you're NOT meant to read closely: picker key-hints, the skip
  // chip, aborted/retry status lines. Dim (SGR 2) is correct HERE — it recedes.
  infoTier: (s: string) => string;
  // Explanatory prose you ARE meant to read: tier notes, origin hints (↳), the info:
  // footer. Terminal DEFAULT foreground — legible on any theme (dim was unreadable on
  // dark terminals and wrongly wore the "don't read me" style of the picker chrome).
  note: (s: string) => string;
  clean: (s: string) => string; // result: CLEAN / CLEAN after revert. / no drift
  drift: (s: string) => string; // result: N drift(s) / N drift(s) remain.
  desired: (s: string) => string; // desired= value (what it should be)
  actual: (s: string) => string; // actual = value (what it really is)
  ok: (s: string) => string; // reverted: / baseline written:
  fail: (s: string) => string; // FAILED:
  cursor: (s: string) => string; // the focused row in an interactive multiselect
}

/** Build the palette on top of a picocolors instance (identity when disabled). */
export function makeStyle(c: ReturnType<typeof pc.createColors>): Style {
  return {
    header: c.bold,
    resultLabel: c.bold,
    driftTier: (s) => c.bold(c.red(s)),
    undeclaredTier: (s) => c.bold(c.yellow(s)),
    infoTier: c.dim,
    // Terminal default foreground (identity) — no dim, no fixed color, so it stays
    // legible whatever the terminal theme. Structure (parentheses, `↳`, the `info:`
    // prefix, indentation) carries the "this is secondary" cue instead of color.
    note: (s) => s,
    clean: (s) => c.bold(c.green(s)),
    drift: (s) => c.bold(c.red(s)),
    desired: c.green,
    actual: c.red,
    ok: c.green,
    fail: (s) => c.bold(c.red(s)),
    cursor: c.cyan,
  };
}

export const colorEnabled = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

export const style: Style = makeStyle(pc.createColors(colorEnabled));

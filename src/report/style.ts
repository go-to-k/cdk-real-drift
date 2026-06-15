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
  header: (s: string) => string; // === cdkrd check/revert: ... === banners
  driftTier: (s: string) => string; // deleted / declared section titles
  undeclaredTier: (s: string) => string; // the differentiator tier title
  infoTier: (s: string) => string; // informational tier titles + info:/note footers
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
    driftTier: (s) => c.bold(c.red(s)),
    undeclaredTier: (s) => c.bold(c.yellow(s)),
    infoTier: c.dim,
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

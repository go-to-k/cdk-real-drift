// `--no-prompt` must suppress check's interactive after-report resolve menu even in a TTY,
// WITHOUT changing the exit code (the exit-0 twin of --fail's prompt suppression). It is the
// prompt axis, orthogonal to --fail's exit-code axis: a report-only script run ATTACHED to a
// terminal (both stdin+stdout TTY, so the TTY gate alone would still prompt and could hang)
// that must not fail CI on drift. This asserts the pure gate predicate.
import { describe, expect, it } from 'vite-plus/test';
import { shouldOfferInteractiveResolve } from '../src/commands/check.js';
import type { CommonArgs } from '../src/cli-args.js';

type GateArgs = Pick<
  CommonArgs,
  'json' | 'showAll' | 'preDeploy' | 'fail' | 'noPrompt' | 'yes' | 'declaredOnly' | 'undeclaredOnly'
>;
const args = (over: Partial<GateArgs> = {}): GateArgs => ({
  json: false,
  showAll: false,
  preDeploy: false,
  fail: false,
  noPrompt: false,
  yes: false,
  declaredOnly: false,
  undeclaredOnly: false,
  ...over,
});
// A TTY run that found drift on a baselined stack — the canonical "offer the menu" case.
const drift = { code: 1, hasUnrecorded: false, hasBaseline: true, interactive: true };

describe('shouldOfferInteractiveResolve gates the menu on --no-prompt', () => {
  it('offers the menu for an interactive drift run without --no-prompt', () => {
    expect(shouldOfferInteractiveResolve(args(), drift)).toBe(true);
  });

  it('does NOT offer the menu under --no-prompt', () => {
    expect(shouldOfferInteractiveResolve(args({ noPrompt: true }), drift)).toBe(false);
  });

  it('does NOT offer the menu under --no-prompt for the R141 no-baseline establish path', () => {
    expect(
      shouldOfferInteractiveResolve(args({ noPrompt: true }), {
        code: 0,
        hasUnrecorded: false,
        hasBaseline: false,
        interactive: true,
      })
    ).toBe(false);
  });

  it('does NOT offer the menu under --no-prompt even with unrecorded values present', () => {
    expect(
      shouldOfferInteractiveResolve(args({ noPrompt: true }), {
        code: 0,
        hasUnrecorded: true,
        hasBaseline: true,
        interactive: true,
      })
    ).toBe(false);
  });

  it('suppresses the menu when combined with --fail (both suppress; --fail wins the exit code elsewhere)', () => {
    expect(shouldOfferInteractiveResolve(args({ noPrompt: true, fail: true }), drift)).toBe(false);
  });
});

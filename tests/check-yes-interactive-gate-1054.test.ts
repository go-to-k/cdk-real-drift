// #1054 — `--yes` must NOT open check's interactive after-report resolve menu. `--yes` has no
// documented `check` contract (HELP scopes it to record / ignore / revert; check's automation
// flag is --fail / non-TTY). In the menu the user is the decision-maker, so threading `--yes`
// into the record/ignore/revert sub-actions silently overrode explicit per-finding choices
// (recorded/ignored/reverted values the user declined, including folded values never shown).
// The fix gates the menu on `!a.yes`. This asserts the pure gate predicate.
import { describe, expect, it } from 'vite-plus/test';
import { shouldOfferInteractiveResolve } from '../src/commands/check.js';
import type { CommonArgs } from '../src/cli-args.js';

type GateArgs = Pick<CommonArgs, 'json' | 'showAll' | 'preDeploy' | 'fail' | 'yes'>;
const args = (over: Partial<GateArgs> = {}): GateArgs => ({
  json: false,
  showAll: false,
  preDeploy: false,
  fail: false,
  yes: false,
  ...over,
});
// A TTY run that found drift on a baselined stack — the canonical "offer the menu" case.
const drift = { code: 1, hasUnrecorded: false, hasBaseline: true, interactive: true };

describe('#1054 shouldOfferInteractiveResolve gates the menu on --yes', () => {
  it('offers the menu for an interactive drift run without --yes', () => {
    expect(shouldOfferInteractiveResolve(args(), drift)).toBe(true);
  });

  it('does NOT offer the menu under --yes (the #1054 fix)', () => {
    expect(shouldOfferInteractiveResolve(args({ yes: true }), drift)).toBe(false);
  });

  it('does NOT offer the menu under --yes even for the R141 no-baseline establish path', () => {
    expect(
      shouldOfferInteractiveResolve(args({ yes: true }), {
        code: 0,
        hasUnrecorded: false,
        hasBaseline: false,
        interactive: true,
      })
    ).toBe(false);
  });

  it('does NOT offer the menu under --yes even with unrecorded values present', () => {
    expect(
      shouldOfferInteractiveResolve(args({ yes: true }), {
        code: 0,
        hasUnrecorded: true,
        hasBaseline: true,
        interactive: true,
      })
    ).toBe(false);
  });

  it('keeps the existing gates: no menu for --json / --show-all / --pre-deploy / --fail / non-TTY', () => {
    for (const over of [{ json: true }, { showAll: true }, { preDeploy: true }, { fail: true }]) {
      expect(shouldOfferInteractiveResolve(args(over), drift)).toBe(false);
    }
    expect(shouldOfferInteractiveResolve(args(), { ...drift, interactive: false })).toBe(false);
  });

  it('does not offer the menu when there is nothing to act on (clean, baselined, recorded)', () => {
    expect(
      shouldOfferInteractiveResolve(args(), {
        code: 0,
        hasUnrecorded: false,
        hasBaseline: true,
        interactive: true,
      })
    ).toBe(false);
  });
});

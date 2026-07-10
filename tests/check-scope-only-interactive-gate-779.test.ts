// #779 — `cdkrd check --declared-only` (and its `--undeclared-only` twin) must NOT open
// check's interactive after-report resolve menu. Under a scope filter the run's `findings`
// have been reduced to a single tier:
//   - --declared-only drops the WHOLE undeclared / added / atDefault tier (preDeployFindings).
//   - --undeclared-only drops declared plus its readGap / unresolved byproducts.
// The menu's interactive Record path feeds THAT filtered set into writeBaseline. Because
// computeCompleteResources only blocks snapshot-completeness on the tiers that were just
// filtered out (skipped/deleted/readGap/unrecorded-undeclared), every readable resource would
// be stamped snapshot-complete with an INCOMPLETE `recorded` list — so the next plain `check`
// reads the genuinely-undeclared values as "appeared since record" = a false confirmed-drift
// storm (exit 1 under --fail). Under --declared-only the HELP/in-run note also PROMISES the
// baseline is untouched, which the Record offer would break. The fix gates the menu on
// `!a.declaredOnly && !a.undeclaredOnly` so a filtered finding set can never become a
// snapshot-complete baseline; the unfiltered standalone `record` verb still establishes one.
import { describe, expect, it } from 'vite-plus/test';
import { shouldOfferInteractiveResolve } from '../src/commands/check.js';
import type { CommonArgs } from '../src/cli-args.js';

type GateArgs = Pick<
  CommonArgs,
  'json' | 'showAll' | 'preDeploy' | 'fail' | 'yes' | 'declaredOnly' | 'undeclaredOnly'
>;
const args = (over: Partial<GateArgs> = {}): GateArgs => ({
  json: false,
  showAll: false,
  preDeploy: false,
  fail: false,
  yes: false,
  declaredOnly: false,
  undeclaredOnly: false,
  ...over,
});

// The R141 day-1 establish path: a TTY run with NO baseline yet. This is the exact context
// that, under a scope flag, would let interactive Record write a filtered snapshot-complete
// baseline — so it is the case the fix must gate OUT.
const establish = { code: 0, hasUnrecorded: false, hasBaseline: false, interactive: true };
// A TTY run that found unrecorded values on a baselined stack — the `--undeclared-only`
// NORMAL first-run path (any run with undeclared/added values is `hasUnrecorded`).
const unrecorded = { code: 0, hasUnrecorded: true, hasBaseline: true, interactive: true };

describe('#779 shouldOfferInteractiveResolve gates the menu under a scope filter', () => {
  it('does NOT offer the establish/Record menu under --declared-only (the #779 fix)', () => {
    expect(shouldOfferInteractiveResolve(args({ declaredOnly: true }), establish)).toBe(false);
  });

  it('does NOT offer the establish/Record menu under --undeclared-only (the #779 twin)', () => {
    expect(shouldOfferInteractiveResolve(args({ undeclaredOnly: true }), establish)).toBe(false);
  });

  it('does NOT offer the menu under --declared-only even with unrecorded values present', () => {
    expect(shouldOfferInteractiveResolve(args({ declaredOnly: true }), unrecorded)).toBe(false);
  });

  it('does NOT offer the menu under --undeclared-only even with unrecorded values present', () => {
    expect(shouldOfferInteractiveResolve(args({ undeclaredOnly: true }), unrecorded)).toBe(false);
  });

  // Do NOT over-block: a PLAIN check (no scope flag) must still open the R141 establish
  // prompt — that is the day-1 baseline flow the whole interactive menu exists for.
  it('STILL offers the establish prompt for a plain check with no scope flag (no over-block)', () => {
    expect(shouldOfferInteractiveResolve(args(), establish)).toBe(true);
  });

  it('STILL offers the menu for a plain check with unrecorded values (no over-block)', () => {
    expect(shouldOfferInteractiveResolve(args(), unrecorded)).toBe(true);
  });
});

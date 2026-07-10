import { describe, expect, it } from 'vite-plus/test';
import { KNOWN_DEFAULTS } from '../src/normalize/noise.js';
import { MOVING_REVERT_PINS, REVERT_SET_DEFAULT_PATHS } from '../src/revert/plan.js';

// #1072 — REVERT_SET_DEFAULT_PATHS writes a pinned constant verbatim to AWS. When the pin is
// a MOVING AWS default and it rots, revert writes yesterday's default and — because it still
// equals the (stale) fold pin — the post-revert check reads CLEAN, so the wrong write is
// invisible (a silent DOWNGRADE for a security-typed path). MOVING_REVERT_PINS is the
// staleness watch-list for exactly those pins; this guard keeps it honest so a moving pin can
// never silently fall out of tracking.
describe('#1072 REVERT_SET_DEFAULT moving-pin staleness watch-list', () => {
  it('every watch-list entry is a real REVERT_SET_DEFAULT_PATHS pin (rename/removal cannot silently drop it)', () => {
    for (const key of Object.keys(MOVING_REVERT_PINS)) {
      expect(REVERT_SET_DEFAULT_PATHS.has(key), `${key} must be in REVERT_SET_DEFAULT_PATHS`).toBe(
        true
      );
    }
  });

  it("each pin's recorded value still equals its live KNOWN_DEFAULTS write source (drift-of-the-pin guard)", () => {
    for (const [key, pin] of Object.entries(MOVING_REVERT_PINS)) {
      const [resourceType, path] = key.split('\0');
      const known = KNOWN_DEFAULTS[resourceType!]?.[path!];
      expect(known, `${key} must have a KNOWN_DEFAULTS source`).toBeDefined();
      // If someone bumps the fold pin but forgets the watch-list value (or vice versa), this
      // fails — forcing both to move together and lastVerified to be reconsidered.
      expect(pin.value, `${key} watch-list value must match KNOWN_DEFAULTS`).toEqual(known);
    }
  });

  it('each entry carries an ISO lastVerified date and a non-empty moveAxis (re-verify cadence)', () => {
    for (const [key, pin] of Object.entries(MOVING_REVERT_PINS)) {
      expect(pin.lastVerified, `${key} lastVerified`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(pin.moveAxis.length, `${key} moveAxis`).toBeGreaterThan(20);
    }
  });

  it('the known security-sensitive moving pins are tracked (Transfer TLS policy, Cognito tier, DocDB CA)', () => {
    for (const key of [
      'AWS::Transfer::Server\0SecurityPolicyName',
      'AWS::Cognito::UserPool\0UserPoolTier',
      'AWS::DocDB::DBInstance\0CACertificateIdentifier',
    ]) {
      expect(MOVING_REVERT_PINS[key], `${key} must be on the watch-list`).toBeDefined();
    }
  });
});

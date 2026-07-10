import { describe, expect, it } from 'vite-plus/test';
import { baselineValueMatches } from '../src/baseline/baseline-file.js';

// #1267 (an FN regression introduced by #1205): `baselineValueMatches` re-applies
// `stripCcApiAwsManagedFields` to BOTH compare sides via `canonicalizeBaselineForCompare`.
// But a stored baseline value is a bare FRAGMENT rooted AT its entry path, so the strip
// walk starts with `freeForm=false` and the `FREE_FORM_MAP_PARENTS` protection (which
// engages on SEEING the parent key — UserPoolTags, Environment.Variables, Parameters,
// DockerLabels, map Tags, …) never fires for a fragment whose root IS the map content. A
// recorded undeclared free-form-map fragment holding a USER key that collides with an
// AWS-managed-field name (`CreatedBy`, `OwnerId`, an #1251 MANAGED_TIMESTAMP_NAME variant)
// then has that key deleted from BOTH sides → an out-of-band change / add / remove of it can
// never surface. The fix threads the entry `path` into `baselineValueMatches` and seeds the
// strip walk `freeForm=true` when a path segment is a free-form-map parent, mirroring #807's
// ancestry restoration. Without the fix these change-detection cases return `true` (FN).
describe('#1267 baselineValueMatches preserves free-form-map ancestry (managed-named user keys not stripped)', () => {
  it('(FN) detects an out-of-band change to a UserPoolTags user key colliding with a managed name', () => {
    // The recorded fragment IS the content of a Cognito UserPool's UserPoolTags map.
    const recorded = { CreatedBy: 'alice', Team: 'platform' };
    // Out of band, someone changed the user tag `CreatedBy` from alice -> mallory.
    const live = { CreatedBy: 'mallory', Team: 'platform' };
    // WITHOUT the fix: `CreatedBy` is stripped from both sides (it collides with the managed
    // `CreatedBy` field name), so the fragments compare EQUAL and the drift is hidden (FN).
    // WITH the fix: the `UserPoolTags` path segment seeds free-form, `CreatedBy` survives on
    // both sides, and the change surfaces.
    expect(baselineValueMatches(recorded, live, 'AWS::Cognito::UserPool', 'UserPoolTags')).toBe(
      false
    );
  });

  it('(FN) detects an out-of-band change to a Lambda Environment.Variables user key', () => {
    const recorded = { OwnerId: '111', LOG_LEVEL: 'info' };
    const live = { OwnerId: '222', LOG_LEVEL: 'info' };
    expect(
      baselineValueMatches(recorded, live, 'AWS::Lambda::Function', 'Environment.Variables')
    ).toBe(false);
  });

  it('(FN) detects an out-of-band ADD of a managed-named user key under a free-form map', () => {
    const recorded = { Team: 'platform' };
    const live = { Team: 'platform', UpdatedAt: 'someone-set-this' };
    expect(baselineValueMatches(recorded, live, 'AWS::Cognito::UserPool', 'UserPoolTags')).toBe(
      false
    );
  });

  it('(FN) detects an out-of-band REMOVE of a managed-named user key under a free-form map', () => {
    const recorded = { CreatedBy: 'alice', Team: 'platform' };
    const live = { Team: 'platform' };
    expect(baselineValueMatches(recorded, live, 'AWS::Cognito::UserPool', 'UserPoolTags')).toBe(
      false
    );
  });

  it('an UNCHANGED free-form-map fragment still compares equal (reflexive, no false drift)', () => {
    const v = { CreatedBy: 'alice', Team: 'platform', UpdatedAt: '2024-01-01' };
    expect(baselineValueMatches(v, v, 'AWS::Cognito::UserPool', 'UserPoolTags')).toBe(true);
  });

  // POSITIVE CONTROL — must NOT regress #766/#1205: a genuine AWS-managed field at a
  // NON-free-form path is still stripped, so a baseline recorded WITH the managed echo
  // matches the freshly-stripped live value (a pure cdkrd upgrade never resurfaces it).
  it('(#766/#1205 preserved) a managed field at a NON-free-form path is still stripped', () => {
    // Recorded under an older cdkrd that kept the raw managed echoes at the model root.
    const recordedOldShape = {
      Runtime: 'nodejs20.x',
      LastModified: '2024-01-01T00:00:00Z',
      RevisionId: 'abc-123',
    };
    // Today's live value: classify strips those managed fields before f.actual — a DIFFERENT
    // managed value proves the field is genuinely ignored (stripped), not compared.
    const liveStripped = { Runtime: 'nodejs20.x' };
    // No free-form-map segment in the path -> seed stays false -> managed strip runs, matches.
    expect(
      baselineValueMatches(recordedOldShape, liveStripped, 'AWS::Lambda::Function', 'Runtime')
    ).toBe(true);
  });

  it('(#766/#1205 preserved) a managed field is still stripped when NO path is passed', () => {
    const recordedOldShape = { Runtime: 'nodejs20.x', LastModified: '2024-01-01T00:00:00Z' };
    const liveStripped = { Runtime: 'nodejs20.x' };
    expect(baselineValueMatches(recordedOldShape, liveStripped, 'AWS::Lambda::Function')).toBe(
      true
    );
  });
});

// #1277: an ignored DECLARED (or `added`) finding must NOT demote its resource's
// snapshot completeness.
//
// #1210 (fix for #1078) made computeCompleteResources BLOCK/DEMOTE any resource with a
// tier-`ignored` finding whose recordedKey is absent from the snapshot — so un-ignoring a
// never-recorded UNDECLARED value lands at `unrecorded`, not false "appeared since record".
//
// But applyIgnores re-tags DECLARED (and `added`) findings to `ignored` too, discarding the
// origin tier. A DECLARED path can NEVER be in `recorded` (record snapshots undeclared/added
// only), so the completeness guard fired UNCONDITIONALLY for every ignored declared drift —
// silently demoting the resource to not-snapshot-complete. A later out-of-band appearance on
// that resource then read as `unrecorded` (excluded from --fail) instead of confirmed
// "appeared since record" drift = an FN downgrade.
//
// The fix: applyIgnores stamps `ignoredFrom: <original tier>`; computeCompleteResources gates
// its demotion on `ignoredFrom === 'undeclared'`. An ignored declared/added finding leaves
// completeness untouched; the #1078 undeclared behavior is preserved.
import { describe, expect, it } from 'vite-plus/test';
import { computeCompleteResources, type RecordedEntry } from '../src/baseline/baseline-file.js';
import { applyIgnores, type IgnoreScope } from '../src/config/config-file.js';
import type { Finding } from '../src/types.js';

const RES = { logicalId: 'Fn', resourceType: 'AWS::Lambda::Function', path: 'Timeout' };
const scope: IgnoreScope = { stackName: 'S', accountId: '111122223333', region: 'us-east-1' };

const declaredFinding = (): Finding => ({ tier: 'declared', ...RES, desired: 3, actual: 30 });
const undeclaredFinding = (): Finding => ({ tier: 'undeclared', ...RES, actual: 30 });
const addedFinding = (): Finding => ({
  tier: 'added',
  logicalId: 'Api',
  resourceType: 'AWS::ApiGateway::RestApi',
  path: '',
});

const ignoreCfg = (path: string) => ({ ignore: [{ path }] });

describe('applyIgnores stamps ignoredFrom provenance (#1277)', () => {
  it('records the original tier when re-tagging a DECLARED finding to ignored', () => {
    const [out] = applyIgnores([declaredFinding()], scope, ignoreCfg('Fn.Timeout'));
    expect(out?.tier).toBe('ignored');
    expect(out?.ignoredFrom).toBe('declared');
  });

  it('records the original tier when re-tagging an UNDECLARED finding to ignored', () => {
    const [out] = applyIgnores([undeclaredFinding()], scope, ignoreCfg('Fn.Timeout'));
    expect(out?.tier).toBe('ignored');
    expect(out?.ignoredFrom).toBe('undeclared');
  });

  it('records the original tier when re-tagging an ADDED finding to ignored', () => {
    const [out] = applyIgnores([addedFinding()], scope, ignoreCfg('Api'));
    expect(out?.tier).toBe('ignored');
    expect(out?.ignoredFrom).toBe('added');
  });

  it('leaves ignoredFrom unset on a non-matching finding (still its own tier)', () => {
    const [out] = applyIgnores([declaredFinding()], scope, ignoreCfg('Fn.SomethingElse'));
    expect(out?.tier).toBe('declared');
    expect(out?.ignoredFrom).toBeUndefined();
  });
});

describe('computeCompleteResources: ignored DECLARED finding leaves completeness untouched (#1277)', () => {
  it('marks the resource complete when a DECLARED finding is ignored (no false demotion)', () => {
    // The bug: this ignored declared path is absent from `recorded` (record never snapshots
    // declared values), so the pre-fix guard demoted Fn to incomplete -> returned [].
    const ignored = applyIgnores([declaredFinding()], scope, ignoreCfg('Fn.Timeout'));
    expect(computeCompleteResources(['Fn'], ignored, [], ['Fn'])).toEqual(['Fn']);
  });

  it('keeps the resource complete even without previousComplete', () => {
    const ignored = applyIgnores([declaredFinding()], scope, ignoreCfg('Fn.Timeout'));
    expect(computeCompleteResources(['Fn'], ignored, [])).toEqual(['Fn']);
  });

  it('marks the resource complete when an ADDED finding is ignored (added origin does not demote)', () => {
    const ignored = applyIgnores([addedFinding()], scope, ignoreCfg('Api'));
    expect(computeCompleteResources(['Api'], ignored, [], ['Api'])).toEqual(['Api']);
  });
});

describe('computeCompleteResources: #1078 UNDECLARED demotion preserved (#1277)', () => {
  it('still DEMOTES for an ignored UNDECLARED value absent from the snapshot', () => {
    const ignored = applyIgnores([undeclaredFinding()], scope, ignoreCfg('Fn.Timeout'));
    expect(ignored[0]?.ignoredFrom).toBe('undeclared');
    // The #1078 round-trip: a never-recorded ignored undeclared path keeps its resource
    // incomplete, so un-ignoring lands the untouched value at `unrecorded`, not false drift.
    expect(computeCompleteResources(['Fn'], ignored, [], ['Fn'])).toEqual([]);
  });

  it('KEEPS complete when the ignored UNDECLARED path IS recorded (carried forward)', () => {
    const ignored = applyIgnores([undeclaredFinding()], scope, ignoreCfg('Fn.Timeout'));
    const recorded: RecordedEntry[] = [{ ...RES, value: 30 }];
    expect(computeCompleteResources(['Fn'], ignored, recorded, ['Fn'])).toEqual(['Fn']);
  });
});

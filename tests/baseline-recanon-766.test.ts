import { describe, expect, it } from 'vite-plus/test';
import { baselineValueMatches } from '../src/baseline/baseline-file.js';
import { stripAwsTagsDeep } from '../src/normalize/noise.js';
import { canonicalizeForCompare } from '../src/normalize/pipeline.js';
import { stripCcApiAwsManagedFields } from '../src/normalize/cc-api-strip.js';

// #766: `baselineValueMatches` covered only PART of the live-value pipeline. The live value
// that becomes a finding's `f.actual` (and therefore the recorded `entry.value`) passes,
// in classify's `normalizeLiveModel`, `stripCcApiAwsManagedFields` + `stripAwsTagsDeep` +
// `canonicalizeForCompare` + the schema strip + `sortUnorderedSetProps`. But
// `baselineValueMatches` re-applied ONLY `canonicalizeForCompare` to the stored baseline
// value. So when a later cdkrd version ADDS/CHANGES one of the OTHER strips (a new
// AWS-managed field name, a new `aws:*`-tag-strip case), a baseline recorded PRE-strip no
// longer matches the freshly-stripped live value — a pure cdkrd UPGRADE (no template / AWS
// change) turns committed baselines into a "changed since record" drift storm.
//
// The fix re-applies the DEEP, ROOT-AGNOSTIC strips (`stripCcApiAwsManagedFields`,
// `stripAwsTagsDeep`) + the #767 canonical-JSON object-array sort to the stored value too,
// and threads `resourceType` through the pipeline. Each test below records a baseline value
// in the OLD (un-stripped) shape and shows it now compares EQUAL to the freshly-stripped
// live value. Without the fix (`canonicalizeForCompare` alone) the compare mismatches.
describe('#766 baselineValueMatches re-applies the full live-value strip pipeline', () => {
  // The freshly-stripped live value the finding carries as `f.actual` (classify has already
  // dropped the AWS-managed field / `aws:*` tag from the live model).
  const strip = (v: unknown): unknown =>
    canonicalizeForCompare(stripAwsTagsDeep(stripCcApiAwsManagedFields(v as never)));

  it('(recanon) baseline recorded WITH an AWS-managed field matches the stripped live value', () => {
    // A baseline recorded before the version that started stripping this managed field —
    // it kept the raw `LastModified` / `RevisionId` AWS echoes inside the value.
    const recordedOldShape = {
      Runtime: 'nodejs20.x',
      LastModified: '2024-01-01T00:00:00Z',
      RevisionId: 'abc-123-def',
    };
    // Today's live value: classify strips those managed fields before it becomes f.actual.
    const liveStripped = strip({
      Runtime: 'nodejs20.x',
      LastModified: '2099-12-31T00:00:00Z', // a DIFFERENT value — proves it is truly ignored
      RevisionId: 'zzz-999',
    });
    // Sanity: the recorded old shape carries the managed field, the live one does not.
    expect(Object.keys(recordedOldShape)).toContain('LastModified');
    expect(Object.keys(liveStripped as object)).not.toContain('LastModified');
    // WITH the fix: the stored value is re-stripped, so it matches. WITHOUT it (canonicalize
    // only) the recorded `LastModified`/`RevisionId` survive and mismatch the stripped live.
    expect(baselineValueMatches(recordedOldShape, liveStripped, 'AWS::Lambda::Function')).toBe(
      true
    );
  });

  it('(recanon) baseline recorded WITH an aws:* tag matches the aws:*-stripped live value', () => {
    // A tag list recorded before the `aws:*`-tag strip covered this shape: the raw baseline
    // kept the service-managed `aws:cloudformation:*` tag AWS auto-attaches.
    const recordedOldShape = [
      { Key: 'Team', Value: 'platform' },
      { Key: 'aws:cloudformation:stack-name', Value: 'MyStack' },
    ];
    // Today's live value: classify's stripAwsTagsDeep drops the `aws:*` element.
    const liveStripped = strip([
      { Key: 'aws:cloudformation:stack-name', Value: 'MyStack' },
      { Key: 'Team', Value: 'platform' },
    ]);
    expect(baselineValueMatches(recordedOldShape, liveStripped)).toBe(true);
  });

  it('(recanon) a managed field nested inside the value is also folded', () => {
    const recordedOldShape = {
      LoggingConfiguration: { Level: 'ALL', CreatedAt: '2024-01-01T00:00:00Z' },
    };
    const liveStripped = strip({
      LoggingConfiguration: { Level: 'ALL', CreatedAt: '2030-06-06T00:00:00Z' },
    });
    expect(
      baselineValueMatches(recordedOldShape, liveStripped, 'AWS::StepFunctions::StateMachine')
    ).toBe(true);
  });

  // NEGATIVE guards: re-stripping only removes AWS-managed noise / reorders — it must NOT
  // loosen the predicate into matching genuinely-different user values.
  it('(negative) a real user-value change still surfaces as changed', () => {
    const recorded = { Runtime: 'nodejs20.x', LastModified: '2024-01-01T00:00:00Z' };
    const changed = strip({ Runtime: 'nodejs22.x', LastModified: '2024-01-01T00:00:00Z' });
    expect(baselineValueMatches(recorded, changed, 'AWS::Lambda::Function')).toBe(false);
  });

  it('(negative) a real (non-aws:*) tag change still surfaces as changed', () => {
    const recorded = [
      { Key: 'Team', Value: 'platform' },
      { Key: 'aws:cloudformation:stack-name', Value: 'MyStack' },
    ];
    const changed = strip([{ Key: 'Team', Value: 'CHANGED' }]);
    expect(baselineValueMatches(recorded, changed)).toBe(false);
  });

  it('(reflexive) a value recorded under TODAY rules still matches itself', () => {
    const v = { Runtime: 'nodejs20.x', Tags: [{ Key: 'Team', Value: 'platform' }] };
    expect(baselineValueMatches(v, v, 'AWS::Lambda::Function')).toBe(true);
  });
});

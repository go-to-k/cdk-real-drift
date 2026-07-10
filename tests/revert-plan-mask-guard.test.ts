// Revert guard for GetTemplate `?`-masked declared values (#1247 follow-up). A declared
// drift can carry masks in `desired` even after the classify-side demotion (#1341): when
// a GENUINE out-of-band edit exists ALONGSIDE the masks, the finding rightly stays
// declared drift — but writing that desired back would stamp literal `?` runs over the
// live non-ASCII text wherever the template's literals were masked. The plan must refuse
// it (notRevertable with an actionable reason), never emit the corrupting write. Unlike
// the #1225 write-time guard (reverted in #1243 for false-aborting on writer-shape
// mismatches), this compares finding.desired vs finding.actual — both from classify's
// one normalized domain — and fires only on positive per-leaf mask evidence.
import { describe, expect, it } from 'vite-plus/test';
import {
  buildRevertPlan,
  hasGetTemplateMaskedLeaf,
  maskReadGapKeysOf,
} from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

const mask = (s: string): string =>
  [...s].map((ch) => ((ch.codePointAt(0) ?? 0) > 0x7f ? '?' : ch)).join('');

// Generic fixture text (not from any real environment).
const LIVE_CAUSE = '入力値 item.<type>.<size> が不正です';

const F = (over: Partial<Finding>): Finding => ({
  tier: 'declared',
  logicalId: 'Machine',
  physicalId: 'arn:aws:states:us-east-1:111111111111:stateMachine:m',
  resourceType: 'AWS::StepFunctions::StateMachine',
  path: 'DefinitionString',
  ...over,
});

describe('hasGetTemplateMaskedLeaf', () => {
  it('finds a masked leaf INSIDE a JSON string even when a genuine edit broke whole-string alignment', () => {
    const live = `{"States":{"Bad":{"Cause":"${LIVE_CAUSE}","Error":"InvalidFormat"}}}`;
    // Out-of-band edit changed Error (so raw strings are not mask-aligned), Cause is masked.
    const desired = `{"States":{"Bad":{"Cause":"${mask(LIVE_CAUSE)}","Error":"WrongCode"}}}`;
    expect(hasGetTemplateMaskedLeaf(desired, live)).toBe(true);
  });

  it('does NOT fire on a legit literal "?" against an ASCII live value', () => {
    expect(hasGetTemplateMaskedLeaf('is it ok?', 'is it ok!')).toBe(false);
    expect(hasGetTemplateMaskedLeaf({ a: 'x?' }, { a: 'y!' })).toBe(false);
  });

  it('does NOT fire when the values are plain non-JSON strings that differ genuinely', () => {
    expect(hasGetTemplateMaskedLeaf('Enabled', 'Suspended')).toBe(false);
  });

  it('walks objects and arrays in parallel and ignores unaligned branches', () => {
    const desired = { list: [{ label: mask(LIVE_CAUSE) }], extraOnlyInDesired: '???' };
    const live = { list: [{ label: LIVE_CAUSE }], other: 1 };
    expect(hasGetTemplateMaskedLeaf(desired, live)).toBe(true);
    // The masked leaf gone -> nothing aligned masks -> false.
    expect(hasGetTemplateMaskedLeaf({ extraOnlyInDesired: '???' }, { other: 1 })).toBe(false);
  });
});

describe('buildRevertPlan — masked declared desired is refused, not written', () => {
  it('reports notRevertable (with the mask reason) instead of emitting a write op', () => {
    const live = `{"States":{"Bad":{"Cause":"${LIVE_CAUSE}","Error":"InvalidFormat"}}}`;
    const desired = `{"States":{"Bad":{"Cause":"${mask(LIVE_CAUSE)}","Error":"WrongCode"}}}`;
    const plan = buildRevertPlan([F({ desired, actual: live })], undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0].reason).toContain('non-ASCII-masked by GetTemplate');
  });

  it('still plans a normal declared revert when no mask is involved', () => {
    const plan = buildRevertPlan(
      [
        F({
          resourceType: 'AWS::S3::Bucket',
          path: 'VersioningConfiguration.Status',
          desired: 'Enabled',
          actual: 'Suspended',
        }),
      ],
      undefined
    );
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
  });

  it('refuses a WHOLE-ARRAY revert whose declared array contains a masked sibling element', () => {
    // A tag list where one value was genuinely edited out of band (declared drift with a
    // whole-array revert) while ANOTHER tag's value is non-ASCII (its own leaf demoted to
    // a masked readGap). The whole-array write would stamp the masked element too — the
    // sibling readGap (correlated via maskReadGapKeys) is the evidence.
    const maskedTagList = [
      { Key: 'purpose', Value: mask('検証用') },
      { Key: 'team', Value: 'edited-out-of-band' },
    ];
    const declared = F({
      resourceType: 'AWS::S3::Bucket',
      path: 'Tags',
      desired: 'team-orig',
      actual: 'edited-out-of-band',
      wholeArrayRevert: { path: 'Tags', value: maskedTagList },
    });
    const maskGap: Finding = {
      tier: 'readGap',
      logicalId: 'Machine',
      resourceType: 'AWS::S3::Bucket',
      path: 'Tags.0.Value',
      note: 'declared value unverifiable — CloudFormation GetTemplate masks non-ASCII characters as "?"',
    };
    // Full-list input (standalone revert): the readGap rides along in findings.
    const plan = buildRevertPlan([declared, maskGap], undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable.map((n) => n.reason).join()).toContain(
      'non-ASCII-masked by GetTemplate'
    );
    // Subset input (interactive picked-finding flow): the readGap is NOT in findings —
    // the caller passes the keys computed over the full reconciled list instead.
    const subset = buildRevertPlan([declared], undefined, {
      maskReadGapKeys: maskReadGapKeysOf([maskGap]),
    });
    expect(subset.items).toHaveLength(0);
    expect(subset.notRevertable).toHaveLength(1);
  });

  it('does NOT block a per-key attribute revert over a masked SIBLING it never writes', () => {
    // ELB attribute bags revert per Key=Value (no wholeArrayRevert): a masked sibling
    // attribute must not block reverting a different, genuinely edited attribute.
    const declared = F({
      resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      physicalId: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/tg/1',
      path: 'TargetGroupAttributes',
      attributeKey: 'deregistration_delay.timeout_seconds',
      desired: '300',
      actual: '60',
    });
    const plan = buildRevertPlan([declared], undefined, {
      maskReadGapKeys: new Set(['Machine\0TargetGroupAttributes']),
    });
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
  });

  it('does not gate the undeclared tier (baseline values come from the intact live read)', () => {
    // An undeclared restore whose baseline value legitimately contains "?" must not be
    // blocked: the guard is declared-only by design.
    const plan = buildRevertPlan(
      [
        F({
          tier: 'undeclared',
          resourceType: 'AWS::S3::Bucket',
          path: 'Description',
          desired: undefined,
          actual: 'now-live',
        }),
      ],
      {
        schemaVersion: 1,
        stackName: 's',
        region: 'r',
        accountId: '111122223333',
        capturedAt: '',
        templateHash: '',
        recorded: [
          {
            logicalId: 'Machine',
            resourceType: 'AWS::S3::Bucket',
            path: 'Description',
            value: 'was: ok?',
          },
        ],
      }
    );
    expect(plan.notRevertable.filter((n) => n.reason.includes('non-ASCII-masked'))).toHaveLength(0);
  });
});

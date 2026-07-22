// #1686 (gdsets2-hunt 2026-07-22): a barest GuardDuty ThreatEntitySet / TrustedEntitySet
// (no ExpectedBucketOwner declared) reads back the resource's OWN account id — GuardDuty
// materializes the caller account as the default expected owner of the list bucket, which
// first-run-FP'd as [Potential Drift]. Folded via CONTEXT_ARN_DEFAULTS ({accountId}
// placeholder — plain string, not an ARN), equality-gated so a DIFFERENT owner account (a
// real cross-account exposure change) still surfaces.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const emptySchema: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};

const opts = { accountId: '111111111111', region: 'us-east-1' };

const tierPaths = (findings: Finding[]) => findings.map((f) => `${f.tier}:${f.path}`).sort();

for (const resourceType of [
  'AWS::GuardDuty::ThreatEntitySet',
  'AWS::GuardDuty::TrustedEntitySet',
] as const) {
  describe(`#1686 ${resourceType} ExpectedBucketOwner own-account default`, () => {
    const declared = {
      DetectorId: 'd0123456789abcdef',
      Name: 'cdkrd-hunt-set',
      Format: 'TXT',
      Location: 'https://s3.amazonaws.com/bucket/list.txt',
      Activate: true,
    };
    const res: DesiredResource = {
      logicalId: 'HuntSet',
      resourceType,
      physicalId: 'abcdef0123456789',
      declared,
    };
    const live = { ...declared, ExpectedBucketOwner: '111111111111' };

    it('folds the own-account ExpectedBucketOwner to atDefault (zero potential drift)', () => {
      const f = classifyResource(res, live, emptySchema, opts);
      expect(tierPaths(f)).toContain('atDefault:ExpectedBucketOwner');
      expect(tierPaths(f).filter((t) => t.startsWith('undeclared:'))).toEqual([]);
    });

    it('SURFACES a different (cross-account) ExpectedBucketOwner', () => {
      const f = classifyResource(
        res,
        { ...declared, ExpectedBucketOwner: '222222222222' },
        emptySchema,
        opts
      );
      expect(tierPaths(f)).toContain('undeclared:ExpectedBucketOwner');
    });
  });
}

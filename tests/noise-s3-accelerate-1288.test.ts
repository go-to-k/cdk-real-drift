// #1288 S3 AccelerateConfiguration Suspended off-state fold. Transfer acceleration has
// identical semantics to versioning (R46): PutBucketAccelerateConfiguration accepts only
// Enabled|Suspended, there is no delete, and once ever touched Suspended is returned
// forever — it IS the off/default state, not user intent. Without the fold an undeclared
// {AccelerationStatus:"Suspended"} re-reports on every first check and revert of an OOB
// Enabled can never converge. Equality-gated: an OOB Enabled still surfaces.
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
const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();
const bucket = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'R',
  resourceType: 'AWS::S3::Bucket',
  physicalId: 'phys',
  declared,
});

describe('#1288 S3 AccelerateConfiguration Suspended off-state', () => {
  const res = bucket({ BucketName: 'b' });

  it('folds an undeclared {AccelerationStatus:"Suspended"} to atDefault', () => {
    const f = classifyResource(
      res,
      { AccelerateConfiguration: { AccelerationStatus: 'Suspended' } },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('AccelerateConfiguration');
    expect(tier(f, 'undeclared')).not.toContain('AccelerateConfiguration');
  });

  it('surfaces an out-of-band Enabled as undeclared (detection preserved)', () => {
    const f = classifyResource(
      res,
      { AccelerateConfiguration: { AccelerationStatus: 'Enabled' } },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('AccelerateConfiguration');
    expect(tier(f, 'atDefault')).not.toContain('AccelerateConfiguration');
  });
});

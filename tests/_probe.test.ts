import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, SchemaInfo } from '../src/types.js';
const schema: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};
const res = (rt: string, declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'L',
  resourceType: rt,
  physicalId: 'b',
  declared,
});
describe('probe2', () => {
  it('added tag', () => {
    const f = classifyResource(
      res('AWS::S3::Bucket', { Tags: [{ Key: 'team', Value: 'platform' }] }),
      {
        Tags: [
          { Key: 'team', Value: 'platform' },
          { Key: 'rogue', Value: 'x' },
        ],
      },
      schema
    );
    console.log('ADDED2=' + JSON.stringify(f.map((x) => x.tier + ':' + x.path)));
    expect(f.length).toBeGreaterThan(0);
  });
});

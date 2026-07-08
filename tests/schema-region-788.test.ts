import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { describe, expect, it } from 'vite-plus/test';
import { getSchemaInfo } from '../src/schema/schema-strip.js';

// #788: the DescribeType schema cache is a REGIONAL call keyed per-region. Registry
// schema rollouts are region-staggered, so region 1's schema must NOT leak to another
// region's stack of the same resourceType in a multi-region `--all` run. The cache is
// keyed on `${region}\0${resourceType}` — a fake client whose region + DescribeType
// response differ per region must yield the region-correct schema, not a cached copy.

// Build a minimal CloudFormationClient-like fake: `.config.region()` resolves to the
// given region, and `.send()` returns a DescribeType response with the given Schema.
function fakeClient(region: string, schema: unknown): CloudFormationClient {
  return {
    config: { region: () => Promise.resolve(region) },
    send: () => Promise.resolve({ Schema: JSON.stringify(schema) }),
  } as unknown as CloudFormationClient;
}

describe('getSchemaInfo region-aware cache (#788)', () => {
  it('does not leak region A schema to region B for the same resourceType', async () => {
    // Same resourceType, but the property `Foo` is writeOnly ONLY in us-east-1.
    const resourceType = 'AWS::Foo::Region788Bar';
    const schemaEast = {
      properties: { Foo: { type: 'string' }, Baz: { type: 'string' } },
      writeOnlyProperties: ['/properties/Foo'],
    };
    const schemaTokyo = {
      properties: { Foo: { type: 'string' }, Baz: { type: 'string' } },
      writeOnlyProperties: [],
    };

    const clientEast = fakeClient('us-east-1', schemaEast);
    const clientTokyo = fakeClient('ap-northeast-1', schemaTokyo);

    // Populate the cache under us-east-1 first.
    const east = await getSchemaInfo(clientEast, resourceType);
    expect(east.writeOnly.has('Foo')).toBe(true);

    // The Tokyo client must get Tokyo's schema (Foo NOT writeOnly), NOT the cached
    // us-east-1 copy. Before the fix (cache keyed on resourceType only) this returned
    // the us-east-1 schema and `writeOnly.has('Foo')` would wrongly be true.
    const tokyo = await getSchemaInfo(clientTokyo, resourceType);
    expect(tokyo.writeOnly.has('Foo')).toBe(false);

    // And the us-east-1 entry is still correct (both regions coexist in the cache).
    const eastAgain = await getSchemaInfo(clientEast, resourceType);
    expect(eastAgain.writeOnly.has('Foo')).toBe(true);
  });
});

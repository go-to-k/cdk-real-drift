import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { declaredTagKeys, subtractPropagatedStackTags } from '../src/normalize/stack-tags.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// #683 — CloudFormation STACK-level tags (`cdk deploy --tags k=v`) are propagated by CFN onto
// every taggable resource WITHOUT appearing in the template. stripAwsTagsDeep only removes
// aws:* tags, so the propagated USER tags surfaced as a clean-deploy tag FP: a declared-tier FP
// on resources that declare Tags (declared list ⊂ live list) and a first-run undeclared `Tags`
// FP on resources with none. classify subtracts them from the live top-level Tags (keeping any
// key the resource itself declares).
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
const tier = (fs: Finding[], t: string): string[] =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();
const stackTags = { team: 'platform', costcenter: '1234' };

describe('#683 subtractPropagatedStackTags / declaredTagKeys (pure)', () => {
  it('declaredTagKeys extracts the declared top-level Tag keys', () => {
    const keys = declaredTagKeys({
      Tags: [
        { Key: 'app', Value: 'x' },
        { Key: 'tier', Value: 'storage' },
      ],
    });
    expect([...keys].sort()).toEqual(['app', 'tier']);
  });

  it('drops a propagated stack tag the resource does not declare', () => {
    const out = subtractPropagatedStackTags(
      {
        Tags: [
          { Key: 'app', Value: 'x' },
          { Key: 'team', Value: 'platform' },
        ],
      },
      stackTags,
      new Set(['app'])
    );
    expect(out.Tags).toEqual([{ Key: 'app', Value: 'x' }]);
  });

  it('KEEPS a stack-tag key the resource DECLARES (compared normally)', () => {
    const live = { Tags: [{ Key: 'team', Value: 'platform' }] };
    const out = subtractPropagatedStackTags(live, stackTags, new Set(['team']));
    expect(out).toEqual(live);
  });

  it('KEEPS a same-key tag whose VALUE differs from the stack tag (real divergence surfaces)', () => {
    const live = { Tags: [{ Key: 'team', Value: 'attacker' }] };
    const out = subtractPropagatedStackTags(live, stackTags, new Set());
    expect(out).toEqual(live);
  });

  it('no stack tags → identity (no-op)', () => {
    const live = { Tags: [{ Key: 'team', Value: 'platform' }] };
    expect(subtractPropagatedStackTags(live, {}, new Set())).toBe(live);
  });
});

describe('#683 classifyResource end-to-end (zero tag FP on a --tags deploy)', () => {
  const declaredTags = [
    { Key: 'app', Value: 'cdkrd-hunt' },
    { Key: 'tier', Value: 'storage' },
  ];
  const liveTags = [
    { Key: 'costcenter', Value: '1234' },
    { Key: 'app', Value: 'cdkrd-hunt' },
    { Key: 'team', Value: 'platform' },
    { Key: 'tier', Value: 'storage' },
  ];

  it('a bucket WITH declared Tags shows no declared-tier Tags FP', () => {
    const resource: DesiredResource = {
      logicalId: 'Data',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'data-bucket',
      declared: { Tags: declaredTags },
    };
    const f = classifyResource(resource, { Tags: liveTags }, emptySchema, { stackTags });
    expect(tier(f, 'declared')).not.toContain('Tags');
  });

  it('a queue WITHOUT declared Tags shows no first-run undeclared Tags FP', () => {
    const resource: DesiredResource = {
      logicalId: 'Work',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'work-queue',
      declared: {},
    };
    const f = classifyResource(
      resource,
      {
        Tags: [
          { Key: 'costcenter', Value: '1234' },
          { Key: 'team', Value: 'platform' },
        ],
      },
      emptySchema,
      { stackTags }
    );
    expect(tier(f, 'undeclared')).not.toContain('Tags');
  });

  it('detection preserved: an out-of-band tag that is NOT a stack tag still surfaces undeclared', () => {
    const resource: DesiredResource = {
      logicalId: 'Work',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'work-queue',
      declared: {},
    };
    const f = classifyResource(
      resource,
      {
        Tags: [
          { Key: 'rogue', Value: 'evil' },
          { Key: 'team', Value: 'platform' },
        ],
      },
      emptySchema,
      { stackTags }
    );
    expect(tier(f, 'undeclared')).toContain('Tags');
  });
});

// Hunt 2026-07-21 (zerocorpus-hunt): some EC2 registry handlers (CapacityReservation) echo the
// create-time TagSpecifications INPUT wrapper back on read with the propagated stack tags
// inside each spec — the same FP class one level down. The subtraction now reaches inside the
// wrapper (dropping emptied specs and the emptied wrapper), and declaredTagKeys collects keys
// from a DECLARED TagSpecifications so declared intent is still protected.
describe('TagSpecifications wrapper subtraction (hunt 2026-07-21)', () => {
  it('drops the wrapper when every spec holds only propagated stack tags', () => {
    const out = subtractPropagatedStackTags(
      {
        TagSpecifications: [
          { ResourceType: 'capacity-reservation', Tags: [{ Key: 'team', Value: 'platform' }] },
        ],
      },
      stackTags,
      new Set()
    );
    expect(out.TagSpecifications).toBeUndefined();
  });

  it('keeps a non-stack tag (and its spec) while subtracting the propagated ones', () => {
    const out = subtractPropagatedStackTags(
      {
        TagSpecifications: [
          {
            ResourceType: 'capacity-reservation',
            Tags: [
              { Key: 'team', Value: 'platform' },
              { Key: 'rogue', Value: 'evil' },
            ],
          },
        ],
      },
      stackTags,
      new Set()
    );
    expect(out.TagSpecifications).toEqual([
      { ResourceType: 'capacity-reservation', Tags: [{ Key: 'rogue', Value: 'evil' }] },
    ]);
  });

  it('a declared TagSpecifications key is protected from the subtraction', () => {
    const keys = declaredTagKeys({
      TagSpecifications: [
        { ResourceType: 'capacity-reservation', Tags: [{ Key: 'team', Value: 'mine' }] },
      ],
    });
    expect([...keys]).toEqual(['team']);
    const out = subtractPropagatedStackTags(
      {
        TagSpecifications: [
          { ResourceType: 'capacity-reservation', Tags: [{ Key: 'team', Value: 'platform' }] },
        ],
      },
      stackTags,
      keys
    );
    expect(out.TagSpecifications).toEqual([
      { ResourceType: 'capacity-reservation', Tags: [{ Key: 'team', Value: 'platform' }] },
    ]);
  });

  it('a value that differs from the stack tag is preserved (exact-match subtraction only)', () => {
    const out = subtractPropagatedStackTags(
      {
        TagSpecifications: [
          { ResourceType: 'capacity-reservation', Tags: [{ Key: 'team', Value: 'other' }] },
        ],
      },
      stackTags,
      new Set()
    );
    expect(out.TagSpecifications).toEqual([
      { ResourceType: 'capacity-reservation', Tags: [{ Key: 'team', Value: 'other' }] },
    ]);
  });
});

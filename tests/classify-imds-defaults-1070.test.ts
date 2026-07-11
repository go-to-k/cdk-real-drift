// #1070 item 3 — EC2::Instance MetadataOptions IMDS defaults are settable ACCOUNT-wide
// (ec2:modify-instance-metadata-defaults), so the AL2023 KNOWN_DEFAULTS constant FPs on every fresh
// launch in a hardened account. classify overlays the account-SET fields (opts.accountDefaults
// .instanceMetadataDefaults, prefetched by gather.ts) onto the constant, kept WHOLE-OBJECT
// equality-gated: a hardened clean deploy folds; a value the overlay gets wrong (or #640 AMI
// variance) simply doesn't match and SURFACES (recordable) — never a false fold.
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
const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'R',
  resourceType: 'AWS::EC2::Instance',
  physicalId: 'phys',
  declared,
});
// The AL2023 MetadataOptions KNOWN_DEFAULTS constant an instance reads back undeclared.
const AL2023 = {
  HttpTokens: 'required',
  HttpPutResponseHopLimit: 2,
  HttpProtocolIpv6: 'disabled',
  InstanceMetadataTags: 'disabled',
  HttpEndpoint: 'enabled',
};
const res = mk({ ImageId: 'ami-1' });

describe('#1070 item 3 EC2::Instance MetadataOptions — account IMDS-default overlay', () => {
  it('folds a hardened clean deploy: account hop-limit 1 → live {..., hop:1} folds atDefault', () => {
    const live = { MetadataOptions: { ...AL2023, HttpPutResponseHopLimit: 1 } };
    const f = classifyResource(res, live, emptySchema, {
      accountDefaults: { instanceMetadataDefaults: { HttpPutResponseHopLimit: 1 } },
    });
    expect(tier(f, 'atDefault')).toContain('MetadataOptions');
    expect(tier(f, 'undeclared')).not.toContain('MetadataOptions');
  });

  it('without the overlay the SAME hardened live surfaces (proves the overlay does the work)', () => {
    const live = { MetadataOptions: { ...AL2023, HttpPutResponseHopLimit: 1 } };
    const f = classifyResource(res, live, emptySchema, {});
    expect(tier(f, 'undeclared')).toContain('MetadataOptions');
    expect(tier(f, 'atDefault')).not.toContain('MetadataOptions');
  });

  it('folds an account that enabled InstanceMetadataTags', () => {
    const live = { MetadataOptions: { ...AL2023, InstanceMetadataTags: 'enabled' } };
    const f = classifyResource(res, live, emptySchema, {
      accountDefaults: { instanceMetadataDefaults: { InstanceMetadataTags: 'enabled' } },
    });
    expect(tier(f, 'atDefault')).toContain('MetadataOptions');
  });

  it('SURFACES when the live value differs from the account default (detection preserved)', () => {
    // account default hop:1, but the instance reads hop:2 (AMI default won / not applied) → mismatch.
    const live = { MetadataOptions: { ...AL2023, HttpPutResponseHopLimit: 2 } };
    const f = classifyResource(res, live, emptySchema, {
      accountDefaults: { instanceMetadataDefaults: { HttpPutResponseHopLimit: 1 } },
    });
    expect(tier(f, 'undeclared')).toContain('MetadataOptions');
    expect(tier(f, 'atDefault')).not.toContain('MetadataOptions');
  });

  it('fail-open: no prefetch → the plain AL2023 constant still folds a clean deploy', () => {
    const f = classifyResource(res, { MetadataOptions: { ...AL2023 } }, emptySchema, {});
    expect(tier(f, 'atDefault')).toContain('MetadataOptions');
  });
});

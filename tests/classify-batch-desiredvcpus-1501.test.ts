// #1501: a MANAGED Batch ComputeEnvironment's undeclared ComputeResources.DesiredvCpus is
// SERVICE-MANAGED — Batch scales it continuously with the job load (0 when idle, up to MaxvCpus as
// jobs run), so no constant / ONE_OF / derivation can pin it and an equality-gate on the creation
// value (0) would FP on every busy environment after record. Folded via the new NESTED value-
// independent table (VALUE_INDEPENDENT_DEFAULT_NESTED_PATHS) — the tier-3 "nested kin" of the
// top-level table — to atDefault regardless of value. Live-repro'd 2026-07-12 (us-east-1) on a
// barest MANAGED/EC2 CE; the AWS__Batch__ComputeEnvironment.HuntEc2Ce corpus case pins the fold.
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

const findByPath = (findings: Finding[], path: string) => findings.find((f) => f.path === path);

// A MANAGED/EC2 CE that declares its ComputeResources but not DesiredvCpus (the CDK-typical shape).
const res: DesiredResource = {
  logicalId: 'HuntEc2Ce',
  resourceType: 'AWS::Batch::ComputeEnvironment',
  physicalId: 'arn:aws:batch:us-east-1:111111111111:compute-environment/HuntEc2Ce-abc',
  declared: {
    Type: 'MANAGED',
    ComputeResources: {
      Type: 'EC2',
      MaxvCpus: 4,
      MinvCpus: 0,
      InstanceTypes: ['m5.large'],
      Subnets: ['subnet-0'],
      SecurityGroupIds: ['sg-0'],
      InstanceRole: 'arn:aws:iam::111111111111:instance-profile/p',
    },
  },
};

describe('#1501 Batch ComputeEnvironment DesiredvCpus nested value-independent fold', () => {
  it('folds an idle DesiredvCpus=0 to atDefault (value-independent), not undeclared', () => {
    const live = {
      Type: 'MANAGED',
      ComputeResources: {
        Type: 'EC2',
        MaxvCpus: 4,
        MinvCpus: 0,
        InstanceTypes: ['m5.large'],
        Subnets: ['subnet-0'],
        SecurityGroupIds: ['sg-0'],
        InstanceRole: 'arn:aws:iam::111111111111:instance-profile/p',
        DesiredvCpus: 0,
      },
    };
    const f = classifyResource(res, live, emptySchema);
    const finding = findByPath(f, 'ComputeResources.DesiredvCpus');
    expect(finding?.tier).toBe('atDefault');
  });

  it('folds a SCALED DesiredvCpus (value-independent: any value AWS moves it to is atDefault)', () => {
    const live = {
      Type: 'MANAGED',
      ComputeResources: {
        Type: 'EC2',
        MaxvCpus: 4,
        MinvCpus: 0,
        InstanceTypes: ['m5.large'],
        Subnets: ['subnet-0'],
        SecurityGroupIds: ['sg-0'],
        InstanceRole: 'arn:aws:iam::111111111111:instance-profile/p',
        DesiredvCpus: 3,
      },
    };
    const f = classifyResource(res, live, emptySchema);
    const finding = findByPath(f, 'ComputeResources.DesiredvCpus');
    expect(finding?.tier).toBe('atDefault');
  });

  it('does NOT fold an unrelated nested path on the same resource (table is path-scoped)', () => {
    const live = {
      Type: 'MANAGED',
      ComputeResources: {
        Type: 'EC2',
        MaxvCpus: 4,
        MinvCpus: 0,
        InstanceTypes: ['m5.large'],
        Subnets: ['subnet-0'],
        SecurityGroupIds: ['sg-0'],
        InstanceRole: 'arn:aws:iam::111111111111:instance-profile/p',
        DesiredvCpus: 0,
        // An out-of-band nested scalar NOT in the value-independent table must still surface.
        BidPercentage: 50,
      },
    };
    const f = classifyResource(res, live, emptySchema);
    expect(findByPath(f, 'ComputeResources.DesiredvCpus')?.tier).toBe('atDefault');
    expect(findByPath(f, 'ComputeResources.BidPercentage')?.tier).toBe('undeclared');
  });
});

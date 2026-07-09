import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// #979 — three EKS values AWS assigns at creation surfaced as undeclared [Potential Drift]
// on a clean first check, with code comments rationalizing them as "record-worthy". Each
// fits a fold tier: Cluster.KubernetesNetworkConfig.ServiceIpv4Cidr is one of two documented
// constants (nested KNOWN_DEFAULT_ONE_OF_PATHS), Cluster.Version + Addon.AddonVersion are
// moving GA versions (value-independent). Detection preserved where meaningful.
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
const undeclared = (fs: Finding[]): string[] => tier(fs, 'undeclared');
const mk = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId: 'phys',
  declared,
});

describe('#979 EKS Cluster first-run folds', () => {
  const declared = {
    Name: 'c',
    RoleArn: 'arn:aws:iam::111122223333:role/eks',
    ResourcesVpcConfig: { SubnetIds: ['subnet-1'] },
  };

  for (const cidr of ['10.100.0.0/16', '172.20.0.0/16']) {
    it(`folds ServiceIpv4Cidr=${cidr} (one of the two documented constants)`, () => {
      const f = classifyResource(
        mk('AWS::EKS::Cluster', declared),
        {
          ...declared,
          KubernetesNetworkConfig: { ServiceIpv4Cidr: cidr, IpFamily: 'ipv4' },
          Version: '1.36',
        },
        emptySchema
      );
      expect(undeclared(f)).not.toContain('KubernetesNetworkConfig.ServiceIpv4Cidr');
      expect(undeclared(f)).not.toContain('Version');
    });
  }

  it('surfaces a ServiceIpv4Cidr OUTSIDE the two-constant set (equality-gated)', () => {
    const f = classifyResource(
      mk('AWS::EKS::Cluster', declared),
      {
        ...declared,
        KubernetesNetworkConfig: { ServiceIpv4Cidr: '192.168.0.0/16', IpFamily: 'ipv4' },
      },
      emptySchema
    );
    expect(undeclared(f)).toContain('KubernetesNetworkConfig.ServiceIpv4Cidr');
  });

  it('folds an undeclared Version regardless of the concrete GA value (value-independent)', () => {
    const f = classifyResource(
      mk('AWS::EKS::Cluster', declared),
      { ...declared, Version: '1.99' },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('Version');
    expect(undeclared(f)).not.toContain('Version');
  });
});

describe('#979 EKS Addon AddonVersion fold', () => {
  it('folds an undeclared AddonVersion (moving default) value-independent', () => {
    const declared = { ClusterName: 'c', AddonName: 'vpc-cni' };
    const f = classifyResource(
      mk('AWS::EKS::Addon', declared),
      { ...declared, AddonVersion: 'v1.21.2-eksbuild.2' },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('AddonVersion');
    expect(undeclared(f)).not.toContain('AddonVersion');
  });
});

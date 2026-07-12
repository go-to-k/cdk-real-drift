// #660 item 3 (nested MEANINGFUL_WHEN_OFF): an EKS cluster declares `SubnetIds`, so
// `ResourcesVpcConfig` is PARTIALLY declared and therefore DESCENDED leaf-by-leaf. Its
// `EndpointPublicAccess` `true` default folds atDefault via KNOWN_DEFAULT_PATHS on a clean
// deploy, but an out-of-band `update-cluster-config` flipping it `false` (private-only endpoint)
// would be swallowed by isTrivialEmpty(false) BEFORE the pin gate — invisible. The nested
// off-state twin surfaces the disable as `undeclared` while the clean `true` still folds.
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

const pathsByTier = (findings: Finding[], tier: string) =>
  findings
    .filter((f) => f.tier === tier)
    .map((f) => f.path)
    .sort();

describe('#660 EKS Cluster nested off-flip (ResourcesVpcConfig.EndpointPublicAccess)', () => {
  // A cluster declares SubnetIds (partial ResourcesVpcConfig) — AWS materializes the sibling
  // endpoint defaults, which DESCEND leaf-by-leaf because the object is partially declared.
  const res: DesiredResource = {
    logicalId: 'Cluster',
    resourceType: 'AWS::EKS::Cluster',
    physicalId: 'cdkrd-660-eks',
    declared: {
      Name: 'cdkrd-660-eks',
      RoleArn: 'arn:aws:iam::123456789012:role/eks-cluster-role',
      ResourcesVpcConfig: { SubnetIds: ['subnet-aaa', 'subnet-bbb'] },
    },
  };
  const live = (over: { publicAccess?: unknown }) => ({
    Name: 'cdkrd-660-eks',
    RoleArn: 'arn:aws:iam::123456789012:role/eks-cluster-role',
    ResourcesVpcConfig: {
      SubnetIds: ['subnet-aaa', 'subnet-bbb'],
      EndpointPublicAccess: over.publicAccess ?? true,
      EndpointPrivateAccess: over.publicAccess === false ? true : false,
      PublicAccessCidrs: ['0.0.0.0/0'],
      ControlPlaneEgressMode: 'AWS_MANAGED',
    },
  });
  const ENDPOINT = 'ResourcesVpcConfig.EndpointPublicAccess';
  const CIDRS = 'ResourcesVpcConfig.PublicAccessCidrs';

  it('folds the undeclared endpoint defaults to atDefault (zero first-run drift)', () => {
    const f = classifyResource(res, live({}), emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain(ENDPOINT);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces an out-of-band undeclared EndpointPublicAccess=false disable (#660)', () => {
    const f = classifyResource(res, live({ publicAccess: false }), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain(ENDPOINT);
    // The sibling default still folds — only the disabled flag surfaces.
    expect(pathsByTier(f, 'atDefault')).toContain(CIDRS);
  });
});

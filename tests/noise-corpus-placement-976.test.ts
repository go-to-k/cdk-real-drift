import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// #976 — a batch of first-run undeclared FPs of the AWS-assigns-at-creation class fossilized
// in the golden corpus: a DocDB cluster's default GA EngineVersion + AWS-managed KmsKeyId, a
// Neptune cluster's AWS-picked AvailabilityZones spread, and a TransitGateway's minted default
// route-table ids. Each surfaces as an undeclared [Potential Drift] on a clean first check
// (core-invariant violation). All fold value-independent (tier-3): moving GA version / per-
// account managed-key ARN / per-deploy placement / per-resource AWS-assigned identifier — never
// a constant we can pin, and never user intent when undeclared (a user who cares DECLARES it, and
// it is then compared in the declared loop). Neptune's VpcSecurityGroupIds is MUTABLE out of band
// (ModifyDBCluster swaps SGs) — folding it value-independent would hide an OOB SG swap. #976 folds
// it through the SAME #889 derived VPC-default-SG gate: a single VPC-default SG folds atDefault
// (or fail-open when the default-SG prefetch is unavailable), while a swap/append SURFACES.
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
const mk = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId: 'phys',
  declared,
});

describe('#976 corpus baked first-run FP batch: AWS-assigned placement/key/version defaults', () => {
  it('DocDB DBCluster: undeclared GA EngineVersion + AWS-managed KmsKeyId fold to atDefault', () => {
    const declared = { DBSubnetGroupName: 'docdb-subnet-group', StorageEncrypted: true };
    const f = classifyResource(
      mk('AWS::DocDB::DBCluster', declared),
      {
        ...declared,
        EngineVersion: '5.0.0',
        KmsKeyId: 'arn:aws:kms:us-east-1:111111111111:key/9ee8feba-ae18-445a-bcab-306f7748fb6c',
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('EngineVersion');
    expect(tier(f, 'atDefault')).toContain('KmsKeyId');
    expect(tier(f, 'undeclared')).not.toContain('EngineVersion');
    expect(tier(f, 'undeclared')).not.toContain('KmsKeyId');
  });

  it('DocDB DBCluster: value-independent (a different moving GA version still folds)', () => {
    const declared = { DBSubnetGroupName: 'docdb-subnet-group', StorageEncrypted: true };
    const f = classifyResource(
      mk('AWS::DocDB::DBCluster', declared),
      { ...declared, EngineVersion: '4.0.0' },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('EngineVersion');
    expect(tier(f, 'undeclared')).not.toContain('EngineVersion');
  });

  it('Neptune DBCluster: undeclared AWS-picked AvailabilityZones fold to atDefault', () => {
    const declared = { DBSubnetGroupName: 'neptune-subnet-group' };
    const f = classifyResource(
      mk('AWS::Neptune::DBCluster', declared),
      { ...declared, AvailabilityZones: ['ap-northeast-1a', 'ap-northeast-1c', 'ap-northeast-1d'] },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('AvailabilityZones');
    expect(tier(f, 'undeclared')).not.toContain('AvailabilityZones');
  });

  it('Neptune DBCluster: VpcSecurityGroupIds folds a single default SG, surfaces an OOB swap (#976/#889)', () => {
    const declared = { DBSubnetGroupName: 'neptune-subnet-group' };
    const defaultSgIds = new Set(['sg-09a4346aa4ef78d16']);
    // Single VPC-default SG with the default-SG prefetch resolved → fold atDefault (clean deploy).
    const clean = classifyResource(
      mk('AWS::Neptune::DBCluster', declared),
      { ...declared, VpcSecurityGroupIds: ['sg-09a4346aa4ef78d16'] },
      emptySchema,
      { defaultSgIds }
    );
    expect(tier(clean, 'atDefault')).toContain('VpcSecurityGroupIds');
    expect(tier(clean, 'undeclared')).not.toContain('VpcSecurityGroupIds');
    // An out-of-band SG swap (a non-default SG) SURFACES — the security detection #889 preserves.
    const swapped = classifyResource(
      mk('AWS::Neptune::DBCluster', declared),
      { ...declared, VpcSecurityGroupIds: ['sg-0rogue00000000000'] },
      emptySchema,
      { defaultSgIds }
    );
    expect(tier(swapped, 'undeclared')).toContain('VpcSecurityGroupIds');
    expect(tier(swapped, 'atDefault')).not.toContain('VpcSecurityGroupIds');
    // Fail open: no default-SG prefetch (corpus replay path) → fold, no first-run FP.
    const failOpen = classifyResource(
      mk('AWS::Neptune::DBCluster', declared),
      { ...declared, VpcSecurityGroupIds: ['sg-09a4346aa4ef78d16'] },
      emptySchema
    );
    expect(tier(failOpen, 'atDefault')).toContain('VpcSecurityGroupIds');
    expect(tier(failOpen, 'undeclared')).not.toContain('VpcSecurityGroupIds');
  });

  it('TransitGateway: undeclared minted default route-table ids fold to atDefault', () => {
    const declared = {
      DefaultRouteTableAssociation: 'enable',
      DefaultRouteTablePropagation: 'enable',
    };
    const f = classifyResource(
      mk('AWS::EC2::TransitGateway', declared),
      {
        ...declared,
        AssociationDefaultRouteTableId: 'tgw-rtb-0507484a86237d0ae',
        PropagationDefaultRouteTableId: 'tgw-rtb-0507484a86237d0ae',
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('AssociationDefaultRouteTableId');
    expect(tier(f, 'atDefault')).toContain('PropagationDefaultRouteTableId');
    expect(tier(f, 'undeclared')).not.toContain('AssociationDefaultRouteTableId');
    expect(tier(f, 'undeclared')).not.toContain('PropagationDefaultRouteTableId');
  });
});

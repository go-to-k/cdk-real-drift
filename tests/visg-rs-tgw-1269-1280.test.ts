// Three more value-independent folds ESCALATED to detection-preserving gates:
//   #1269 — RedshiftServerless Workgroup SecurityGroupIds / SubnetIds (default-VPC placement echo,
//     #958) were value-independent but BOTH are OOB-mutable (`update-workgroup`). SecurityGroupIds
//     now goes through the #889/#976 single-default-SG gate; SubnetIds through a new default-VPC
//     subnet gate (fold only when EVERY live subnet is a default-VPC subnet). ConfigParameters stays
//     value-independent (#1272, needs a live per-element default).
//   #1280 — TransitGateway Association/PropagationDefaultRouteTableId were value-independent on a
//     FALSE create-only premise (`modify-transit-gateway --options` swaps them). Now cross-field
//     gated: at creation both point at the same AWS-minted default RT, so fold while equal and
//     surface a single-field OOB swap.
import { describe, expect, it } from 'vite-plus/test';
import {
  classifyResource,
  shouldFoldDefaultSgList,
  shouldFoldDefaultSubnetList,
} from '../src/diff/classify.js';
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
const mk = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId: 'phys',
  declared,
});

// ---- #1269 RedshiftServerless Workgroup SecurityGroupIds (SG gate) --------------------------
const DEFAULT_SG = 'sg-0defau1t00000000';
const ROGUE_SG = 'sg-0rogue00000000000';
const defaultSgIds = new Set([DEFAULT_SG]);

describe('#1269 RedshiftServerless::Workgroup.SecurityGroupIds derived VPC-default-SG gate', () => {
  const res = mk('AWS::RedshiftServerless::Workgroup', { WorkgroupName: 'w', NamespaceName: 'n' });
  const key = 'SecurityGroupIds';

  it('folds a single VPC-default SG (clean deploy); surfaces append + swap; fails open', () => {
    expect(
      tier(
        classifyResource(res, { [key]: [DEFAULT_SG] }, emptySchema, { defaultSgIds }),
        'atDefault'
      )
    ).toContain(key);
    expect(
      tier(
        classifyResource(res, { [key]: [DEFAULT_SG, ROGUE_SG] }, emptySchema, { defaultSgIds }),
        'undeclared'
      )
    ).toContain(key);
    expect(
      tier(
        classifyResource(res, { [key]: [ROGUE_SG] }, emptySchema, { defaultSgIds }),
        'undeclared'
      )
    ).toContain(key);
    // fail open: no prefetch → fold (no first-run FP)
    expect(
      tier(classifyResource(res, { [key]: [ROGUE_SG] }, emptySchema, {}), 'atDefault')
    ).toContain(key);
  });

  it('pure decision covers the workgroup SG path', () => {
    const t = 'AWS::RedshiftServerless::Workgroup';
    expect(shouldFoldDefaultSgList(t, key, [DEFAULT_SG], defaultSgIds)).toBe(true);
    expect(shouldFoldDefaultSgList(t, key, [ROGUE_SG], defaultSgIds)).toBe(false);
    expect(shouldFoldDefaultSgList(t, key, [ROGUE_SG], undefined)).toBe(true);
  });
});

// ---- #1269 RedshiftServerless Workgroup SubnetIds (default-VPC subnet gate) -----------------
const SUB_A = 'subnet-0defaulta0000';
const SUB_B = 'subnet-0defaultb0000';
const SUB_PUBLIC = 'subnet-0attackerpub0'; // an OOB re-placement, outside the default VPC
const defaultSubnetIds = new Set([SUB_A, SUB_B]);

describe('#1269 RedshiftServerless::Workgroup.SubnetIds default-VPC-subnet gate', () => {
  const res = mk('AWS::RedshiftServerless::Workgroup', { WorkgroupName: 'w', NamespaceName: 'n' });
  const key = 'SubnetIds';

  it('(a) folds ALL default-VPC subnets (clean deploy — every subnet is default-VPC)', () => {
    const f = classifyResource(res, { [key]: [SUB_A, SUB_B] }, emptySchema, { defaultSubnetIds });
    expect(tier(f, 'atDefault')).toContain(key);
    expect(tier(f, 'undeclared')).not.toContain(key);
  });

  it('(b) SURFACES an OOB re-placement into a non-default subnet (public subnet)', () => {
    const f = classifyResource(res, { [key]: [SUB_A, SUB_PUBLIC] }, emptySchema, {
      defaultSubnetIds,
    });
    expect(tier(f, 'undeclared')).toContain(key);
    expect(tier(f, 'atDefault')).not.toContain(key);
  });

  it('(c) FOLDS on lookup failure (defaultSubnetIds absent → fail open, no first-run FP)', () => {
    const f = classifyResource(res, { [key]: [SUB_PUBLIC] }, emptySchema, {});
    expect(tier(f, 'atDefault')).toContain(key);
    expect(tier(f, 'undeclared')).not.toContain(key);
  });

  it('pure decision: shouldFoldDefaultSubnetList folds all-default, surfaces a stray, fails open', () => {
    const t = 'AWS::RedshiftServerless::Workgroup';
    expect(shouldFoldDefaultSubnetList(t, key, [SUB_A, SUB_B], defaultSubnetIds)).toBe(true);
    expect(shouldFoldDefaultSubnetList(t, key, [SUB_A, SUB_PUBLIC], defaultSubnetIds)).toBe(false);
    expect(shouldFoldDefaultSubnetList(t, key, [SUB_PUBLIC], undefined)).toBe(true);
    expect(shouldFoldDefaultSubnetList(t, key, [SUB_PUBLIC], new Set())).toBe(true);
    // a non-gated key is not this gate's business
    expect(shouldFoldDefaultSubnetList(t, 'SecurityGroupIds', [SUB_A], defaultSubnetIds)).toBe(
      false
    );
  });
});

// ---- #1280 TransitGateway Association/PropagationDefaultRouteTableId cross-field gate --------
describe('#1280 TransitGateway default-route-table-id cross-field equality gate', () => {
  const res = mk('AWS::EC2::TransitGateway', { DefaultRouteTableAssociation: 'enable' });
  const RT_DEFAULT = 'tgw-rtb-0default00000';
  const RT_ROGUE = 'tgw-rtb-0rogue0000000';

  it('(a) folds both ids when EQUAL (clean creation — both point at the minted default RT)', () => {
    const f = classifyResource(
      res,
      { AssociationDefaultRouteTableId: RT_DEFAULT, PropagationDefaultRouteTableId: RT_DEFAULT },
      emptySchema,
      {}
    );
    expect(tier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['AssociationDefaultRouteTableId', 'PropagationDefaultRouteTableId'])
    );
    expect(tier(f, 'undeclared')).not.toContain('AssociationDefaultRouteTableId');
  });

  it('(b) SURFACES both ids when they DIFFER (single-field OOB swap re-segments attachments)', () => {
    const f = classifyResource(
      res,
      { AssociationDefaultRouteTableId: RT_ROGUE, PropagationDefaultRouteTableId: RT_DEFAULT },
      emptySchema,
      {}
    );
    expect(tier(f, 'undeclared')).toEqual(
      expect.arrayContaining(['AssociationDefaultRouteTableId', 'PropagationDefaultRouteTableId'])
    );
  });

  it('(c) folds a LONE id fail-safe (one of association/propagation disabled → no sibling to cross-check)', () => {
    const f = classifyResource(
      res,
      { AssociationDefaultRouteTableId: RT_DEFAULT },
      emptySchema,
      {}
    );
    expect(tier(f, 'atDefault')).toContain('AssociationDefaultRouteTableId');
    expect(tier(f, 'undeclared')).not.toContain('AssociationDefaultRouteTableId');
  });
});

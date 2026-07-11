// #1498: a Subnet whose IPv6 CIDR is assigned by a separate sibling AWS::EC2::SubnetCidrBlock (the
// normal dual-stack CDK shape) echoes an undeclared Ipv6CidrBlock/Ipv6CidrBlocks on its OWN live
// model — a first-run [Potential Drift] fold gap. The clean fold is SIBLING-GATED: drop the echo
// only when a SubnetCidrBlock sibling targets THIS subnet; an out-of-band associate-subnet-cidr-block
// on a subnet with NO sibling still surfaces (a silently-opened IPv6 surface). Mirrors the #892
// siblingEipAssociations reflection drop. Live-repro'd 2026-07-12 (us-east-1, vpc-attach-min).
import { describe, expect, it } from 'vite-plus/test';
import { buildSiblingSubnetCidrBlocks } from '../src/commands/gather.js';
import type { Desired } from '../src/desired/template-adapter.js';
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

const SUBNET_PHYS = 'subnet-00c26f3fb4ea65291';
const IPV6 = '2600:1f18:2de0:6e00::/64';
const subnet: DesiredResource = {
  logicalId: 'PublicSubnet1',
  resourceType: 'AWS::EC2::Subnet',
  physicalId: SUBNET_PHYS,
  declared: { CidrBlock: '10.0.0.0/24', VpcId: 'vpc-1' },
};
const tierOf = (findings: Finding[], path: string) => findings.find((f) => f.path === path)?.tier;

describe('#1498 buildSiblingSubnetCidrBlocks', () => {
  it('marks a subnet targeted by a resolved physical SubnetId', () => {
    const desired: Desired = {
      resources: [
        subnet,
        {
          logicalId: 'HuntSubnetIpv6',
          resourceType: 'AWS::EC2::SubnetCidrBlock',
          declared: { SubnetId: SUBNET_PHYS, Ipv6CidrBlock: IPV6 },
        },
      ],
    } as unknown as Desired;
    const set = buildSiblingSubnetCidrBlocks(desired);
    expect(set.has(SUBNET_PHYS)).toBe(true);
  });

  it('marks a subnet targeted by an unresolved {Ref} (both logical + physical identities)', () => {
    const desired: Desired = {
      resources: [
        subnet,
        {
          logicalId: 'Cidr',
          resourceType: 'AWS::EC2::SubnetCidrBlock',
          declared: { SubnetId: { Ref: 'PublicSubnet1' }, Ipv6CidrBlock: IPV6 },
        },
      ],
    } as unknown as Desired;
    const set = buildSiblingSubnetCidrBlocks(desired);
    expect(set.has('PublicSubnet1')).toBe(true);
    expect(set.has(SUBNET_PHYS)).toBe(true);
  });

  it('does not mark a subnet with no SubnetCidrBlock sibling', () => {
    const desired: Desired = { resources: [subnet] } as unknown as Desired;
    expect(buildSiblingSubnetCidrBlocks(desired).size).toBe(0);
  });
});

describe('#1498 Subnet Ipv6CidrBlock sibling-gated echo drop', () => {
  const live = {
    CidrBlock: '10.0.0.0/24',
    VpcId: 'vpc-1',
    Ipv6CidrBlock: IPV6,
    Ipv6CidrBlocks: [IPV6],
  };

  it('drops the reflected Ipv6CidrBlock/Ipv6CidrBlocks when a sibling targets the subnet', () => {
    const f = classifyResource(subnet, structuredClone(live), emptySchema, {
      siblingSubnetCidrBlocks: new Set([SUBNET_PHYS]),
    });
    expect(tierOf(f, 'Ipv6CidrBlock')).toBeUndefined();
    expect(tierOf(f, 'Ipv6CidrBlocks')).toBeUndefined();
  });

  it('SURFACES the undeclared Ipv6CidrBlock when NO sibling explains it (OOB associate-subnet-cidr-block)', () => {
    const f = classifyResource(subnet, structuredClone(live), emptySchema, {
      siblingSubnetCidrBlocks: new Set(),
    });
    expect(tierOf(f, 'Ipv6CidrBlock')).toBe('undeclared');
  });

  it('matches on the subnet logicalId too (unresolved-Ref sibling)', () => {
    const f = classifyResource(subnet, structuredClone(live), emptySchema, {
      siblingSubnetCidrBlocks: new Set(['PublicSubnet1']),
    });
    expect(tierOf(f, 'Ipv6CidrBlock')).toBeUndefined();
  });

  it('KEEPS a self-declared Ipv6CidrBlock (compared in the declared loop, not dropped from live)', () => {
    const selfDeclared: DesiredResource = {
      ...subnet,
      declared: { ...subnet.declared, Ipv6CidrBlock: IPV6 },
    };
    const f = classifyResource(selfDeclared, structuredClone(live), emptySchema, {
      siblingSubnetCidrBlocks: new Set([SUBNET_PHYS]),
    });
    // Declared == live → no drift finding, but it was NOT dropped as a sibling echo (it is intent).
    expect(tierOf(f, 'Ipv6CidrBlock')).toBeUndefined();
    // A DIVERGENT self-declared value still surfaces as declared drift.
    const g = classifyResource(
      selfDeclared,
      { ...structuredClone(live), Ipv6CidrBlock: '2600:1f18:dead:beef::/64' },
      emptySchema,
      { siblingSubnetCidrBlocks: new Set([SUBNET_PHYS]) }
    );
    expect(tierOf(g, 'Ipv6CidrBlock')).toBe('declared');
  });
});

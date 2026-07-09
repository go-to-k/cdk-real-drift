// #888: an AWS::EC2::SecurityGroup that declares no GroupName reads back its CloudFormation-
// minted physical name (`<stackName>-<logicalId>-<random>`) — pure AWS-assigned identity the
// template never declared. On a clean, un-mutated deploy that must fold to zero [Potential
// Drift] (the core invariant), not surface as undeclared drift. The same holds for the sibling
// SecurityGroupIngress.SourceSecurityGroupName / SecurityGroupEgress.DestinationSecurityGroupName
// echoes of a peer group's generated name. Every fold below still lets a genuine divergence
// surface (a user-set literal GroupName is compared in the declared loop, so an undeclared user
// name still shows).
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

// A path surfaces as [Potential Drift] iff it lands in a NON-folded tier (undeclared / declared).
const isFolded = (findings: Finding[], path: string) =>
  !findings.some((f) => f.path === path && (f.tier === 'undeclared' || f.tier === 'declared'));

describe('#888 SecurityGroup GroupName folds the CFn-generated physical name', () => {
  const res: DesiredResource = {
    logicalId: 'ClusterSecurityGroup0921994B',
    resourceType: 'AWS::EC2::SecurityGroup',
    physicalId: 'sg-0123456789abcdef0',
    constructPath: 'Cdkrd717Verify/ClusterSecurityGroup0921994B/Resource',
    declared: { GroupDescription: 'db access' },
  };

  it('folds an undeclared <stackName>-<logicalId>-<random> GroupName (no first-run noise)', () => {
    const f = classifyResource(
      res,
      {
        GroupDescription: 'db access',
        GroupName: 'Cdkrd717Verify-ClusterSecurityGroup0921994B-h8SACJTYF1Ti',
      },
      emptySchema
    );
    expect(isFolded(f, 'GroupName')).toBe(true);
    expect(pathsByTier(f, 'undeclared')).not.toContain('GroupName');
  });

  it('folds even when constructPath is undefined (implicit SG lost aws:cdk:path — the live #888 case)', () => {
    // An RDS cluster's / DBProxy's auto-created SG loses its construct path in the deployed
    // template, so the stack name cannot be derived — the fold must anchor on the logicalId,
    // which is the segment before CFn's random suffix. Fails on main (surfaces as undeclared).
    const { constructPath: _drop, ...noPath } = res;
    const f = classifyResource(
      noPath,
      {
        GroupDescription: 'db access',
        GroupName: 'Cdkrd717Verify-ClusterSecurityGroup0921994B-h8SACJTYF1Ti',
      },
      emptySchema
    );
    expect(isFolded(f, 'GroupName')).toBe(true);
    expect(pathsByTier(f, 'undeclared')).not.toContain('GroupName');
  });

  it('still surfaces a user-set literal GroupName that does not match the pattern', () => {
    const f = classifyResource(
      res,
      { GroupDescription: 'db access', GroupName: 'my-custom-sg' },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toContain('GroupName');
  });

  it('still surfaces a user literal even with no constructPath (fold stays value-dependent)', () => {
    const { constructPath: _drop, ...noPath } = res;
    const f = classifyResource(
      noPath,
      { GroupDescription: 'db access', GroupName: 'my-custom-sg' },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toContain('GroupName');
  });
});

describe('#888 SecurityGroupIngress.SourceSecurityGroupName echo folds', () => {
  const res: DesiredResource = {
    logicalId: 'IndirectPort',
    resourceType: 'AWS::EC2::SecurityGroupIngress',
    physicalId: 'sgr-abc',
    constructPath: 'Cdkrd717Verify/IndirectPort/Resource',
    declared: { GroupId: 'sg-1', IpProtocol: 'tcp', SourceSecurityGroupId: 'sg-2' },
  };

  it('folds the derived peer-group name (no first-run noise)', () => {
    const f = classifyResource(
      res,
      {
        GroupId: 'sg-1',
        IpProtocol: 'tcp',
        SourceSecurityGroupId: 'sg-2',
        SourceSecurityGroupName: 'Cdkrd717Verify-ProxyProxySecurityGroupC42FC3CE-XWeDSyAblhvp',
      },
      emptySchema
    );
    expect(isFolded(f, 'SourceSecurityGroupName')).toBe(true);
    expect(pathsByTier(f, 'undeclared')).not.toContain('SourceSecurityGroupName');
  });
});

describe('#888 SecurityGroupEgress.DestinationSecurityGroupName echo folds', () => {
  const mk = (constructPath: string): DesiredResource => ({
    logicalId: 'EgRule',
    resourceType: 'AWS::EC2::SecurityGroupEgress',
    physicalId: 'sgr-def',
    constructPath,
    declared: { GroupId: 'sg-1', IpProtocol: 'tcp', DestinationSecurityGroupId: 'sg-2' },
  });

  it('folds a same-stack derived peer-group name', () => {
    const f = classifyResource(
      mk('Cdkrd717Verify/EgRule/Resource'),
      {
        GroupId: 'sg-1',
        IpProtocol: 'tcp',
        DestinationSecurityGroupId: 'sg-2',
        DestinationSecurityGroupName: 'Cdkrd717Verify-PeerSecurityGroupC42FC3CE-XWeDSyAblhvp',
      },
      emptySchema
    );
    expect(isFolded(f, 'DestinationSecurityGroupName')).toBe(true);
    expect(pathsByTier(f, 'undeclared')).not.toContain('DestinationSecurityGroupName');
  });

  // The value-independent fold must catch a CROSS-STACK peer name too — its `<otherStack>-`
  // prefix means isCfnGeneratedName (which keys on THIS resource's stack prefix) misses it.
  // This is the case the wrong `SourceSecurityGroupName` key left surfacing before #888.
  it('folds a cross-stack derived peer-group name (isCfnGeneratedName cannot reach it)', () => {
    const f = classifyResource(
      mk('ThisStack/EgRule/Resource'),
      {
        GroupId: 'sg-1',
        IpProtocol: 'tcp',
        DestinationSecurityGroupId: 'sg-2',
        DestinationSecurityGroupName: 'OtherStack-PeerSecurityGroupABC-XWeDSyAblhvp',
      },
      emptySchema
    );
    expect(isFolded(f, 'DestinationSecurityGroupName')).toBe(true);
    expect(pathsByTier(f, 'undeclared')).not.toContain('DestinationSecurityGroupName');
  });
});

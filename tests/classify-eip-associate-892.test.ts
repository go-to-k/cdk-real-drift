import { describe, expect, it } from 'vite-plus/test';
import { buildSiblingEipAssociations } from '../src/commands/gather.js';
import type { Desired } from '../src/desired/template-adapter.js';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// #892 (SECURITY FN): AWS::EC2::EIP `NetworkInterfaceId` was folded VALUE-INDEPENDENT, so an
// out-of-band `ec2 associate-address` — hijacking an allocated static IP (allowlisted /
// reputation-bearing) onto an arbitrary ENI — was INVISIBLE. The blanket fold is replaced with a
// TIER-2 sibling-derived gate: a live association DECLARED by a sibling AWS::EC2::EIPAssociation
// (or an AWS::EC2::NatGateway consuming the EIP) FOLDS; an association with NO declaring sibling
// SURFACES as [Potential Drift]. The sibling identities are built by gather.buildSiblingEipAssociations
// and consumed in classify via opts.siblingEipAssociations.

const eipSchema: SchemaInfo = {
  readOnly: new Set(['AllocationId', 'PublicIp']),
  writeOnly: new Set(['Address', 'IpamPoolId', 'TransferAddress']),
  createOnly: new Set(['Address', 'IpamPoolId', 'NetworkBorderGroup', 'TransferAddress']),
  readOnlyPaths: ['AllocationId', 'PublicIp'],
  writeOnlyPaths: ['Address', 'IpamPoolId', 'TransferAddress'],
  createOnlyPaths: ['Address', 'IpamPoolId', 'NetworkBorderGroup', 'TransferAddress'],
  defaults: {},
  defaultPaths: {},
};

const eipResource: DesiredResource = {
  logicalId: 'Ip',
  resourceType: 'AWS::EC2::EIP',
  physicalId: '52.4.97.166',
  declared: { Domain: 'vpc' },
};

// An EIP associated with an ENI: the live model carries the reflected NetworkInterfaceId.
const associatedLive = (): Record<string, unknown> => ({
  Domain: 'vpc',
  NetworkBorderGroup: 'us-east-1',
  PublicIp: '52.4.97.166',
  NetworkInterfaceId: 'eni-0f1c51db64ee88129',
});

const niiFindings = (findings: Finding[], tier: string) =>
  findings.filter((f) => f.tier === tier && f.path === 'NetworkInterfaceId');

describe('#892 EIP NetworkInterfaceId sibling-derived association gate', () => {
  it('(map) buildSiblingEipAssociations marks an EIP referenced by a declared EIPAssociation', () => {
    const desired: Desired = {
      resources: [
        eipResource,
        {
          logicalId: 'Assoc',
          resourceType: 'AWS::EC2::EIPAssociation',
          declared: {
            AllocationId: { 'Fn::GetAtt': ['Ip', 'AllocationId'] },
            NetworkInterfaceId: 'eni-0f1c51db64ee88129',
          },
        },
      ],
    } as unknown as Desired;
    const map = buildSiblingEipAssociations(desired);
    // Keyed by BOTH the EIP's logicalId and its physicalId (== PublicIp).
    expect(map.has('Ip')).toBe(true);
    expect(map.has('52.4.97.166')).toBe(true);
  });

  it('(map) buildSiblingEipAssociations marks an EIP consumed by a NAT gateway', () => {
    const desired: Desired = {
      resources: [
        eipResource,
        {
          logicalId: 'Nat',
          resourceType: 'AWS::EC2::NatGateway',
          declared: {
            AllocationId: { 'Fn::GetAtt': ['Ip', 'AllocationId'] },
            SubnetId: 'subnet-abc',
          },
        },
      ],
    } as unknown as Desired;
    const map = buildSiblingEipAssociations(desired);
    expect(map.has('Ip')).toBe(true);
    expect(map.has('52.4.97.166')).toBe(true);
  });

  it('(map) an EIP with NO declaring sibling is not marked', () => {
    const desired: Desired = {
      resources: [eipResource],
    } as unknown as Desired;
    const map = buildSiblingEipAssociations(desired);
    expect(map.has('Ip')).toBe(false);
    expect(map.has('52.4.97.166')).toBe(false);
  });

  it('(1) a sibling-explained association FOLDS (no NetworkInterfaceId drift)', () => {
    // A declared EIPAssociation / NAT gateway explains the binding → the reflected id is dropped.
    const siblingEipAssociations = new Set(['Ip', '52.4.97.166']);
    const findings = classifyResource(eipResource, associatedLive(), eipSchema, {
      siblingEipAssociations,
    });
    expect(findings.some((f) => f.path === 'NetworkInterfaceId')).toBe(false);
    expect(niiFindings(findings, 'undeclared')).toEqual([]);
    expect(niiFindings(findings, 'atDefault')).toEqual([]);
  });

  it('(2) a sibling-LESS association SURFACES (the OOB associate-address hijack)', () => {
    // No declaring sibling → the live NetworkInterfaceId is an out-of-band hijack and must surface.
    const findings = classifyResource(eipResource, associatedLive(), eipSchema, {
      siblingEipAssociations: new Set<string>(),
    });
    const surfaced = niiFindings(findings, 'undeclared');
    expect(surfaced.length).toBe(1);
    expect(surfaced[0]?.actual).toBe('eni-0f1c51db64ee88129');
  });

  it('(2b) with NO sibling map at all → the association still SURFACES (fail-open to visible)', () => {
    const findings = classifyResource(eipResource, associatedLive(), eipSchema);
    expect(niiFindings(findings, 'undeclared').length).toBe(1);
  });

  it('(3) an unassociated EIP has no NetworkInterfaceId, so nothing surfaces regardless', () => {
    const live: Record<string, unknown> = {
      Domain: 'vpc',
      NetworkBorderGroup: 'us-east-1',
      PublicIp: '52.4.97.166',
    };
    const findings = classifyResource(eipResource, live, eipSchema, {
      siblingEipAssociations: new Set<string>(),
    });
    expect(findings.some((f) => f.path === 'NetworkInterfaceId')).toBe(false);
  });

  // #1261 (self-declared-target FN): #892's sibling gate misses the classic
  // `new ec2.CfnEIP({ instanceId })` (or a declared NetworkInterfaceId) that binds the address on
  // the EIP itself — NO sibling EIPAssociation / NatGateway exists, yet AWS reflects the target's
  // primary ENI onto the live NetworkInterfaceId, so the empty sibling set surfaced it as a
  // first-run FALSE POSITIVE (these EIPs folded pre-#892). The EIP's OWN declared InstanceId /
  // NetworkInterfaceId is a self-explained association → fold.
  it('(4) a self-declared InstanceId FOLDS the reflected NetworkInterfaceId (no sibling)', () => {
    const eipWithInstance: DesiredResource = {
      logicalId: 'Ip',
      resourceType: 'AWS::EC2::EIP',
      physicalId: '52.4.97.166',
      declared: { Domain: 'vpc', InstanceId: 'i-0abc123def456789a' },
    };
    const findings = classifyResource(eipWithInstance, associatedLive(), eipSchema, {
      siblingEipAssociations: new Set<string>(),
    });
    expect(findings.some((f) => f.path === 'NetworkInterfaceId')).toBe(false);
    expect(niiFindings(findings, 'undeclared')).toEqual([]);
    expect(niiFindings(findings, 'atDefault')).toEqual([]);
  });

  it('(4b) a self-declared NetworkInterfaceId FOLDS the reflected NetworkInterfaceId (no sibling)', () => {
    const eipWithEni: DesiredResource = {
      logicalId: 'Ip',
      resourceType: 'AWS::EC2::EIP',
      physicalId: '52.4.97.166',
      declared: { Domain: 'vpc', NetworkInterfaceId: 'eni-0f1c51db64ee88129' },
    };
    const findings = classifyResource(eipWithEni, associatedLive(), eipSchema, {
      siblingEipAssociations: new Set<string>(),
    });
    // Declared == live here, so it must not surface as undeclared drift either.
    expect(niiFindings(findings, 'undeclared')).toEqual([]);
    expect(niiFindings(findings, 'atDefault')).toEqual([]);
  });

  it('(4c) CONTROL: no self-declared target and no sibling → NetworkInterfaceId still SURFACES', () => {
    // Unchanged #892 behavior: an association neither a sibling nor the EIP itself declares is a
    // genuine out-of-band hijack and must remain visible.
    const findings = classifyResource(eipResource, associatedLive(), eipSchema, {
      siblingEipAssociations: new Set<string>(),
    });
    const surfaced = niiFindings(findings, 'undeclared');
    expect(surfaced.length).toBe(1);
    expect(surfaced[0]?.actual).toBe('eni-0f1c51db64ee88129');
  });
});

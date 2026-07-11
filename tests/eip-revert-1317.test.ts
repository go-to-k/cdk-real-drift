import { DescribeAddressesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { resolveEc2EipCcIdentifier } from '../src/read/overrides.js';
import { CC_IDENTIFIER_ADAPTERS } from '../src/read/router.js';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

const ec2 = mockClient(EC2Client);

beforeEach(() => {
  ec2.reset();
});

// #1317: AWS::EC2::EIP is FULLY_MUTABLE in Cloud Control but its primaryIdentifier is the
// composite [PublicIp, AllocationId] (verified live). The CFn physical id is only one half, so
// the revert path resolves the composite via DescribeAddresses.
describe('resolveEc2EipCcIdentifier (#1317)', () => {
  it('builds <PublicIp>|<AllocationId> for a VPC EIP, looked up by AllocationIds', async () => {
    ec2.on(DescribeAddressesCommand).resolves({
      Addresses: [{ AllocationId: 'eipalloc-123', PublicIp: '52.0.0.1', Domain: 'vpc' }],
    });
    expect(await resolveEc2EipCcIdentifier('eipalloc-123', 'us-east-1')).toBe(
      '52.0.0.1|eipalloc-123'
    );
    expect(ec2.commandCalls(DescribeAddressesCommand)[0]!.args[0].input).toEqual({
      AllocationIds: ['eipalloc-123'],
    });
  });

  it('looks up by PublicIps when the physical id is a public ip (not an allocation id)', async () => {
    ec2.on(DescribeAddressesCommand).resolves({
      Addresses: [{ AllocationId: 'eipalloc-9', PublicIp: '52.0.0.9' }],
    });
    expect(await resolveEc2EipCcIdentifier('52.0.0.9', 'us-east-1')).toBe('52.0.0.9|eipalloc-9');
    expect(ec2.commandCalls(DescribeAddressesCommand)[0]!.args[0].input).toEqual({
      PublicIps: ['52.0.0.9'],
    });
  });

  it('returns undefined when the address has no AllocationId (cannot form the composite)', async () => {
    ec2.on(DescribeAddressesCommand).resolves({ Addresses: [{ PublicIp: '52.0.0.2' }] });
    expect(await resolveEc2EipCcIdentifier('52.0.0.2', 'us-east-1')).toBeUndefined();
  });

  it('returns undefined when the address is not found (released out of band)', async () => {
    ec2.on(DescribeAddressesCommand).resolves({ Addresses: [] });
    expect(await resolveEc2EipCcIdentifier('eipalloc-gone', 'us-east-1')).toBeUndefined();
  });

  it('swallows a DescribeAddresses error to undefined (never throws into the revert loop)', async () => {
    ec2.on(DescribeAddressesCommand).rejects(new Error('InvalidAllocationID.NotFound'));
    expect(await resolveEc2EipCcIdentifier('eipalloc-x', 'us-east-1')).toBeUndefined();
  });

  it('returns undefined without an SDK call when region is empty', async () => {
    expect(await resolveEc2EipCcIdentifier('eipalloc-1', '')).toBeUndefined();
    expect(ec2.commandCalls(DescribeAddressesCommand)).toHaveLength(0);
  });

  it('is wired as the CC identifier adapter for AWS::EC2::EIP', async () => {
    ec2.on(DescribeAddressesCommand).resolves({
      Addresses: [{ AllocationId: 'eipalloc-77', PublicIp: '1.2.3.4' }],
    });
    expect(await CC_IDENTIFIER_ADAPTERS['AWS::EC2::EIP']!('eipalloc-77', {}, 'us-east-1')).toBe(
      '1.2.3.4|eipalloc-77'
    );
  });
});

describe('buildRevertPlan — AWS::EC2::EIP is revertable (#1317)', () => {
  const eipTagFinding = (): Finding => ({
    tier: 'declared',
    logicalId: 'MyEip',
    physicalId: 'eipalloc-abc',
    resourceType: 'AWS::EC2::EIP',
    path: 'Tags.0.Value',
    desired: 'prod',
    actual: 'hacked-out-of-band',
  });

  it('routes an out-of-band EIP Tags drift to a CC revert item, not the "type not revertable yet" bar', () => {
    const plan = buildRevertPlan([eipTagFinding()], undefined);
    // Before #1317 the read-override + no-writer combination barred EIP as "type not revertable yet".
    expect(plan.notRevertable.some((n) => n.reason.includes('not revertable'))).toBe(false);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('cc');
    expect(plan.items[0]!.resourceType).toBe('AWS::EC2::EIP');
  });
});

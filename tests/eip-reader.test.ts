import { DescribeAddressesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { SDK_OVERRIDES } from '../src/read/overrides.js';

const ec2 = mockClient(EC2Client);

const ctx = (physicalId: string, region = 'us-east-1', accountId = '123456789012') => ({
  physicalId,
  declared: {},
  region,
  accountId,
});

beforeEach(() => {
  ec2.reset();
});

describe('AWS::EC2::EIP SDK override', () => {
  it('reads a VPC EIP by allocation id and maps Tags to {Key,Value}[]', async () => {
    ec2.on(DescribeAddressesCommand).resolves({
      Addresses: [
        {
          AllocationId: 'eipalloc-123',
          Domain: 'vpc',
          NetworkBorderGroup: 'us-east-1',
          PublicIp: '52.0.0.1',
          InstanceId: 'i-abc',
          Tags: [{ Key: 'Name', Value: 'my-eip' }],
        },
      ],
    });
    const out = await SDK_OVERRIDES['AWS::EC2::EIP'](ctx('eipalloc-123'));
    expect(out).toEqual({
      Domain: 'vpc',
      NetworkBorderGroup: 'us-east-1',
      PublicIp: '52.0.0.1',
      InstanceId: 'i-abc',
      Tags: [{ Key: 'Name', Value: 'my-eip' }],
    });
    // looked up by AllocationIds, not PublicIps
    const call = ec2.commandCalls(DescribeAddressesCommand)[0];
    expect(call.args[0].input).toEqual({ AllocationIds: ['eipalloc-123'] });
  });

  it('does NOT project NetworkInterfaceId (not a declarable EIP property) and DOES project PublicIpv4Pool (WAVE22)', async () => {
    ec2.on(DescribeAddressesCommand).resolves({
      Addresses: [
        {
          AllocationId: 'eipalloc-assoc',
          Domain: 'vpc',
          PublicIp: '52.0.0.9',
          InstanceId: 'i-xyz',
          NetworkInterfaceId: 'eni-deadbeef', // AWS returns this for an associated EIP — must NOT surface
          PublicIpv4Pool: 'ipv4pool-ec2-abc', // a declarable property — must surface
        },
      ],
    });
    const out = await SDK_OVERRIDES['AWS::EC2::EIP'](ctx('eipalloc-assoc'));
    // NetworkInterfaceId would have false-flagged an undeclared drift on every associated EIP
    expect(out).not.toHaveProperty('NetworkInterfaceId');
    expect(out).toMatchObject({ InstanceId: 'i-xyz', PublicIpv4Pool: 'ipv4pool-ec2-abc' });
  });

  it('reads a classic EIP by public IP when physical id is not an alloc id', async () => {
    ec2.on(DescribeAddressesCommand).resolves({
      Addresses: [{ Domain: 'standard', PublicIp: '52.0.0.2' }],
    });
    const out = await SDK_OVERRIDES['AWS::EC2::EIP'](ctx('52.0.0.2'));
    expect(out).toEqual({ Domain: 'standard', PublicIp: '52.0.0.2' });
    const call = ec2.commandCalls(DescribeAddressesCommand)[0];
    expect(call.args[0].input).toEqual({ PublicIps: ['52.0.0.2'] });
  });

  it('returns undefined when no addresses are returned (not resolvable -> skipped)', async () => {
    ec2.on(DescribeAddressesCommand).resolves({ Addresses: [] });
    expect(await SDK_OVERRIDES['AWS::EC2::EIP'](ctx('eipalloc-missing'))).toBeUndefined();
  });

  it('propagates the NotFound error (router maps it to deleted, not a silent {})', async () => {
    const err = Object.assign(new Error('not found'), { name: 'InvalidAllocationID.NotFound' });
    ec2.on(DescribeAddressesCommand).rejects(err);
    await expect(SDK_OVERRIDES['AWS::EC2::EIP'](ctx('eipalloc-gone'))).rejects.toThrow('not found');
  });

  it('omits Tags when AWS returns none', async () => {
    ec2.on(DescribeAddressesCommand).resolves({
      Addresses: [{ Domain: 'vpc', PublicIp: '52.0.0.3', Tags: [] }],
    });
    const out = await SDK_OVERRIDES['AWS::EC2::EIP'](ctx('eipalloc-notags'));
    expect(out).toEqual({ Domain: 'vpc', PublicIp: '52.0.0.3' });
  });

  it('returns undefined when physical id is empty', async () => {
    expect(await SDK_OVERRIDES['AWS::EC2::EIP'](ctx(''))).toBeUndefined();
  });
});

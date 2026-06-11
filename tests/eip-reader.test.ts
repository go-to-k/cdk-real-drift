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

  it('reads a classic EIP by public IP when physical id is not an alloc id', async () => {
    ec2.on(DescribeAddressesCommand).resolves({
      Addresses: [{ Domain: 'standard', PublicIp: '52.0.0.2' }],
    });
    const out = await SDK_OVERRIDES['AWS::EC2::EIP'](ctx('52.0.0.2'));
    expect(out).toEqual({ Domain: 'standard', PublicIp: '52.0.0.2' });
    const call = ec2.commandCalls(DescribeAddressesCommand)[0];
    expect(call.args[0].input).toEqual({ PublicIps: ['52.0.0.2'] });
  });

  it('returns {} when no addresses are returned (read gap, not crash)', async () => {
    ec2.on(DescribeAddressesCommand).resolves({ Addresses: [] });
    expect(await SDK_OVERRIDES['AWS::EC2::EIP'](ctx('eipalloc-missing'))).toEqual({});
  });

  it('returns {} when DescribeAddresses throws NotFound', async () => {
    ec2
      .on(DescribeAddressesCommand)
      .rejects(Object.assign(new Error('not found'), { name: 'InvalidAllocationID.NotFound' }));
    expect(await SDK_OVERRIDES['AWS::EC2::EIP'](ctx('eipalloc-gone'))).toEqual({});
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

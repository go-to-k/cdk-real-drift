import {
  DescribeEndpointConfigCommand,
  ListTagsCommand as SageMakerListTagsCommand,
  SageMakerClient,
} from '@aws-sdk/client-sagemaker';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { SDK_OVERRIDES } from '../src/read/overrides.js';

// #1527 — the AWS::SageMaker::EndpointConfig SDK override passed the CFn physical id VERBATIM
// as EndpointConfigName to DescribeEndpointConfig, but the CFn PhysicalResourceId is the ARN
// (arn:…:endpoint-config/<name>), so the describe call ValidationExceptioned and the whole
// resource silently skipped — the reader never worked for a CFn-created config (the exact #857
// read gap it was added to close). Live-confirmed 2026-07-12 (sagemaker-epc-min: skipped=1,
// "SDK override (AWS::SageMaker::EndpointConfig): ValidationException 1"). The fix mirrors the
// readSageMakerMonitoringSchedule (#1523) shape: extract the last ARN segment; a non-ARN
// physical id (or the declared-name fallback) passes through unchanged.

const sagemaker = mockClient(SageMakerClient);
const read = SDK_OVERRIDES['AWS::SageMaker::EndpointConfig']!;
const ARN = 'arn:aws:sagemaker:us-east-1:123456789012:endpoint-config/hunt-epc';
const ctx = (physicalId: string, declared: Record<string, unknown> = {}) => ({
  physicalId,
  declared,
  region: 'us-east-1',
  accountId: '123456789012',
});

const RESPONSE = {
  EndpointConfigName: 'hunt-epc',
  EndpointConfigArn: ARN,
  ProductionVariants: [
    {
      VariantName: 'AllTraffic',
      ModelName: 'hunt-model',
      InitialInstanceCount: 1,
      InstanceType: 'ml.t2.medium' as const,
      InitialVariantWeight: 1,
    },
  ],
  CreationTime: new Date(0),
};

beforeEach(() => {
  sagemaker.reset();
  sagemaker.on(SageMakerListTagsCommand).resolves({ Tags: [] });
});

describe('SageMaker EndpointConfig override ARN physical id (#1527)', () => {
  it('extracts the bare name from an ARN physical id before DescribeEndpointConfig', async () => {
    sagemaker.on(DescribeEndpointConfigCommand).resolves(RESPONSE);

    const model = await read(ctx(ARN));

    const call = sagemaker.commandCalls(DescribeEndpointConfigCommand)[0]!;
    expect((call.args[0].input as { EndpointConfigName?: string }).EndpointConfigName).toBe(
      'hunt-epc'
    );
    expect(model).toMatchObject({
      EndpointConfigName: 'hunt-epc',
      ProductionVariants: [
        {
          VariantName: 'AllTraffic',
          ModelName: 'hunt-model',
          InitialInstanceCount: 1,
          InstanceType: 'ml.t2.medium',
          InitialVariantWeight: 1,
        },
      ],
    });
    // readOnly response fields stay dropped
    expect(model).not.toHaveProperty('EndpointConfigArn');
    expect(model).not.toHaveProperty('CreationTime');
  });

  it('passes a bare-name physical id through unchanged', async () => {
    sagemaker.on(DescribeEndpointConfigCommand).resolves(RESPONSE);

    await read(ctx('hunt-epc'));

    const call = sagemaker.commandCalls(DescribeEndpointConfigCommand)[0]!;
    expect((call.args[0].input as { EndpointConfigName?: string }).EndpointConfigName).toBe(
      'hunt-epc'
    );
  });

  it('falls back to the declared EndpointConfigName when the physical id is empty', async () => {
    sagemaker.on(DescribeEndpointConfigCommand).resolves(RESPONSE);

    await read(ctx('', { EndpointConfigName: 'hunt-epc' }));

    const call = sagemaker.commandCalls(DescribeEndpointConfigCommand)[0]!;
    expect((call.args[0].input as { EndpointConfigName?: string }).EndpointConfigName).toBe(
      'hunt-epc'
    );
  });
});

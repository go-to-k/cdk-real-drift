import { DescribeEndpointConfigCommand, SageMakerClient } from '@aws-sdk/client-sagemaker';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { ResourceGoneError } from '../src/aws-errors.js';
import { SDK_OVERRIDES } from '../src/read/overrides.js';

// #857 (SageMaker half) — AWS::SageMaker::EndpointConfig has NO Cloud Control read handler
// (registry describe-type -> `handlers: []`), so it was silently `skipped` on every check and a
// production variant's instance sizing / DataCaptureConfig / KMS-key / network posture went
// unwatched. This exercises the SDK_OVERRIDES reader that reads it back via
// sagemaker:DescribeEndpointConfig and maps the response to the CFn EndpointConfig shape,
// dropping the AWS-managed readOnly response fields (EndpointConfigArn / CreationTime) and the
// non-schema variant fields (AcceleratorType / CoreDumpConfig).

const sagemaker = mockClient(SageMakerClient);

const ctx = (declared: Record<string, unknown>, physicalId = '', accountId = '123456789012') => ({
  physicalId,
  declared,
  region: 'us-east-1',
  accountId,
});

const read = SDK_OVERRIDES['AWS::SageMaker::EndpointConfig'];

beforeEach(() => {
  sagemaker.reset();
});

describe('SageMaker EndpointConfig (#857)', () => {
  it('maps ProductionVariants + DataCaptureConfig + KmsKeyId; drops readonly (Arn/CreationTime) + non-schema variant fields', async () => {
    sagemaker.on(DescribeEndpointConfigCommand).resolves({
      EndpointConfigName: 'ec-full',
      // AWS-managed readOnly response fields that must NOT appear in the projection:
      EndpointConfigArn: 'arn:aws:sagemaker:us-east-1:123456789012:endpoint-config/ec-full',
      CreationTime: new Date(0),
      ProductionVariants: [
        {
          VariantName: 'variant-1',
          ModelName: 'my-model',
          InitialInstanceCount: 2,
          InstanceType: 'ml.m5.large',
          InitialVariantWeight: 1,
          VolumeSizeInGB: 50,
          ModelDataDownloadTimeoutInSeconds: 600,
          ContainerStartupHealthCheckTimeoutInSeconds: 300,
          EnableSSMAccess: true,
          ServerlessConfig: { MaxConcurrency: 10, MemorySizeInMB: 2048, ProvisionedConcurrency: 5 },
          ManagedInstanceScaling: {
            Status: 'ENABLED',
            MinInstanceCount: 1,
            MaxInstanceCount: 4,
          },
          RoutingConfig: { RoutingStrategy: 'LEAST_OUTSTANDING_REQUESTS' },
          // Fields NOT in the CFn ProductionVariant schema — must be dropped:
          AcceleratorType: 'ml.eia2.medium',
          CoreDumpConfig: { DestinationS3Uri: 's3://bucket/dumps' },
        },
      ],
      DataCaptureConfig: {
        EnableCapture: true,
        InitialSamplingPercentage: 100,
        DestinationS3Uri: 's3://bucket/capture',
        KmsKeyId: 'arn:aws:kms:...:key/dc',
        CaptureOptions: [{ CaptureMode: 'Input' }, { CaptureMode: 'Output' }],
        CaptureContentTypeHeader: { CsvContentTypes: ['text/csv'] },
      },
      KmsKeyId: 'arn:aws:kms:...:key/ec',
    });

    const out = await read(ctx({ EndpointConfigName: 'ec-full' }, 'ec-full'));
    expect(out).toEqual({
      EndpointConfigName: 'ec-full',
      ProductionVariants: [
        {
          VariantName: 'variant-1',
          ModelName: 'my-model',
          InitialInstanceCount: 2,
          InstanceType: 'ml.m5.large',
          InitialVariantWeight: 1,
          VolumeSizeInGB: 50,
          ModelDataDownloadTimeoutInSeconds: 600,
          ContainerStartupHealthCheckTimeoutInSeconds: 300,
          EnableSSMAccess: true,
          ServerlessConfig: { MaxConcurrency: 10, MemorySizeInMB: 2048, ProvisionedConcurrency: 5 },
          ManagedInstanceScaling: { Status: 'ENABLED', MinInstanceCount: 1, MaxInstanceCount: 4 },
          RoutingConfig: { RoutingStrategy: 'LEAST_OUTSTANDING_REQUESTS' },
        },
      ],
      DataCaptureConfig: {
        EnableCapture: true,
        InitialSamplingPercentage: 100,
        DestinationS3Uri: 's3://bucket/capture',
        KmsKeyId: 'arn:aws:kms:...:key/dc',
        CaptureOptions: [{ CaptureMode: 'Input' }, { CaptureMode: 'Output' }],
        CaptureContentTypeHeader: { CsvContentTypes: ['text/csv'] },
      },
      KmsKeyId: 'arn:aws:kms:...:key/ec',
    });
    // Readonly + non-schema fields explicitly absent:
    expect(out).not.toHaveProperty('EndpointConfigArn');
    expect(out).not.toHaveProperty('CreationTime');
    const variants = (out ?? {}).ProductionVariants as Record<string, unknown>[];
    const v = variants[0];
    expect(v).not.toHaveProperty('AcceleratorType');
    expect(v).not.toHaveProperty('CoreDumpConfig');
  });

  it('a minimal response (ProductionVariants only) projects only the returned keys — no empty objects', async () => {
    sagemaker.on(DescribeEndpointConfigCommand).resolves({
      EndpointConfigName: 'ec-min',
      EndpointConfigArn: 'arn:aws:sagemaker:us-east-1:123456789012:endpoint-config/ec-min',
      CreationTime: new Date(0),
      ProductionVariants: [
        {
          VariantName: 'v1',
          ModelName: 'm1',
          InitialInstanceCount: 1,
          InstanceType: 'ml.t2.large',
        },
      ],
    });
    const out = await read(ctx({ EndpointConfigName: 'ec-min' }, 'ec-min'));
    expect(out).toEqual({
      EndpointConfigName: 'ec-min',
      ProductionVariants: [
        {
          VariantName: 'v1',
          ModelName: 'm1',
          InitialInstanceCount: 1,
          InstanceType: 'ml.t2.large',
        },
      ],
    });
    // No DataCaptureConfig / VpcConfig / KmsKeyId / etc. keys fabricated:
    expect(Object.keys(out ?? {}).sort()).toEqual(['EndpointConfigName', 'ProductionVariants']);
  });

  it('falls back to the declared EndpointConfigName when the physical id is empty', async () => {
    sagemaker.on(DescribeEndpointConfigCommand).resolves({
      EndpointConfigName: 'from-decl',
      ProductionVariants: [{ VariantName: 'v1' }],
    });
    const out = await read(ctx({ EndpointConfigName: 'from-decl' }));
    expect(out).toEqual({
      EndpointConfigName: 'from-decl',
      ProductionVariants: [{ VariantName: 'v1' }],
    });
  });

  it('a deleted config (empty response) -> ResourceGoneError (deleted, not skipped)', async () => {
    sagemaker.on(DescribeEndpointConfigCommand).resolves({});
    await expect(read(ctx({ EndpointConfigName: 'gone' }, 'gone'))).rejects.toBeInstanceOf(
      ResourceGoneError
    );
  });

  it('undefined when identity cannot be resolved (physical id + declared name both absent) -> skipped', async () => {
    expect(await read(ctx({}))).toBeUndefined();
  });
});

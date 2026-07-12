// #1523 (part 1) — AWS::SageMaker::DataQualityJobDefinition materializes three undeclared
// CONSTANT defaults that FP on a clean deploy:
//   * StoppingCondition = {MaxRuntimeInSeconds:3600}   (fully-undeclared top-level → KNOWN_DEFAULTS)
//   * DataQualityJobInput.<Batch|Endpoint>Input.S3DataDistributionType = "FullyReplicated"
//   * DataQualityJobInput.<Batch|Endpoint>Input.S3InputMode           = "File"
//     (nested defaults under a partially-declared input → KNOWN_DEFAULT_PATHS)
// All three are stable schema-documented constants → fold-strategy tier 1 (equality-gated):
// each folds the exact default and still surfaces any change away from it.
// Live-verified 2026-07-12 on Cdkrd915MonSchedVerify (us-east-1, BatchTransformInput variant).
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

const T = 'AWS::SageMaker::DataQualityJobDefinition';
const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'JobDef',
  resourceType: T,
  physicalId: 'cdkrd915-monsched-jobdef',
  declared,
});

// A minimal DataQuality job def: the user declares the required app-spec/input/output/resources,
// but NOT StoppingCondition and NOT the input's S3* transfer knobs.
const declaredBatch = {
  DataQualityAppSpecification: { ImageUri: 'x.dkr.ecr.us-east-1.amazonaws.com/analyzer:latest' },
  DataQualityJobInput: {
    BatchTransformInput: {
      DataCapturedDestinationS3Uri: 's3://b/captured/',
      DatasetFormat: { Csv: { Header: true } },
      LocalPath: '/opt/ml/processing/input',
    },
  },
  RoleArn: 'arn:aws:iam::111111111111:role/r',
};

describe('#1523 DataQualityJobDefinition constant defaults', () => {
  it('folds an undeclared StoppingCondition {MaxRuntimeInSeconds:3600} to atDefault', () => {
    const f = classifyResource(
      mk(declaredBatch),
      { ...declaredBatch, StoppingCondition: { MaxRuntimeInSeconds: 3600 } },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toContain('StoppingCondition');
    expect(pathsByTier(f, 'undeclared')).not.toContain('StoppingCondition');
  });

  it('a non-default undeclared StoppingCondition still surfaces (equality gate)', () => {
    const f = classifyResource(
      mk(declaredBatch),
      { ...declaredBatch, StoppingCondition: { MaxRuntimeInSeconds: 7200 } },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).not.toContain('StoppingCondition');
    expect(pathsByTier(f, 'undeclared')).toContain('StoppingCondition');
  });

  it('folds the undeclared BatchTransformInput S3 transfer defaults to atDefault', () => {
    const live = {
      ...declaredBatch,
      DataQualityJobInput: {
        BatchTransformInput: {
          ...declaredBatch.DataQualityJobInput.BatchTransformInput,
          S3DataDistributionType: 'FullyReplicated',
          S3InputMode: 'File',
        },
      },
    };
    const f = classifyResource(mk(declaredBatch), live, emptySchema);
    const atDefault = pathsByTier(f, 'atDefault');
    expect(atDefault).toContain('DataQualityJobInput.BatchTransformInput.S3DataDistributionType');
    expect(atDefault).toContain('DataQualityJobInput.BatchTransformInput.S3InputMode');
    expect(pathsByTier(f, 'undeclared')).toHaveLength(0);
  });

  it('a non-default S3DataDistributionType still surfaces (equality gate)', () => {
    const live = {
      ...declaredBatch,
      DataQualityJobInput: {
        BatchTransformInput: {
          ...declaredBatch.DataQualityJobInput.BatchTransformInput,
          S3DataDistributionType: 'ShardedByS3Key',
          S3InputMode: 'File',
        },
      },
    };
    const f = classifyResource(mk(declaredBatch), live, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain(
      'DataQualityJobInput.BatchTransformInput.S3DataDistributionType'
    );
    // the sibling File default still folds
    expect(pathsByTier(f, 'atDefault')).toContain(
      'DataQualityJobInput.BatchTransformInput.S3InputMode'
    );
  });

  it('folds the EndpointInput variant S3 transfer defaults too', () => {
    const declaredEndpoint = {
      ...declaredBatch,
      DataQualityJobInput: {
        EndpointInput: { EndpointName: 'ep', LocalPath: '/opt/ml/processing/input' },
      },
    };
    const live = {
      ...declaredEndpoint,
      DataQualityJobInput: {
        EndpointInput: {
          ...declaredEndpoint.DataQualityJobInput.EndpointInput,
          S3DataDistributionType: 'FullyReplicated',
          S3InputMode: 'File',
        },
      },
    };
    const f = classifyResource(mk(declaredEndpoint), live, emptySchema);
    const atDefault = pathsByTier(f, 'atDefault');
    expect(atDefault).toContain('DataQualityJobInput.EndpointInput.S3DataDistributionType');
    expect(atDefault).toContain('DataQualityJobInput.EndpointInput.S3InputMode');
  });
});

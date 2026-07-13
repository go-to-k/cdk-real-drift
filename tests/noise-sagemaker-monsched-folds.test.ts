import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// First-run FPs found by the 2026-07-13 hunt (sagemaker-monitoring-min, live us-east-1):
// a barest MonitoringSchedule with an INLINE MonitoringJobDefinition reads back two
// AWS-filled defaults the template never declares —
//   MonitoringScheduleConfig.MonitoringType = "DataQuality"
//   MonitoringScheduleConfig.MonitoringJobDefinition.StoppingCondition = {MaxRuntimeInSeconds:3600}
// Both are stable constants (the StoppingCondition default is the same one the sibling
// AWS::SageMaker::DataQualityJobDefinition pins top-level), so they fold via
// KNOWN_DEFAULT_PATHS — equality-gated, so a flip away still surfaces. The declared/live
// models mirror the harvested corpus case AWS__SageMaker__MonitoringSchedule.Schedule.

const schema: SchemaInfo = {
  readOnly: new Set(['MonitoringScheduleArn', 'CreationTime', 'LastModifiedTime']),
  writeOnly: new Set(),
  createOnly: new Set(['MonitoringScheduleName']),
  readOnlyPaths: ['MonitoringScheduleArn', 'CreationTime', 'LastModifiedTime'],
  writeOnlyPaths: [],
  createOnlyPaths: ['MonitoringScheduleName'],
  defaults: {},
  defaultPaths: {},
};

const jobDefinition = (stopping?: Record<string, unknown>) => ({
  MonitoringInputs: [
    {
      BatchTransformInput: {
        DataCapturedDestinationS3Uri: 's3://hunt-bucket/capture',
        DatasetFormat: { Csv: { Header: false } },
        LocalPath: '/opt/ml/processing/input',
      },
    },
  ],
  MonitoringOutputConfig: {
    MonitoringOutputs: [
      { S3Output: { S3Uri: 's3://hunt-bucket/out', LocalPath: '/opt/ml/processing/output' } },
    ],
  },
  MonitoringResources: {
    ClusterConfig: { InstanceCount: 1, InstanceType: 'ml.m5.large', VolumeSizeInGB: 20 },
  },
  MonitoringAppSpecification: {
    ImageUri: '156813124566.dkr.ecr.us-east-1.amazonaws.com/sagemaker-model-monitor-analyzer',
  },
  RoleArn: 'arn:aws:iam::111111111111:role/hunt-monitor-role',
  ...(stopping !== undefined && { StoppingCondition: stopping }),
});

const resource: DesiredResource = {
  logicalId: 'Schedule',
  resourceType: 'AWS::SageMaker::MonitoringSchedule',
  physicalId:
    'arn:aws:sagemaker:us-east-1:111111111111:monitoring-schedule/cdkrd-hunt-monsched-0713',
  declared: {
    MonitoringScheduleName: 'cdkrd-hunt-monsched-0713',
    MonitoringScheduleConfig: {
      ScheduleConfig: { ScheduleExpression: 'cron(0 23 ? * * *)' },
      MonitoringJobDefinition: jobDefinition(),
    },
  },
};

const live = (over: { type?: string; stopping?: Record<string, unknown> } = {}) => ({
  MonitoringScheduleName: 'cdkrd-hunt-monsched-0713',
  MonitoringScheduleConfig: {
    ScheduleConfig: { ScheduleExpression: 'cron(0 23 ? * * *)' },
    MonitoringJobDefinition: jobDefinition(over.stopping ?? { MaxRuntimeInSeconds: 3600 }),
    MonitoringType: over.type ?? 'DataQuality',
  },
});

const byPath = (findings: Finding[], path: string) => findings.filter((f) => f.path === path);
const TYPE_PATH = 'MonitoringScheduleConfig.MonitoringType';
const STOP_PATH = 'MonitoringScheduleConfig.MonitoringJobDefinition.StoppingCondition';

describe('SageMaker MonitoringSchedule inline-definition default folds (2026-07-13 hunt)', () => {
  it('folds the AWS-filled MonitoringType=DataQuality + StoppingCondition default to atDefault', () => {
    const findings = classifyResource(resource, live(), schema, {});
    expect(byPath(findings, TYPE_PATH)).toEqual([expect.objectContaining({ tier: 'atDefault' })]);
    expect(byPath(findings, STOP_PATH)).toEqual([expect.objectContaining({ tier: 'atDefault' })]);
    expect(findings.filter((f) => f.tier === 'undeclared')).toEqual([]);
  });

  it('a non-default MonitoringType (out-of-band flip) SURFACES', () => {
    const findings = classifyResource(resource, live({ type: 'ModelQuality' }), schema, {});
    expect(byPath(findings, TYPE_PATH)).toEqual([
      expect.objectContaining({ tier: 'undeclared', actual: 'ModelQuality' }),
    ]);
  });

  it('a capped MaxRuntimeInSeconds (non-default StoppingCondition) SURFACES', () => {
    const findings = classifyResource(
      resource,
      live({ stopping: { MaxRuntimeInSeconds: 1800 } }),
      schema,
      {}
    );
    expect(byPath(findings, STOP_PATH)).toEqual([expect.objectContaining({ tier: 'undeclared' })]);
  });
});

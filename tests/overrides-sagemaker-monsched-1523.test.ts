import {
  DescribeMonitoringScheduleCommand,
  ListTagsCommand as SageMakerListTagsCommand,
  type MonitoringScheduleConfig,
  SageMakerClient,
} from '@aws-sdk/client-sagemaker';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { SDK_OVERRIDES } from '../src/read/overrides.js';

// #1523 (part 2) — AWS::SageMaker::MonitoringSchedule IS readable via Cloud Control, but the CC
// response OMITS Tags, so a declared Tags array read back as undefined → a false declared-tier
// `desired=[…] actual=undefined` drift on every tagged schedule. The SDK override reads it via
// DescribeMonitoringSchedule + a separate sagemaker:ListTags, projecting only the CFn-declarable
// surface (name / config / EndpointName / Tags) and dropping the runtime-STATE fields. Live-proven
// 2026-07-12 on Cdkrd1523TagsVerify: old surfaced Tags actual=undefined, the override reads them
// back (matching → CLEAN) and a real out-of-band tag change still surfaces.

const sagemaker = mockClient(SageMakerClient);
const ctx = (declared: Record<string, unknown>, physicalId = '', accountId = '123456789012') => ({
  physicalId,
  declared,
  region: 'us-east-1',
  accountId,
});
const read = SDK_OVERRIDES['AWS::SageMaker::MonitoringSchedule']!;

const CONFIG: MonitoringScheduleConfig = {
  MonitoringType: 'DataQuality',
  MonitoringJobDefinitionName: 'jd',
  ScheduleConfig: { ScheduleExpression: 'cron(0 * ? * * *)' },
};

beforeEach(() => {
  sagemaker.reset();
  sagemaker.on(SageMakerListTagsCommand).resolves({ Tags: [] });
});

describe('SageMaker MonitoringSchedule override (#1523)', () => {
  it('extracts the bare name from an ARN physical id and projects only the CFn surface + Tags', async () => {
    sagemaker.on(DescribeMonitoringScheduleCommand).resolves({
      MonitoringScheduleName: 'ms',
      MonitoringScheduleArn: 'arn:aws:sagemaker:us-east-1:123456789012:monitoring-schedule/ms',
      MonitoringScheduleConfig: CONFIG,
      // runtime-STATE + readOnly response fields that must NOT be projected:
      MonitoringScheduleStatus: 'Scheduled',
      MonitoringType: 'DataQuality',
      CreationTime: new Date(0),
      LastModifiedTime: new Date(0),
    });
    sagemaker
      .on(SageMakerListTagsCommand)
      .resolves({ Tags: [{ Key: 'team', Value: 'drift-probe' }] });

    const model = await read(
      ctx(
        { MonitoringScheduleName: 'ms', Tags: [{ Key: 'team', Value: 'drift-probe' }] },
        'arn:aws:sagemaker:us-east-1:123456789012:monitoring-schedule/ms'
      )
    );

    // the DescribeMonitoringSchedule call received the BARE name, not the ARN
    const call = sagemaker.commandCalls(DescribeMonitoringScheduleCommand)[0]!;
    expect((call.args[0].input as { MonitoringScheduleName?: string }).MonitoringScheduleName).toBe(
      'ms'
    );

    expect(model).toStrictEqual({
      MonitoringScheduleName: 'ms',
      MonitoringScheduleConfig: CONFIG,
      Tags: [{ Key: 'team', Value: 'drift-probe' }],
    });
    // runtime-state / readOnly response fields are dropped
    expect(model).not.toHaveProperty('MonitoringScheduleStatus');
    expect(model).not.toHaveProperty('MonitoringType');
    expect(model).not.toHaveProperty('CreationTime');
  });

  it('omits Tags when there are none (absent stays absent = FP-safe)', async () => {
    sagemaker.on(DescribeMonitoringScheduleCommand).resolves({
      MonitoringScheduleName: 'ms',
      MonitoringScheduleArn: 'arn:aws:sagemaker:us-east-1:123456789012:monitoring-schedule/ms',
      MonitoringScheduleConfig: CONFIG,
    });
    const model = await read(ctx({ MonitoringScheduleName: 'ms' }, 'ms'));
    expect(model).not.toHaveProperty('Tags');
  });

  it('mirrors declared Tags (no false drift) when ListTags fails', async () => {
    sagemaker.on(DescribeMonitoringScheduleCommand).resolves({
      MonitoringScheduleName: 'ms',
      MonitoringScheduleArn: 'arn:aws:sagemaker:us-east-1:123456789012:monitoring-schedule/ms',
      MonitoringScheduleConfig: CONFIG,
    });
    sagemaker.on(SageMakerListTagsCommand).rejects(new Error('AccessDenied'));
    const declaredTags = [{ Key: 'team', Value: 'drift-probe' }];
    const model = await read(ctx({ MonitoringScheduleName: 'ms', Tags: declaredTags }, 'ms'));
    // degrade path: mirror the declared Tags so a permission gap does not false-flag
    expect((model as { Tags?: unknown }).Tags).toStrictEqual(declaredTags);
  });
});

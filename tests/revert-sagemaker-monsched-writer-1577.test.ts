// #1577: AWS::SageMaker::MonitoringSchedule drift DETECTION works (read via the
// readSageMakerMonitoringSchedule SDK override — CC read omits Tags), but before this fix
// `revert` reported "type not revertable yet" because an SDK-override-read type with no
// SDK_WRITERS entry is parked behind the plan.ts CC-gap bar. Registering a whole-resource
// writer that re-PUTs the full MonitoringScheduleConfig via sagemaker:UpdateMonitoringSchedule
// (MonitoringScheduleName is create-only) makes a declared ScheduleExpression drift route to a
// kind='sdk' item and converge. Live-verified 2026-07-13 (us-east-1).
import {
  DescribeMonitoringScheduleCommand,
  ListTagsCommand,
  type MonitoringScheduleConfig,
  SageMakerClient,
  UpdateMonitoringScheduleCommand,
} from '@aws-sdk/client-sagemaker';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import type { OverrideCtx } from '../src/read/overrides.js';
import { buildRevertPlan } from '../src/revert/plan.js';
import { SDK_WRITERS } from '../src/revert/writers.js';
import type { Finding } from '../src/types.js';

const sagemaker = mockClient(SageMakerClient);

const NAME = 'CdkrdMonSched';
const ARN = `arn:aws:sagemaker:us-east-1:123456789012:monitoring-schedule/${NAME}`;

// The full live config the reader returns, carrying the OUT-OF-BAND cron (cron(0 22 ? * * *)).
const liveConfig = (): MonitoringScheduleConfig => ({
  ScheduleConfig: { ScheduleExpression: 'cron(0 22 ? * * *)' },
  MonitoringJobDefinitionName: 'jobdef-abc',
  MonitoringType: 'DataQuality',
});

beforeEach(() => {
  sagemaker.reset();
  sagemaker.on(DescribeMonitoringScheduleCommand).resolves({
    MonitoringScheduleName: NAME,
    MonitoringScheduleArn: ARN,
    MonitoringScheduleConfig: liveConfig(),
  });
  sagemaker.on(ListTagsCommand).resolves({ Tags: [] });
  sagemaker.on(UpdateMonitoringScheduleCommand).resolves({ MonitoringScheduleArn: ARN });
});

describe('#1577 SageMaker MonitoringSchedule is SDK-revertable', () => {
  it('a declared ScheduleExpression drift builds a kind=sdk item (not "not revertable")', () => {
    const f: Finding = {
      tier: 'declared',
      logicalId: 'Schedule',
      physicalId: ARN,
      resourceType: 'AWS::SageMaker::MonitoringSchedule',
      path: 'MonitoringScheduleConfig.ScheduleConfig.ScheduleExpression',
      desired: 'cron(0 23 ? * * *)',
      actual: 'cron(0 22 ? * * *)',
    };
    const plan = buildRevertPlan([f], undefined);
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('sdk');
    expect(plan.items[0]!.resourceType).toBe('AWS::SageMaker::MonitoringSchedule');
  });

  it('the writer PUTs the FULL config with the reverted cron, keyed by the bare name from the ARN', async () => {
    const ctx: OverrideCtx = {
      physicalId: ARN,
      declared: {},
      region: 'us-east-1',
      accountId: '123456789012',
      resourceType: 'AWS::SageMaker::MonitoringSchedule',
    };
    // Revert op: restore the declared cron (cron 23) over the live cron (cron 22).
    await SDK_WRITERS['AWS::SageMaker::MonitoringSchedule']!(ctx, [
      {
        op: 'add',
        path: '/MonitoringScheduleConfig/ScheduleConfig/ScheduleExpression',
        value: 'cron(0 23 ? * * *)',
        prior: 'cron(0 22 ? * * *)',
        human: 'ScheduleExpression -> deployed-template value',
      },
    ]);
    const calls = sagemaker.commandCalls(UpdateMonitoringScheduleCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    // Create-only name extracted from the ARN tail (not the raw ARN).
    expect(input.MonitoringScheduleName).toBe(NAME);
    // The WHOLE config is re-sent, not just the leaf — with the reverted cron and the
    // untouched sibling fields intact.
    expect(input.MonitoringScheduleConfig).toEqual({
      ScheduleConfig: { ScheduleExpression: 'cron(0 23 ? * * *)' },
      MonitoringJobDefinitionName: 'jobdef-abc',
      MonitoringType: 'DataQuality',
    });
  });

  it('throws (honest not-reverted) when the reconstructed model carries no MonitoringScheduleConfig', async () => {
    // Live read returns no config and the revert op does not touch it either — the writer
    // cannot re-PUT a full config, so it fails honestly rather than silently no-op.
    sagemaker.reset();
    sagemaker.on(DescribeMonitoringScheduleCommand).resolves({ MonitoringScheduleName: NAME });
    sagemaker.on(ListTagsCommand).resolves({ Tags: [] });
    const ctx: OverrideCtx = {
      physicalId: ARN,
      declared: {},
      region: 'us-east-1',
      accountId: '123456789012',
      resourceType: 'AWS::SageMaker::MonitoringSchedule',
    };
    await expect(
      SDK_WRITERS['AWS::SageMaker::MonitoringSchedule']!(ctx, [
        { op: 'add', path: '/Tags', value: [{ Key: 'a', Value: 'b' }], human: 'x' },
      ])
    ).rejects.toThrow(/MonitoringScheduleConfig/);
  });
});

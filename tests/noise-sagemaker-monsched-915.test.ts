// #915 (case 1) — AWS::SageMaker::MonitoringSchedule leaks AWS-managed RUNTIME-STATE props as
// undeclared first-run false positives, because the CFN registry schema marks ONLY
// [MonitoringScheduleArn, CreationTime, LastModifiedTime] readOnly. The offending props —
// MonitoringScheduleStatus, LastMonitoringExecutionSummary, FailureReason — are effectively
// read-only status/state (never template intent), so they fold value-independent via
// VALUE_INDEPENDENT_DEFAULT_TOPLEVEL_PATHS.
//
// Live-verified 2026-07-12 on Cdkrd915MonSchedVerify (us-east-1): a fresh MonitoringSchedule
// surfaced MonitoringScheduleStatus="Scheduled" undeclared before any execution, and after
// forcing one execution LastMonitoringExecutionSummary surfaced with the moving-value payload
// asserted below. The nested CreationTime/LastModifiedTime are ALWAYS_STRIPPED; the remaining
// leaf props (ScheduledTime/MonitoringExecutionStatus/FailureReason) move on every hourly run —
// the #847-class time-varying value: class (a) first-check FP + class (b) record never converges.
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

const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'MonSched',
  resourceType: 'AWS::SageMaker::MonitoringSchedule',
  physicalId: 'cdkrd915-monsched',
  declared,
});

// What a user's template declares for a MonitoringSchedule: the config + name (+ optional Tags).
const declared = {
  MonitoringScheduleName: 'cdkrd915-monsched',
  MonitoringScheduleConfig: {
    MonitoringType: 'DataQuality',
    MonitoringJobDefinitionName: 'cdkrd915-monsched-jobdef',
    ScheduleConfig: { ScheduleExpression: 'NOW' },
  },
};

describe('#915 MonitoringSchedule AWS-managed runtime-state folds', () => {
  it('folds an undeclared MonitoringScheduleStatus "Scheduled" to atDefault (fresh deploy)', () => {
    const f = classifyResource(
      mk(declared),
      { ...declared, MonitoringScheduleStatus: 'Scheduled' },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toContain('MonitoringScheduleStatus');
    expect(pathsByTier(f, 'undeclared')).not.toContain('MonitoringScheduleStatus');
  });

  it('folds the undeclared moving LastMonitoringExecutionSummary object to atDefault', () => {
    // Exact live-harvested payload (post-execution) minus the ALWAYS_STRIPPED nested timestamps.
    const summary = {
      ScheduledTime: '2026-07-12T10:21:14Z',
      MonitoringScheduleName: 'cdkrd915-monsched',
      FailureReason: 'Job inputs had no data',
      MonitoringExecutionStatus: 'Failed',
    };
    const f = classifyResource(
      mk(declared),
      { ...declared, LastMonitoringExecutionSummary: summary },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toContain('LastMonitoringExecutionSummary');
    expect(pathsByTier(f, 'undeclared')).not.toContain('LastMonitoringExecutionSummary');
  });

  it('folds an undeclared schedule-level FailureReason to atDefault', () => {
    const f = classifyResource(
      mk(declared),
      { ...declared, FailureReason: 'some failure' },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toContain('FailureReason');
    expect(pathsByTier(f, 'undeclared')).not.toContain('FailureReason');
  });

  it('a real change to the DECLARED config still surfaces as declared drift (fold does not swallow it)', () => {
    const liveConfig = {
      MonitoringType: 'DataQuality',
      MonitoringJobDefinitionName: 'cdkrd915-monsched-jobdef',
      // out-of-band edit of the declared schedule expression
      ScheduleConfig: { ScheduleExpression: 'cron(0 * ? * * *)' },
    };
    const f = classifyResource(
      mk(declared),
      { ...declared, MonitoringScheduleConfig: liveConfig, MonitoringScheduleStatus: 'Scheduled' },
      emptySchema
    );
    expect(pathsByTier(f, 'declared')).toContain(
      'MonitoringScheduleConfig.ScheduleConfig.ScheduleExpression'
    );
    // the runtime-state fold still applies alongside a real declared-config drift
    expect(pathsByTier(f, 'atDefault')).toContain('MonitoringScheduleStatus');
  });
});

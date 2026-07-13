import { describe, expect, it } from 'vite-plus/test';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

// #1553 follow-up: AWS::Config::ConfigurationRecorder is a CC-gap type (Cloud Control throws
// UnsupportedActionException for read AND write), read via an SDK override. Before the
// PutConfigurationRecorder writer it was reported "type not revertable yet" (plan.ts CC-gap bar).
// Registering it in SDK_WRITERS makes a declared drift (a changed RecordingGroup / RecordingMode)
// route to a kind='sdk' item that the whole-resource writer PUTs, instead of not-revertable.
const F = (over: Partial<Finding>): Finding => ({
  tier: 'declared',
  logicalId: 'Recorder',
  physicalId: 'CdkRealDriftIntegConfigRecorder-Recorder-ABC',
  resourceType: 'AWS::Config::ConfigurationRecorder',
  path: 'RecordingGroup.ResourceTypes',
  ...over,
});

describe('buildRevertPlan — Config recorder is SDK-revertable (#1553)', () => {
  it('a declared RecordingGroup.ResourceTypes drift builds a kind=sdk item (not "not revertable")', () => {
    const f = F({
      desired: ['AWS::S3::Bucket'],
      actual: ['AWS::S3::Bucket', 'AWS::IAM::User'],
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('sdk');
    expect(plan.items[0]!.resourceType).toBe('AWS::Config::ConfigurationRecorder');
  });

  it('a whole-object RecordingGroup drift also routes to the whole-resource SDK writer', () => {
    const f = F({
      path: 'RecordingGroup',
      desired: { AllSupported: false, ResourceTypes: ['AWS::S3::Bucket'] },
      actual: { AllSupported: true },
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('sdk');
  });
});

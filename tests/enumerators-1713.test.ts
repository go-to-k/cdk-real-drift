// #1713 — three parents added to CHILD_ENUMERATORS so their out-of-band-added children
// surface in the `added` tier: GuardDuty Detector (Filter / IPSet / ThreatIntelSet /
// ThreatEntitySet / TrustedEntitySet / PublishingDestination — an OOB SUPPRESSION filter
// silently mutes findings), SSM MaintenanceWindow (Target / Task — an added task is an
// arbitrary-command execution surface), and ApplicationAutoScaling ScalableTarget
// (ScalingPolicy). Pure-diff units below; identifiers mirror router.ts
// CC_IDENTIFIER_ADAPTERS composite orders, and siblingLookupId always carries the bare
// CFn physical id for the sibling-stack membership check.
import { describe, expect, it } from 'vite-plus/test';
import {
  diffGuardDutyDetectorChildren,
  diffMaintenanceWindowChildren,
  diffScalableTargetChildren,
} from '../src/read/child-enumerators.js';

const DET = 'det-0123456789abcdef';

describe('#1713 GuardDuty detector children', () => {
  const base = {
    detectorId: DET,
    declaredFilterNames: [] as string[],
    declaredIpSetIds: [] as string[],
    declaredThreatIntelSetIds: [] as string[],
    declaredThreatEntitySetIds: [] as string[],
    declaredTrustedEntitySetIds: [] as string[],
    declaredPublishingDestinationIds: [] as string[],
    liveFilterNames: [] as string[],
    liveIpSetIds: [] as string[],
    liveThreatIntelSetIds: [] as string[],
    liveThreatEntitySetIds: [] as string[],
    liveTrustedEntitySetIds: [] as string[],
    livePublishingDestinations: [] as { id: string; destinationType?: string | undefined }[],
  };

  it('emits an OOB suppression filter with the PARENT-first composite id (router.ts order)', () => {
    const added = diffGuardDutyDetectorChildren({
      ...base,
      declaredFilterNames: ['declared-filter'],
      liveFilterNames: ['declared-filter', 'oob-suppression'],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::GuardDuty::Filter',
        identifier: `${DET}|oob-suppression`,
        label: 'oob-suppression',
        live: { DetectorId: DET, Name: 'oob-suppression' },
        siblingLookupId: 'oob-suppression',
      },
    ]);
  });

  it('emits the *Set family with the CHILD-first composite id and the destination parent-first', () => {
    const added = diffGuardDutyDetectorChildren({
      ...base,
      liveIpSetIds: ['ip-1'],
      liveThreatIntelSetIds: ['ti-1'],
      liveThreatEntitySetIds: ['te-1'],
      liveTrustedEntitySetIds: ['tr-1'],
      livePublishingDestinations: [{ id: 'dest-1', destinationType: 'S3' }],
    });
    expect(added.map((a) => [a.resourceType, a.identifier, a.siblingLookupId])).toEqual([
      ['AWS::GuardDuty::IPSet', `ip-1|${DET}`, 'ip-1'],
      ['AWS::GuardDuty::ThreatIntelSet', `ti-1|${DET}`, 'ti-1'],
      ['AWS::GuardDuty::ThreatEntitySet', `te-1|${DET}`, 'te-1'],
      ['AWS::GuardDuty::TrustedEntitySet', `tr-1|${DET}`, 'tr-1'],
      ['AWS::GuardDuty::PublishingDestination', `${DET}|dest-1`, 'dest-1'],
    ]);
    expect(added[4]!.label).toBe('dest-1 (S3)');
  });

  it('declared children are never flagged', () => {
    const added = diffGuardDutyDetectorChildren({
      ...base,
      declaredIpSetIds: ['ip-declared'],
      liveIpSetIds: ['ip-declared'],
    });
    expect(added).toEqual([]);
  });
});

describe('#1713 SSM maintenance window children', () => {
  const W = 'mw-0123456789abcdef0';

  it('emits an OOB-registered task with the PARENT-first composite id and a task label', () => {
    const added = diffMaintenanceWindowChildren({
      windowId: W,
      declaredTargetIds: ['target-declared'],
      declaredTaskIds: ['task-declared'],
      liveTargets: [{ id: 'target-declared' }],
      liveTasks: [
        { id: 'task-declared' },
        { id: 'task-oob', label: 'task-oob (RUN_COMMAND AWS-RunShellScript)' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::SSM::MaintenanceWindowTask',
        identifier: `${W}|task-oob`,
        label: 'task-oob (RUN_COMMAND AWS-RunShellScript)',
        live: { WindowId: W, Id: 'task-oob' },
        siblingLookupId: 'task-oob',
      },
    ]);
  });

  it('emits an OOB target too', () => {
    const added = diffMaintenanceWindowChildren({
      windowId: W,
      declaredTargetIds: [],
      declaredTaskIds: [],
      liveTargets: [{ id: 'target-oob' }],
      liveTasks: [],
    });
    expect(added.map((a) => [a.resourceType, a.identifier])).toEqual([
      ['AWS::SSM::MaintenanceWindowTarget', `${W}|target-oob`],
    ]);
  });
});

describe('#1713 Application Auto Scaling scalable-target children', () => {
  const ARN =
    'arn:aws:autoscaling:us-east-1:123456789012:scalingPolicy:sp-1:resource/dynamodb/table/t:policyName/oob-policy';
  const input = {
    serviceNamespace: 'dynamodb',
    resourceId: 'table/t',
    scalableDimension: 'dynamodb:table:ReadCapacityUnits',
    declaredPolicyArns: [] as string[],
    declaredPolicyNames: [] as string[],
    livePolicies: [{ arn: ARN, name: 'oob-policy' }],
  };

  it('emits an OOB put-scaling-policy with the ARN|dimension composite (scalingPolicyComposite order)', () => {
    const added = diffScalableTargetChildren(input);
    expect(added).toEqual([
      {
        resourceType: 'AWS::ApplicationAutoScaling::ScalingPolicy',
        identifier: `${ARN}|dynamodb:table:ReadCapacityUnits`,
        label: 'oob-policy',
        live: {
          PolicyName: 'oob-policy',
          ScalingTargetId: 'table/t|dynamodb:table:ReadCapacityUnits|dynamodb',
        },
        siblingLookupId: ARN,
      },
    ]);
  });

  it('a policy declared by ARN or by name is never flagged', () => {
    expect(diffScalableTargetChildren({ ...input, declaredPolicyArns: [ARN] })).toEqual([]);
    expect(diffScalableTargetChildren({ ...input, declaredPolicyNames: ['oob-policy'] })).toEqual(
      []
    );
  });
});

import { describe, expect, it } from 'vite-plus/test';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

// #1313: Cloud Control UpdateResource REJECTS any patch on AWS::KinesisVideo::Stream /
// AWS::KinesisVideo::SignalingChannel (their Tags schema has minItems:1, so a CC PUT can never
// validate), yet the registry schema HAS an update handler — so the #908/#1091 no-update-handler
// bar does not fire. A cc-kind revert of a path NOT covered by a type-specific SDK writer would
// emit a patch that always fails at apply with a raw error; it must be barred as notRevertable up
// front. The 3 writer-covered paths (DataRetentionInHours / MessageTtlSeconds /
// StreamStorageConfiguration) stay revertable via their SDK writers (the exemption).

const F = (over: Partial<Finding>): Finding => ({
  tier: 'declared',
  logicalId: 'R',
  physicalId: 'phys-1',
  resourceType: 'AWS::KinesisVideo::Stream',
  path: 'MediaType',
  ...over,
});

describe('#1313 KinesisVideo CC-reject bar', () => {
  it('Stream MediaType (uncovered path) -> notRevertable, not a cc item', () => {
    const f = F({
      resourceType: 'AWS::KinesisVideo::Stream',
      path: 'MediaType',
      desired: 'video/h264',
      actual: 'video/h265',
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]!.reason).toContain('rejects any Cloud Control patch');
  });

  it('SignalingChannel Tags (uncovered path) -> notRevertable, not a cc item', () => {
    const f = F({
      resourceType: 'AWS::KinesisVideo::SignalingChannel',
      path: 'Tags',
      desired: [{ Key: 'env', Value: 'prod' }],
      actual: [{ Key: 'env', Value: 'dev' }],
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]!.reason).toContain('rejects any Cloud Control patch');
  });

  it('Stream DataRetentionInHours (writer-covered) stays a kind=sdk item (exemption)', () => {
    // SDK_PROP_WRITERS covers this exact path -> propScoped -> kind 'sdk'. The bar must NOT fire.
    const f = F({
      resourceType: 'AWS::KinesisVideo::Stream',
      path: 'DataRetentionInHours',
      desired: 24,
      actual: 48,
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      kind: 'sdk',
      resourceType: 'AWS::KinesisVideo::Stream',
    });
  });
});

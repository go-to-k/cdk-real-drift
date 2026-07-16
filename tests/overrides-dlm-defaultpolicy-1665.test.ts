// #1665 — the declared DefaultPolicy ("VOLUME"|"INSTANCE") had no live counterpart in
// readDlmLifecyclePolicy's model (GetLifecyclePolicy reports a BOOLEAN Policy.DefaultPolicy
// plus the details' singular ResourceType), so it read as a genuine readGap — which (the
// #795 completeness fail-safe) blocked the resource from ever being snapshot-complete and
// silently disabled appeared-since-record detection for every undeclared out-of-band change
// on the policy (live-hit: an OOB RetainInterval 7->5 stayed [Potential Drift] forever).
// The reader now projects the declared-shaped enum back, gated on live CONFIRMING a default
// policy — a custom policy never emits the key (the #1660 readGap-fix-FP lesson).
import { GetLifecyclePolicyCommand, DLMClient } from '@aws-sdk/client-dlm';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { SDK_OVERRIDES } from '../src/read/overrides.js';

const dlm = mockClient(DLMClient);
beforeEach(() => dlm.reset());

const ctx = (declared: Record<string, unknown>) => ({
  physicalId: 'policy-0123456789abcdef0',
  declared,
  region: 'us-east-1',
  accountId: '123456789012',
});

describe('DLM default-policy DefaultPolicy projection (#1665)', () => {
  it('projects DefaultPolicy from the boolean + details.ResourceType (readGap closed)', async () => {
    dlm.on(GetLifecyclePolicyCommand).resolves({
      Policy: {
        Description: 'default policy',
        State: 'ENABLED',
        ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
        DefaultPolicy: true,
        PolicyDetails: {
          PolicyLanguage: 'SIMPLIFIED',
          ResourceType: 'VOLUME',
          CreateInterval: 1,
          RetainInterval: 7,
        },
      },
    });
    const out = await SDK_OVERRIDES['AWS::DLM::LifecyclePolicy'](
      ctx({
        DefaultPolicy: 'VOLUME',
        CreateInterval: 1,
        Description: 'default policy',
        State: 'ENABLED',
        ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
      })
    );
    expect(out?.DefaultPolicy).toBe('VOLUME');
    // shorthand keys still projected to the top level alongside it
    expect(out?.CreateInterval).toBe(1);
    expect(out?.RetainInterval).toBe(7);
    expect(out?.PolicyDetails).toBeUndefined();
  });

  it('never emits DefaultPolicy for a custom policy (no fresh undeclared FP)', async () => {
    dlm.on(GetLifecyclePolicyCommand).resolves({
      Policy: {
        Description: 'custom policy',
        State: 'ENABLED',
        ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
        PolicyDetails: {
          PolicyType: 'EBS_SNAPSHOT_MANAGEMENT',
          ResourceTypes: ['VOLUME'],
          Schedules: [{ Name: 'daily' }],
        },
      },
    });
    const out = await SDK_OVERRIDES['AWS::DLM::LifecyclePolicy'](
      ctx({
        Description: 'custom policy',
        State: 'ENABLED',
        ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
        PolicyDetails: { PolicyType: 'EBS_SNAPSHOT_MANAGEMENT' },
      })
    );
    expect(out?.DefaultPolicy).toBeUndefined();
  });

  it('stays an honest readGap when live confirms default but carries no ResourceType', async () => {
    dlm.on(GetLifecyclePolicyCommand).resolves({
      Policy: {
        Description: 'default policy',
        State: 'ENABLED',
        ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
        DefaultPolicy: true,
        PolicyDetails: { CreateInterval: 1 },
      },
    });
    const out = await SDK_OVERRIDES['AWS::DLM::LifecyclePolicy'](
      ctx({ DefaultPolicy: 'VOLUME', CreateInterval: 1 })
    );
    expect(out?.DefaultPolicy).toBeUndefined();
  });
});

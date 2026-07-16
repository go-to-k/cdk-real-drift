// #1666 — reverting an out-of-band default-policy RetainInterval change silently no-oped
// (live-proven 2026-07-17: 7->5 mutated, revert planned a bare `remove`, reported
// "reverted", the live value stayed 5). Two layers, both pinned here:
// - PLAN: writeDlmLifecyclePolicy builds the Update payload from the desired model, so a
//   removed key never reaches the call — RetainInterval needs the explicit set-default
//   `add` (7 from the #1663 KNOWN_DEFAULTS pin) via REVERT_SET_DEFAULT_PATHS.
// - WRITER: the default-policy shorthand keys are TOP-LEVEL UpdateLifecyclePolicy request
//   params ([Default policies only]); PolicyDetails is [Custom policies only]. The old
//   shorthand branch synthesized a live-overlaid PolicyDetails — the wrong request field
//   for a default policy (written blind; zero live fixtures until the 2026-07-17 hunt).
import {
  GetLifecyclePolicyCommand,
  DLMClient,
  UpdateLifecyclePolicyCommand,
} from '@aws-sdk/client-dlm';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import type { BaselineFile } from '../src/baseline/baseline-file.js';
import { buildRevertPlan } from '../src/revert/plan.js';
import { SDK_WRITERS } from '../src/revert/writers.js';
import type { Finding } from '../src/types.js';

const baseline = (recorded: BaselineFile['recorded']): BaselineFile => ({
  schemaVersion: 1,
  stackName: 's',
  region: 'r',
  accountId: '111122223333',
  capturedAt: '',
  templateHash: '',
  recorded,
});

describe('#1666 DLM default-policy RetainInterval revert', () => {
  it('plans an explicit set-default add (7 from KNOWN_DEFAULTS), not a bare remove', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'DefaultPolicy',
      physicalId: 'policy-0abc',
      resourceType: 'AWS::DLM::LifecyclePolicy',
      path: 'RetainInterval',
      actual: 5,
    };
    const plan = buildRevertPlan([f], baseline([]));
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/RetainInterval',
      value: 7,
      prior: 5,
    });
  });

  const dlm = mockClient(DLMClient);
  beforeEach(() => dlm.reset());

  it('writer sends the shorthand keys as TOP-LEVEL Update params, never PolicyDetails', async () => {
    // Live read (desiredModel's base): a default policy whose RetainInterval drifted to 5.
    dlm.on(GetLifecyclePolicyCommand).resolves({
      Policy: {
        PolicyId: 'policy-0abc',
        Description: 'default policy',
        State: 'ENABLED',
        ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
        DefaultPolicy: true,
        PolicyDetails: {
          PolicyLanguage: 'SIMPLIFIED',
          ResourceType: 'VOLUME',
          CreateInterval: 1,
          RetainInterval: 5,
        },
      },
    } as never);
    dlm.on(UpdateLifecyclePolicyCommand).resolves({});
    await SDK_WRITERS['AWS::DLM::LifecyclePolicy'](
      {
        physicalId: 'policy-0abc',
        declared: {
          DefaultPolicy: 'VOLUME',
          CreateInterval: 1,
          Description: 'default policy',
          State: 'ENABLED',
          ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
        },
        region: 'us-east-1',
        accountId: '123456789012',
      },
      [
        {
          op: 'add',
          path: '/RetainInterval',
          value: 7,
          human: 'RetainInterval -> AWS default (7)',
        },
      ]
    );
    const calls = dlm.commandCalls(UpdateLifecyclePolicyCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as unknown as Record<string, unknown>;
    expect(input.RetainInterval).toBe(7);
    expect(input.CreateInterval).toBe(1);
    expect(input.PolicyDetails).toBeUndefined();
  });
});

// #835 — reverting an `added` AWS::SecretsManager::ResourcePolicy (an out-of-band
// `put-resource-policy` on a secret with no declared ResourcePolicy, surfaced by the Secrets
// Manager child enumerator) must route through the service's own DeleteResourcePolicy, NOT Cloud
// Control DeleteResource: the ResourcePolicy CC primaryIdentifier is a service-generated `Id` an
// out-of-band policy never produces, so a CC delete keyed on the secret ARN would fail. The SDK
// deleter (SDK_DELETERS, the delete analog of SDK_WRITERS — the #1312/#1386/#1431 type-specific
// SDK routing) detaches the policy with DeleteResourcePolicy; the finding carries the SECRET ARN
// as its physicalId, which IS the DeleteResourcePolicy `SecretId` target.
import { DeleteResourcePolicyCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { SDK_DELETERS } from '../src/revert/writers.js';

const ARN = 'arn:aws:secretsmanager:us-east-1:111122223333:secret:my-secret-AbCdEf';

describe('SDK_DELETERS[AWS::SecretsManager::ResourcePolicy] — DeleteResourcePolicy (#835)', () => {
  const sm = mockClient(SecretsManagerClient);
  beforeEach(() => sm.reset());
  afterEach(() => sm.restore());

  const deleter = SDK_DELETERS['AWS::SecretsManager::ResourcePolicy']!;

  it('is registered (the routing table knows the type)', () => {
    expect(deleter).toBeDefined();
  });

  it('detaches the policy via DeleteResourcePolicy on the secret ARN', async () => {
    sm.on(DeleteResourcePolicyCommand).resolves({});
    await deleter({ physicalId: ARN, region: 'us-east-1' });
    const calls = sm.commandCalls(DeleteResourcePolicyCommand);
    expect(calls.length).toBe(1);
    expect(calls[0]!.args[0].input).toEqual({ SecretId: ARN });
  });

  it('propagates a genuine failure (honest FAILED, not a silent skip)', async () => {
    sm.on(DeleteResourcePolicyCommand).rejects(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
    );
    await expect(deleter({ physicalId: ARN, region: 'us-east-1' })).rejects.toThrow('denied');
  });
});

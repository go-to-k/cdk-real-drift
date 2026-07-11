// #835 — reverting an `added` AWS::KMS::Grant (an out-of-band `kms create-grant` on a declared
// key, surfaced by the KMS key child enumerator) must route through the KMS RevokeGrant API. A
// KMS grant is NOT a CloudFormation/Cloud Control resource at all (there is no AWS::KMS::Grant
// type), so CC DeleteResource cannot apply — the SDK deleter (SDK_DELETERS) revokes it via
// RevokeGrant, addressing the grant as { KeyId, GrantId }. `GrantId` is the finding's physicalId
// (the enumerator identity); `KeyId` is the enumerating parent KMS Key's CFn physical id
// (parentPhysicalId, recovered at the stack-actions call site).
import { KMSClient, RevokeGrantCommand } from '@aws-sdk/client-kms';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { SDK_DELETERS } from '../src/revert/writers.js';

const KEYID = 'key-uuid-1';
const GRANTID = 'abc123grantid';

describe('SDK_DELETERS[AWS::KMS::Grant] — RevokeGrant { KeyId, GrantId } (#835)', () => {
  const kms = mockClient(KMSClient);
  beforeEach(() => kms.reset());
  afterEach(() => kms.restore());

  const deleter = SDK_DELETERS['AWS::KMS::Grant']!;

  it('is registered (the routing table knows the synthetic type)', () => {
    expect(deleter).toBeDefined();
  });

  it('revokes the grant via RevokeGrant on the parent key + grant id', async () => {
    kms.on(RevokeGrantCommand).resolves({});
    await deleter({ physicalId: GRANTID, parentPhysicalId: KEYID, region: 'us-east-1' });
    const calls = kms.commandCalls(RevokeGrantCommand);
    expect(calls.length).toBe(1);
    expect(calls[0]!.args[0].input).toEqual({ KeyId: KEYID, GrantId: GRANTID });
  });

  it('throws when the parent KMS Key id is missing (cannot address the revoke)', async () => {
    await expect(deleter({ physicalId: GRANTID, region: 'us-east-1' })).rejects.toThrow(
      /parent KMS Key/
    );
  });

  it('propagates a genuine failure (honest FAILED, not a silent skip)', async () => {
    kms
      .on(RevokeGrantCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(
      deleter({ physicalId: GRANTID, parentPhysicalId: KEYID, region: 'us-east-1' })
    ).rejects.toThrow('denied');
  });
});

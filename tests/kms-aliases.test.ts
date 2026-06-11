import { KMSClient, ListAliasesCommand } from '@aws-sdk/client-kms';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { fetchManagedAliasTargets, usesManagedKmsAlias } from '../src/read/kms-aliases.js';

const kms = mockClient(KMSClient);
beforeEach(() => kms.reset());

describe('usesManagedKmsAlias', () => {
  it('detects an alias/aws/* string anywhere in a value tree', () => {
    expect(usesManagedKmsAlias({ KmsKeyId: 'alias/aws/rds' })).toBe(true);
    expect(usesManagedKmsAlias({ a: [{ b: 'alias/aws/s3' }] })).toBe(true);
  });
  it('is false for custom aliases / unrelated values', () => {
    expect(usesManagedKmsAlias({ KmsKeyId: 'alias/my-key' })).toBe(false);
    expect(usesManagedKmsAlias({ x: 1, y: ['a', 'b'] })).toBe(false);
  });
});

describe('fetchManagedAliasTargets', () => {
  it('maps only alias/aws/* names to their target key id (paginated)', async () => {
    kms
      .on(ListAliasesCommand)
      .resolvesOnce({
        Aliases: [
          { AliasName: 'alias/aws/rds', TargetKeyId: 'key-rds' },
          { AliasName: 'alias/my-custom', TargetKeyId: 'key-custom' }, // not aws/* → excluded
        ],
        Truncated: true,
        NextMarker: 'm2',
      })
      .resolves({ Aliases: [{ AliasName: 'alias/aws/s3', TargetKeyId: 'key-s3' }] });
    const out = await fetchManagedAliasTargets('us-west-2');
    expect(out).toEqual({ 'alias/aws/rds': 'key-rds', 'alias/aws/s3': 'key-s3' });
  });

  it('returns {} (fall back) when ListAliases throws (e.g. missing kms:ListAliases)', async () => {
    kms
      .on(ListAliasesCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    expect(await fetchManagedAliasTargets('eu-central-1')).toEqual({});
  });
});

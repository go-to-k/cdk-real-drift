import { GetSecurityConfigurationCommand, GlueClient } from '@aws-sdk/client-glue';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { ResourceGoneError } from '../src/aws-errors.js';
import { SDK_OVERRIDES } from '../src/read/overrides.js';

// #857 — AWS::Glue::SecurityConfiguration has NO Cloud Control read handler
// (registry `handlers: []`), so it was silently `skipped` on every check and a
// stack's Glue encryption posture went unwatched. This exercises the SDK_OVERRIDES
// reader that reads it back via glue:GetSecurityConfiguration and maps the response
// to the CFn `EncryptionConfiguration` shape.

const glue = mockClient(GlueClient);

const ctx = (declared: Record<string, unknown>, physicalId = '', accountId = '123456789012') => ({
  physicalId,
  declared,
  region: 'us-east-1',
  accountId,
});

beforeEach(() => {
  glue.reset();
});

describe('Glue SecurityConfiguration (#857)', () => {
  it('maps EncryptionConfiguration; SDK S3Encryption (singular) -> CFn S3Encryptions (plural), drops AWS-managed + non-CFn fields', async () => {
    glue.on(GetSecurityConfigurationCommand).resolves({
      SecurityConfiguration: {
        Name: 'sec-cfg',
        // AWS-managed field that must NOT appear:
        CreatedTimeStamp: new Date(0),
        EncryptionConfiguration: {
          // SDK uses S3Encryption (singular array); CFn schema is S3Encryptions (plural):
          S3Encryption: [{ S3EncryptionMode: 'SSE-KMS', KmsKeyArn: 'arn:aws:kms:...:key/s3' }],
          CloudWatchEncryption: {
            CloudWatchEncryptionMode: 'SSE-KMS',
            KmsKeyArn: 'arn:aws:kms:...:key/cw',
          },
          JobBookmarksEncryption: {
            JobBookmarksEncryptionMode: 'CSE-KMS',
            KmsKeyArn: 'arn:aws:kms:...:key/jb',
          },
          // Returned by the SDK but NOT in the CFn schema — must be dropped:
          DataQualityEncryption: { DataQualityEncryptionMode: 'SSE-KMS' },
        },
      },
    });
    const out = await SDK_OVERRIDES['AWS::Glue::SecurityConfiguration'](
      ctx({ Name: 'sec-cfg' }, 'sec-cfg')
    );
    expect(out).toEqual({
      Name: 'sec-cfg',
      EncryptionConfiguration: {
        S3Encryptions: [{ S3EncryptionMode: 'SSE-KMS', KmsKeyArn: 'arn:aws:kms:...:key/s3' }],
        CloudWatchEncryption: {
          CloudWatchEncryptionMode: 'SSE-KMS',
          KmsKeyArn: 'arn:aws:kms:...:key/cw',
        },
        JobBookmarksEncryption: {
          JobBookmarksEncryptionMode: 'CSE-KMS',
          KmsKeyArn: 'arn:aws:kms:...:key/jb',
        },
      },
    });
  });

  it('projects only the members AWS returns (a config with just S3 encryption)', async () => {
    glue.on(GetSecurityConfigurationCommand).resolves({
      SecurityConfiguration: {
        Name: 's3-only',
        EncryptionConfiguration: {
          S3Encryption: [{ S3EncryptionMode: 'DISABLED' }],
        },
      },
    });
    const out = await SDK_OVERRIDES['AWS::Glue::SecurityConfiguration'](
      ctx({ Name: 's3-only' }, 's3-only')
    );
    expect(out).toEqual({
      Name: 's3-only',
      EncryptionConfiguration: {
        S3Encryptions: [{ S3EncryptionMode: 'DISABLED' }],
      },
    });
  });

  it('falls back to the declared Name when the physical id is empty', async () => {
    glue.on(GetSecurityConfigurationCommand).resolves({
      SecurityConfiguration: { Name: 'from-decl' },
    });
    const out = await SDK_OVERRIDES['AWS::Glue::SecurityConfiguration'](ctx({ Name: 'from-decl' }));
    // No EncryptionConfiguration returned -> the key is omitted (not an empty object).
    expect(out).toEqual({ Name: 'from-decl' });
  });

  it('undefined when the name cannot be resolved (physical id + declared Name both absent)', async () => {
    expect(await SDK_OVERRIDES['AWS::Glue::SecurityConfiguration'](ctx({}))).toBeUndefined();
  });

  it('a deleted configuration (null SecurityConfiguration) -> ResourceGoneError (deleted, not skipped)', async () => {
    glue.on(GetSecurityConfigurationCommand).resolves({ SecurityConfiguration: undefined });
    await expect(
      SDK_OVERRIDES['AWS::Glue::SecurityConfiguration'](ctx({ Name: 'gone' }, 'gone'))
    ).rejects.toBeInstanceOf(ResourceGoneError);
  });
});

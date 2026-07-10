// #704 — an UNDECLARED managed-service-KEY nested path (DynamoDB
// SSESpecification.KMSMasterKeyId, GlobalTable per-replica twin, OpenSearch
// EncryptionAtRestOptions.KmsKeyId) is folded value-independent (GENERATED_NESTED_PATHS),
// which HID an out-of-band swap from the AWS-managed key to a customer-managed key — a
// MUTABLE, security-relevant change (DynamoDB SSE is changeable via `UpdateTable
// --sse-specification`, unlike RDS's create-only KmsKeyId). Fix: gate the fold against the
// resolved account/region AWS-managed key ARN — fold ONLY the managed key, surface any CMK.
// KMS resolution failure/denial → fail OPEN (fold), so no new first-run false positive.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import {
  shouldFoldManagedServiceKey,
  typeNeedsManagedKeyResolution,
} from '../src/read/kms-aliases.js';
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

const paths = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();

const mk = (
  resourceType: string,
  declared: Record<string, unknown>,
  physicalId = 'phys'
): DesiredResource => ({ logicalId: 'R', resourceType, physicalId, declared });

// The account's AWS-managed alias/aws/dynamodb key: ListAliases yields the bare key id;
// the live model carries the full key ARN whose trailing segment is that key id.
const MANAGED_KEY_ID = '11111111-2222-3333-4444-555555555555';
const MANAGED_KEY_ARN = `arn:aws:kms:us-east-1:123456789012:key/${MANAGED_KEY_ID}`;
const CMK_ARN = 'arn:aws:kms:us-east-1:123456789012:key/99999999-8888-7777-6666-000000000000';
const ddbAliasTargets = { 'alias/aws/dynamodb': MANAGED_KEY_ID };

describe('#704 DynamoDB SSESpecification.KMSMasterKeyId managed-key gate', () => {
  const declared = { TableName: 't', SSESpecification: { SSEEnabled: true } };

  it('folds (atDefault) when the live key IS the account AWS-managed alias/aws/dynamodb key', () => {
    const f = classifyResource(
      mk('AWS::DynamoDB::Table', declared),
      {
        TableName: 't',
        SSESpecification: { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: MANAGED_KEY_ARN },
      },
      emptySchema,
      { kmsAliasTargets: ddbAliasTargets }
    );
    expect(paths(f, 'undeclared')).not.toContain('SSESpecification.KMSMasterKeyId');
    // it must fold — as `generated` (the value-independent tier), never surfaced
    expect(paths(f, 'generated')).toContain('SSESpecification.KMSMasterKeyId');
  });

  it('SURFACES (undeclared) when the live key is a customer-managed key (CMK) swapped in', () => {
    const f = classifyResource(
      mk('AWS::DynamoDB::Table', declared),
      {
        TableName: 't',
        SSESpecification: { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: CMK_ARN },
      },
      emptySchema,
      { kmsAliasTargets: ddbAliasTargets }
    );
    expect(paths(f, 'undeclared')).toContain('SSESpecification.KMSMasterKeyId');
    expect(paths(f, 'generated')).not.toContain('SSESpecification.KMSMasterKeyId');
  });

  it('fails OPEN (folds) when KMS alias resolution is unavailable (no targets / denied)', () => {
    const f = classifyResource(
      mk('AWS::DynamoDB::Table', declared),
      {
        TableName: 't',
        SSESpecification: { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: CMK_ARN },
      },
      emptySchema,
      { kmsAliasTargets: {} } // ListAliases denied/transient → empty map → fail open
    );
    expect(paths(f, 'undeclared')).not.toContain('SSESpecification.KMSMasterKeyId');
    expect(paths(f, 'generated')).toContain('SSESpecification.KMSMasterKeyId');
  });
});

describe('#704 OpenSearch EncryptionAtRestOptions.KmsKeyId rides the same gate', () => {
  const declared = { DomainName: 'd', EncryptionAtRestOptions: { Enabled: true } };
  const esKeyId = '77777777-6666-5555-4444-333333333333';
  const esManagedArn = `arn:aws:kms:us-east-1:123456789012:key/${esKeyId}`;
  const esAliasTargets = { 'alias/aws/es': esKeyId };
  const esCmk = 'arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('folds the AWS-managed alias/aws/es key, surfaces a CMK', () => {
    const managed = classifyResource(
      mk('AWS::OpenSearchService::Domain', declared),
      { DomainName: 'd', EncryptionAtRestOptions: { Enabled: true, KmsKeyId: esManagedArn } },
      emptySchema,
      { kmsAliasTargets: esAliasTargets }
    );
    expect(paths(managed, 'undeclared')).not.toContain('EncryptionAtRestOptions.KmsKeyId');

    const cmk = classifyResource(
      mk('AWS::OpenSearchService::Domain', declared),
      { DomainName: 'd', EncryptionAtRestOptions: { Enabled: true, KmsKeyId: esCmk } },
      emptySchema,
      { kmsAliasTargets: esAliasTargets }
    );
    expect(paths(cmk, 'undeclared')).toContain('EncryptionAtRestOptions.KmsKeyId');
  });
});

describe('#704 shouldFoldManagedServiceKey predicate', () => {
  it('folds the managed key, surfaces a CMK, fails open when unresolved', () => {
    const p = 'SSESpecification.KMSMasterKeyId';
    // managed key → fold
    expect(
      shouldFoldManagedServiceKey('AWS::DynamoDB::Table', p, MANAGED_KEY_ARN, ddbAliasTargets)
    ).toBe(true);
    // CMK → surface (don't fold)
    expect(shouldFoldManagedServiceKey('AWS::DynamoDB::Table', p, CMK_ARN, ddbAliasTargets)).toBe(
      false
    );
    // unresolved alias (empty targets) → fail open (fold)
    expect(shouldFoldManagedServiceKey('AWS::DynamoDB::Table', p, CMK_ARN, {})).toBe(true);
    // non-managed path → false (caller must not gate it here)
    expect(shouldFoldManagedServiceKey('AWS::DynamoDB::Table', 'Other.Path', CMK_ARN, {})).toBe(
      false
    );
  });

  it('typeNeedsManagedKeyResolution flags the managed-key types (gather prefetch trigger)', () => {
    expect(typeNeedsManagedKeyResolution('AWS::DynamoDB::Table')).toBe(true);
    expect(typeNeedsManagedKeyResolution('AWS::DynamoDB::GlobalTable')).toBe(true);
    expect(typeNeedsManagedKeyResolution('AWS::OpenSearchService::Domain')).toBe(true);
    expect(typeNeedsManagedKeyResolution('AWS::S3::Bucket')).toBe(false);
  });
});

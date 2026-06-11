import { describe, expect, it } from 'vite-plus/test';
import { isArnNameMatch, isManagedKmsAliasMatch } from '../src/normalize/arn-identity.js';

describe('isArnNameMatch (name <-> ARN identity)', () => {
  const fnArn = 'arn:aws:lambda:us-east-1:111122223333:function:MyFn';
  it('matches a bare name against an ARN ending in :name', () => {
    expect(isArnNameMatch('MyFn', fnArn)).toBe(true);
  });
  it('matches a bare name against an ARN ending in /name', () => {
    expect(isArnNameMatch('table1', 'arn:aws:dynamodb:us-east-1:1:table/table1')).toBe(true);
  });
  it('does NOT match a different name (real drift preserved)', () => {
    expect(isArnNameMatch('OtherFn', fnArn)).toBe(false);
  });
  it('does NOT match when both are bare names', () => {
    expect(isArnNameMatch('MyFn', 'MyFn')).toBe(false);
  });
  it('does NOT match when both are ARNs (let the diff compare them)', () => {
    expect(isArnNameMatch(fnArn, fnArn)).toBe(false);
  });
  it('ignores non-strings', () => {
    expect(isArnNameMatch(5, fnArn)).toBe(false);
    expect(isArnNameMatch('MyFn', 5)).toBe(false);
  });
  it('does not match a name that is a non-final ARN segment (qualifier present)', () => {
    expect(isArnNameMatch('MyFn', `${fnArn}:PROD`)).toBe(false);
  });
});

describe('isManagedKmsAliasMatch (managed-default KMS alias <-> key ARN)', () => {
  const keyArn = 'arn:aws:kms:us-east-1:111122223333:key/9ee8feba-ae18-445a-bcab-306f7748fb6c';
  it('matches alias/aws/* against a live key ARN', () => {
    expect(isManagedKmsAliasMatch('alias/aws/rds', keyArn)).toBe(true);
    expect(isManagedKmsAliasMatch('alias/aws/secretsmanager', keyArn)).toBe(true);
  });
  it('does NOT match a custom alias (a real custom key is preserved as drift)', () => {
    expect(isManagedKmsAliasMatch('alias/my-key', keyArn)).toBe(false);
  });
  it('does NOT match when actual is not a KMS key ARN', () => {
    expect(isManagedKmsAliasMatch('alias/aws/rds', 'arn:aws:kms:us-east-1:1:alias/aws/rds')).toBe(
      false
    );
  });
});

import { describe, expect, it } from 'vite-plus/test';
import {
  isArnNameMatch,
  isLogGroupArnWildcardMatch,
  isManagedKmsAliasMatch,
} from '../src/normalize/arn-identity.js';

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

  it('does NOT match a MULTI-segment path suffix (a different object is not hidden)', () => {
    // A bare name that is only a partial path-suffix of a longer key is a DIFFERENT
    // resource — must surface as drift, not be equated. (The old endsWith matched it.)
    expect(isArnNameMatch('a/b/c', 'arn:aws:s3:::my-bucket/x/a/b/c')).toBe(false);
    expect(isArnNameMatch('b/c', 'arn:aws:s3:::my-bucket/a/b/c')).toBe(false);
  });

  it('matches the WHOLE final colon-segment (the full resource portion)', () => {
    // a name declared as the full `type/id` (or full S3 bucket/key) still matches
    expect(isArnNameMatch('role/MyRole', 'arn:aws:iam::111122223333:role/MyRole')).toBe(true);
    expect(isArnNameMatch('my-bucket/key.txt', 'arn:aws:s3:::my-bucket/key.txt')).toBe(true);
  });

  it('matches the resource id after the last / (the common bare-name echo)', () => {
    expect(isArnNameMatch('MyRole', 'arn:aws:iam::111122223333:role/MyRole')).toBe(true);
  });

  // Bidirectional: the bare name may be on the DESIRED side and the ARN on the
  // ACTUAL side (AWS::Lambda::Url.TargetFunctionArn: template resolves GetAtt to the
  // function ARN, live read returns the bare function name).
  describe('reverse direction (desired=ARN, actual=name)', () => {
    it('matches an ARN desired against its bare-name actual', () => {
      expect(isArnNameMatch(fnArn, 'MyFn')).toBe(true);
    });
    it('does NOT match a different name (real drift preserved)', () => {
      expect(isArnNameMatch(fnArn, 'OtherFn')).toBe(false);
    });
    it('honors account/region scoping in reverse too', () => {
      const opts = { accountId: '111122223333', region: 'us-east-1' };
      expect(isArnNameMatch(fnArn, 'MyFn', opts)).toBe(true);
      const otherAcct = 'arn:aws:lambda:us-east-1:999999999999:function:MyFn';
      expect(isArnNameMatch(otherAcct, 'MyFn', opts)).toBe(false);
    });
  });

  // R10: account/region scoping — a same-named resource in a DIFFERENT account or
  // region is genuine drift, not a name<->ARN echo.
  describe('with account/region scoping', () => {
    const opts = { accountId: '111122223333', region: 'us-east-1' };
    it('suppresses when account + region both match (regression)', () => {
      expect(isArnNameMatch('MyFn', fnArn, opts)).toBe(true);
    });
    it('reports drift when the ARN account differs', () => {
      const other = 'arn:aws:lambda:us-east-1:999999999999:function:MyFn';
      expect(isArnNameMatch('MyFn', other, opts)).toBe(false);
    });
    it('reports drift when the ARN region differs', () => {
      const other = 'arn:aws:lambda:eu-west-1:111122223333:function:MyFn';
      expect(isArnNameMatch('MyFn', other, opts)).toBe(false);
    });
    it('stays suffix-only for an empty-segment ARN (S3-style)', () => {
      // arn:aws:s3:::my-bucket — region + account segments are empty
      expect(isArnNameMatch('my-bucket', 'arn:aws:s3:::my-bucket', opts)).toBe(true);
    });
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

  describe('strict resolution via aliasTargets (R9)', () => {
    const targets = { 'alias/aws/rds': '9ee8feba-ae18-445a-bcab-306f7748fb6c' };
    it('suppresses when the live key IS the alias managed key', () => {
      expect(isManagedKmsAliasMatch('alias/aws/rds', keyArn, targets)).toBe(true);
    });
    it('reports drift when a DIFFERENT (customer-managed) key was swapped in', () => {
      const custom = 'arn:aws:kms:us-east-1:111122223333:key/00000000-1111-2222-3333-444444444444';
      expect(isManagedKmsAliasMatch('alias/aws/rds', custom, targets)).toBe(false);
    });
    it('falls back to shape-based suppression when the alias is unresolved (no perms)', () => {
      expect(isManagedKmsAliasMatch('alias/aws/rds', keyArn, {})).toBe(true);
    });
  });
});

describe('isLogGroupArnWildcardMatch (CloudWatch Logs log-group ARN :* wildcard)', () => {
  const base = 'arn:aws:logs:ap-northeast-1:111122223333:log-group:/aws/api-gateway/scoring/x';
  it('suppresses desired-with-:* vs actual-without (API Gateway AccessLogSetting case)', () => {
    expect(isLogGroupArnWildcardMatch(`${base}:*`, base)).toBe(true);
  });
  it('suppresses in the reverse direction (actual carries the :*)', () => {
    expect(isLogGroupArnWildcardMatch(base, `${base}:*`)).toBe(true);
  });
  it('suppresses when both carry the :* (defensive — diff already equal)', () => {
    expect(isLogGroupArnWildcardMatch(`${base}:*`, `${base}:*`)).toBe(true);
  });
  it('reports drift on a DIFFERENT log group (real repoint preserved)', () => {
    const other = 'arn:aws:logs:ap-northeast-1:111122223333:log-group:/aws/api-gateway/other';
    expect(isLogGroupArnWildcardMatch(`${base}:*`, other)).toBe(false);
  });
  it('does NOT match non-log-group ARNs', () => {
    expect(
      isLogGroupArnWildcardMatch(
        'arn:aws:lambda:us-east-1:1:function:Fn:*',
        'arn:aws:lambda:us-east-1:1:function:Fn'
      )
    ).toBe(false);
  });
  it('ignores non-strings', () => {
    expect(isLogGroupArnWildcardMatch(5, `${base}:*`)).toBe(false);
    expect(isLogGroupArnWildcardMatch(`${base}:*`, null)).toBe(false);
  });
});

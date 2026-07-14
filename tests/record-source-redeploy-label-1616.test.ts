// #1616 (follow-up to #1606): after the stale-source void folds a recorded content hash
// (Lambda CodeSha256 / Glue ScriptSha256) because the declared code was redeployed through
// CloudFormation, the nudged re-`record` must NOT label the refreshed hash "CHANGED out of
// band" — that phrase is what makes a user stop and audit a possibly attacker-set value, so
// crying wolf on every legit code redeploy dulls the real warning. It is a legit refresh.
import { describe, expect, it } from 'vite-plus/test';
import { type BaselineFile, declaredSourceFingerprint } from '../src/baseline/baseline-file.js';
import { changedRecordLabel, isRecordedSourceRedeployed } from '../src/commands/stack-actions.js';

const SHA_A = `${'a'.repeat(43)}=`;
const SHA_B = `${'b'.repeat(43)}=`;
const CODE_V1 = { S3Bucket: 'assets', S3Key: 'aaaa1111.zip' };
const CODE_V2 = { S3Bucket: 'assets', S3Key: 'bbbb2222.zip' };
const fnEntry = {
  logicalId: 'Fn',
  path: 'CodeSha256',
  resourceType: 'AWS::Lambda::Function',
};
const declaredWith = (code: Record<string, unknown>) =>
  new Map<string, Record<string, unknown>>([['Fn', { Code: code, Handler: 'index.handler' }]]);
const baselineWithFp = (code: Record<string, unknown>): BaselineFile => ({
  schemaVersion: 2,
  stackName: 's',
  region: 'r',
  accountId: '111122223333',
  capturedAt: '',
  templateHash: '',
  recorded: [{ ...fnEntry, value: SHA_A }],
  recordedSourceFingerprints: {
    'Fn::CodeSha256': declaredSourceFingerprint('AWS::Lambda::Function', 'CodeSha256', {
      Code: code,
    })!,
  },
});

describe('#1616 record label for a content hash redeployed via CloudFormation', () => {
  describe('changedRecordLabel', () => {
    it('reads "changed since record" when NOT source-redeployed (today\'s wording, default arg)', () => {
      const label = changedRecordLabel(
        {
          logicalId: 'Fn',
          path: 'CodeSha256',
          value: SHA_B,
          resourceType: 'AWS::Lambda::Function',
        },
        { hasRecorded: true, recordedValue: SHA_A }
      );
      expect(label).toContain('changed since record');
      expect(label).not.toContain('redeployed via CloudFormation');
    });

    it('reads "redeployed via CloudFormation — refreshing watch" when source-redeployed', () => {
      const label = changedRecordLabel(
        {
          logicalId: 'Fn',
          path: 'CodeSha256',
          value: SHA_B,
          resourceType: 'AWS::Lambda::Function',
        },
        { hasRecorded: true, recordedValue: SHA_A },
        true
      );
      expect(label).toContain('declared source redeployed via CloudFormation');
      expect(label).toContain('refreshing watch');
      expect(label).not.toContain('changed since record');
      // still shows recorded → live so the user sees the hashes moved
      expect(label).toContain('→');
    });
  });

  describe('isRecordedSourceRedeployed (the #1606 void predicate, reused for the label)', () => {
    it('true when the stored fingerprint differs from the CURRENT declared source (legit redeploy)', () => {
      expect(
        isRecordedSourceRedeployed(fnEntry, baselineWithFp(CODE_V1), declaredWith(CODE_V2))
      ).toBe(true);
    });

    it('false when the declared source is UNCHANGED (an out-of-band same-source swap still surfaces)', () => {
      expect(
        isRecordedSourceRedeployed(fnEntry, baselineWithFp(CODE_V1), declaredWith(CODE_V1))
      ).toBe(false);
    });

    it("false for an OLD baseline with no stored fingerprint (fail-safe: keeps today's wording)", () => {
      const noFp: BaselineFile = { ...baselineWithFp(CODE_V1), recordedSourceFingerprints: {} };
      expect(isRecordedSourceRedeployed(fnEntry, noFp, declaredWith(CODE_V2))).toBe(false);
      expect(isRecordedSourceRedeployed(fnEntry, undefined, declaredWith(CODE_V2))).toBe(false);
    });

    it('false when the current declared source does not resolve (fail-safe: never mislabels on unknown)', () => {
      // Code absent from the declared model → current fingerprint undefined → not redeployed.
      const declaredNoCode = new Map<string, Record<string, unknown>>([['Fn', { Handler: 'h' }]]);
      expect(isRecordedSourceRedeployed(fnEntry, baselineWithFp(CODE_V1), declaredNoCode)).toBe(
        false
      );
    });

    it('false for a path with no source mapping (a plain undeclared recorded value)', () => {
      const plain = { logicalId: 'B', path: 'SomeProp', resourceType: 'AWS::S3::Bucket' };
      const b: BaselineFile = {
        ...baselineWithFp(CODE_V1),
        recordedSourceFingerprints: { 'B::SomeProp': 'sha256:whatever' },
      };
      expect(isRecordedSourceRedeployed(plain, b, new Map([['B', { SomeProp: 'x' }]]))).toBe(false);
    });
  });
});

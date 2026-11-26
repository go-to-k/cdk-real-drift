// #1958: the #1606 stale-source void folds a recorded Lambda CodeSha256 once the declared
// `Code` was redeployed through CloudFormation — but "legit redeploy" and "legit redeploy,
// THEN an out-of-band `update-function-code`" look the same from the baseline, so the swap
// read CLEAN until the next `record`. The fix hashes the S3 asset the template deploys and
// compares the live hash against it.
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  applyBaseline,
  type BaselineFile,
  declaredSourceFingerprint,
} from '../src/baseline/baseline-file.js';
import { isRecordedSourceRedeployed } from '../src/commands/stack-actions.js';
import {
  annotateDeployedSourceHashes,
  lambdaCodeS3Ref,
  type S3Sha256Fetcher,
} from '../src/read/deployed-source-hash.js';
import type { Finding } from '../src/types.js';

const SHA_RECORDED = `${'a'.repeat(43)}=`;
const SHA_DEPLOYED = `${'b'.repeat(43)}=`;
const SHA_SWAPPED = `${'c'.repeat(43)}=`;
const CODE_V1 = { S3Bucket: 'assets', S3Key: 'aaaa1111.zip' };
const CODE_V2 = { S3Bucket: 'assets', S3Key: 'bbbb2222.zip' };
const LAMBDA = 'AWS::Lambda::Function';
const GLUE = 'AWS::Glue::Job';

const baseline = (extra: Partial<BaselineFile> = {}): BaselineFile => ({
  schemaVersion: 2,
  stackName: 's',
  region: 'r',
  accountId: '111122223333',
  capturedAt: '',
  templateHash: '',
  recorded: [{ logicalId: 'Fn', path: 'CodeSha256', resourceType: LAMBDA, value: SHA_RECORDED }],
  recordedSourceFingerprints: {
    'Fn::CodeSha256': declaredSourceFingerprint(LAMBDA, 'CodeSha256', { Code: CODE_V1 })!,
  },
  ...extra,
});
const declaredV2 = new Map<string, Record<string, unknown>>([['Fn', { Code: CODE_V2 }]]);
const liveHash = (actual: string, deployedSourceHash?: string): Finding => ({
  tier: 'generated',
  logicalId: 'Fn',
  resourceType: LAMBDA,
  path: 'CodeSha256',
  actual,
  ...(deployedSourceHash !== undefined && { deployedSourceHash }),
});

function run(findings: Finding[], b: BaselineFile = baseline()) {
  const warn = vi.fn<(s: string) => void>();
  const out = applyBaseline(findings, b, { declaredByLogical: declaredV2, warn });
  return { out, notes: warn.mock.calls.map((c) => c[0]) };
}

describe('#1958 applyBaseline verifies a redeploy-voided CodeSha256', () => {
  it('live == deployed asset hash: legit redeploy folds with the re-record nudge only', () => {
    const { out, notes } = run([liveHash(SHA_DEPLOYED, SHA_DEPLOYED)]);
    expect(out.map((f) => `${f.tier}:${f.path}`)).toEqual(['generated:CodeSha256']);
    expect(out[0]).not.toHaveProperty('deployedSourceHash');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('redeployed via CloudFormation since record');
  });

  it('live != deployed asset hash: an out-of-band swap after the redeploy is drift', () => {
    const { out, notes } = run([liveHash(SHA_SWAPPED, SHA_DEPLOYED)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      tier: 'undeclared',
      path: 'CodeSha256',
      actual: SHA_SWAPPED,
      desired: SHA_DEPLOYED,
    });
    expect(out[0]!.unrecorded).toBeUndefined();
    expect(out[0]).not.toHaveProperty('deployedSourceHash');
    // never nudge the user to re-record a swapped hash
    expect(notes).toEqual([]);
  });

  it("unverifiable (no deployed hash): today's void plus a coverage note", () => {
    const { out, notes } = run([liveHash(SHA_SWAPPED)]);
    expect(out.map((f) => `${f.tier}:${f.path}`)).toEqual(['generated:CodeSha256']);
    expect(notes).toHaveLength(2);
    expect(notes[1]).toContain('could not verify Fn.CodeSha256');
  });

  it('a hash supplement that failed this run (no live finding) is also unverified', () => {
    const { out, notes } = run([]);
    expect(out).toEqual([]);
    expect(notes.some((n) => n.includes('could not verify Fn.CodeSha256'))).toBe(true);
  });

  it('no coverage note for a type with no deployed-source verifier (Glue ScriptSha256)', () => {
    const b = baseline({
      recorded: [{ logicalId: 'Job', path: 'ScriptSha256', resourceType: GLUE, value: 'x' }],
      recordedSourceFingerprints: {
        'Job::ScriptSha256': declaredSourceFingerprint(GLUE, 'ScriptSha256', {
          Command: { ScriptLocation: 's3://a/v1.py' },
        })!,
      },
    });
    const warn = vi.fn<(s: string) => void>();
    applyBaseline(
      [
        {
          tier: 'generated',
          logicalId: 'Job',
          resourceType: GLUE,
          path: 'ScriptSha256',
          actual: 'y',
        },
      ],
      b,
      {
        declaredByLogical: new Map([['Job', { Command: { ScriptLocation: 's3://a/v2.py' } }]]),
        warn,
      }
    );
    expect(warn.mock.calls.map((c) => c[0])).toHaveLength(1);
    expect(warn.mock.calls[0]![0]).not.toContain('could not verify');
  });

  it('a deployed hash on an entry the void does NOT drop is ignored (fingerprint unchanged)', () => {
    const warn = vi.fn<(s: string) => void>();
    const out = applyBaseline([liveHash(SHA_RECORDED, SHA_SWAPPED)], baseline(), {
      declaredByLogical: new Map([['Fn', { Code: CODE_V1 }]]),
      warn,
    });
    expect(out).toEqual([]); // recorded value matches → suppressed, as before
  });
});

describe('#1958 annotateDeployedSourceHashes', () => {
  const resources = (code: unknown) => [{ logicalId: 'Fn', declared: { Code: code } }];

  it('stamps the asset hash on a voided Lambda CodeSha256, fetching only that object', async () => {
    const fetch = vi.fn<S3Sha256Fetcher>(async () => SHA_DEPLOYED);
    const other: Finding = { ...liveHash('x'), logicalId: 'Other' };
    const out = await annotateDeployedSourceHashes(
      [liveHash(SHA_DEPLOYED), other],
      baseline(),
      [...resources({ ...CODE_V2, S3ObjectVersion: 'v9' }), { logicalId: 'Other', declared: {} }],
      'us-east-1',
      fetch
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      { bucket: 'assets', key: 'bbbb2222.zip', versionId: 'v9' },
      'us-east-1'
    );
    expect(out[0]!.deployedSourceHash).toBe(SHA_DEPLOYED);
    expect(out[1]).toBe(other);
  });

  it('does not fetch when the declared source is unchanged since record', async () => {
    const fetch = vi.fn<S3Sha256Fetcher>(async () => SHA_DEPLOYED);
    const findings = [liveHash(SHA_RECORDED)];
    const out = await annotateDeployedSourceHashes(
      findings,
      baseline(),
      resources(CODE_V1),
      'r',
      fetch
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(out).toBe(findings);
  });

  it('leaves the finding unstamped when the asset read fails', async () => {
    const fetch = vi.fn<S3Sha256Fetcher>(async () => {
      throw new Error('AccessDenied');
    });
    const out = await annotateDeployedSourceHashes(
      [liveHash(SHA_SWAPPED)],
      baseline(),
      resources(CODE_V2),
      'r',
      fetch
    );
    expect(out[0]!.deployedSourceHash).toBeUndefined();
  });

  it('no baseline: returns the findings untouched without fetching', async () => {
    const fetch = vi.fn<S3Sha256Fetcher>();
    const findings = [liveHash(SHA_SWAPPED)];
    expect(await annotateDeployedSourceHashes(findings, undefined, [], 'r', fetch)).toBe(findings);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('#1958 lambdaCodeS3Ref', () => {
  it('only a literal S3Bucket + S3Key is fetchable', () => {
    expect(lambdaCodeS3Ref({ Code: CODE_V2 })).toEqual({
      bucket: 'assets',
      key: 'bbbb2222.zip',
      versionId: undefined,
    });
    expect(lambdaCodeS3Ref({ Code: { ZipFile: 'exports.handler=1' } })).toBeUndefined();
    expect(lambdaCodeS3Ref({ Code: { ImageUri: 'x.dkr.ecr/y:z' } })).toBeUndefined();
    expect(
      lambdaCodeS3Ref({ Code: { S3Bucket: { 'Fn::Sub': 'x' }, S3Key: 'k.zip' } })
    ).toBeUndefined();
    expect(lambdaCodeS3Ref(undefined)).toBeUndefined();
  });
});

describe('#1958 record labels a swap after a redeploy as changed, not a refresh', () => {
  const entry = { logicalId: 'Fn', path: 'CodeSha256', resourceType: LAMBDA };
  it('swapped live hash → not a source redeploy', () => {
    expect(
      isRecordedSourceRedeployed(entry, baseline(), declaredV2, [
        liveHash(SHA_SWAPPED, SHA_DEPLOYED),
      ])
    ).toBe(false);
  });
  it('verified live hash (or no verification) → still a source redeploy', () => {
    expect(
      isRecordedSourceRedeployed(entry, baseline(), declaredV2, [
        liveHash(SHA_DEPLOYED, SHA_DEPLOYED),
      ])
    ).toBe(true);
    expect(isRecordedSourceRedeployed(entry, baseline(), declaredV2, [liveHash('x')])).toBe(true);
  });
});

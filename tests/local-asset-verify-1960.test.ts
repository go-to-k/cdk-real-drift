// #1960: Glue ScriptSha256 and the ELBv2 TrustStore CA-bundle hash have the #1958 gap too
// (a legit redeploy voids the recorded hash, an out-of-band overwrite after it read CLEAN),
// but their S3 object IS the live artifact. The expected hash comes from the LOCAL
// synthesized file asset whose (content-addressed) S3 key the deployed template points at.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  applyBaseline,
  type BaselineFile,
  declaredSourceFingerprint,
} from '../src/baseline/baseline-file.js';
import { hashCaBundle, sha256Hex } from '../src/read/pem.js';
import { annotateDeployedSourceHashes } from '../src/read/deployed-source-hash.js';
import { assetManifestFilesOf, localFileAssetHashes } from '../src/synth/local-assets.js';
import type { Finding } from '../src/types.js';

const GLUE = 'AWS::Glue::Job';
const TS = 'AWS::ElasticLoadBalancingV2::TrustStore';
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBAAAA\n-----END CERTIFICATE-----\n';
const SCRIPT = 'print("v2")\n';

function assembly(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkrd-1960-'));
  writeFileSync(join(dir, 'asset.s.py'), SCRIPT);
  writeFileSync(join(dir, 'asset.c.pem'), PEM);
  writeFileSync(join(dir, 'asset.dir'), 'a readable file, but zip-packaged: must be skipped');
  const manifest = join(dir, 'Stack.assets.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      version: '36.0.0',
      files: {
        s: {
          source: { path: 'asset.s.py', packaging: 'file' },
          destinations: { d: { bucketName: 'b-${AWS::AccountId}', objectKey: 'v2key.py' } },
        },
        c: {
          source: { path: 'asset.c.pem' }, // packaging omitted = file
          destinations: { d: { bucketName: 'b', objectKey: 'cakey.pem' } },
        },
        z: {
          source: { path: 'asset.dir', packaging: 'zip' }, // directory asset: skipped
          destinations: { d: { bucketName: 'b', objectKey: 'dir.zip' } },
        },
        missing: {
          source: { path: 'asset.gone.py' },
          destinations: { d: { bucketName: 'b', objectKey: 'gone.py' } },
        },
      },
    })
  );
  return manifest;
}

describe('#1960 localFileAssetHashes', () => {
  it('hashes file assets by published object key; skips zip and unreadable assets', () => {
    const h = localFileAssetHashes([assembly(), '/nonexistent/x.assets.json']);
    expect(Object.keys(h).sort()).toEqual(['cakey.pem', 'v2key.py']);
    expect(h['v2key.py']).toEqual({ sha256Hex: sha256Hex(Buffer.from(SCRIPT)) });
    expect(h['cakey.pem']!.caBundleSha256).toBe(hashCaBundle(PEM));
  });

  it('assetManifestFilesOf picks only asset-manifest dependencies', () => {
    expect(
      assetManifestFilesOf({
        dependencies: [
          { file: '/a/S.assets.json', manifest: { type: 'cdk:asset-manifest' } },
          { file: '/a/other', manifest: { type: 'aws:cloudformation:stack' } },
          {},
        ],
      })
    ).toEqual(['/a/S.assets.json']);
  });
});

const base = (
  logicalId: string,
  resourceType: string,
  path: string,
  declared: object
): BaselineFile => ({
  schemaVersion: 2,
  stackName: 's',
  region: 'r',
  accountId: '111122223333',
  capturedAt: '',
  templateHash: '',
  recorded: [{ logicalId, path, resourceType, value: 'recorded' }],
  recordedSourceFingerprints: {
    [`${logicalId}::${path}`]: declaredSourceFingerprint(resourceType, path, declared as never)!,
  },
});

describe('#1960 Glue ScriptSha256 after a legit script redeploy', () => {
  const b = base('Job', GLUE, 'ScriptSha256', { Command: { ScriptLocation: 's3://b/v1key.py' } });
  const resources = [
    { logicalId: 'Job', declared: { Command: { ScriptLocation: 's3://b/v2key.py' } } },
  ];
  const live = (actual: string): Finding => ({
    tier: 'generated',
    logicalId: 'Job',
    resourceType: GLUE,
    path: 'ScriptSha256',
    actual,
  });
  const localAssets = localFileAssetHashes([assembly()]);
  const expected = sha256Hex(Buffer.from(SCRIPT))!;
  const run = async (actual: string, assets = localAssets) => {
    const fetch = vi.fn();
    const stamped = await annotateDeployedSourceHashes([live(actual)], b, resources, 'r', {
      localAssets: assets,
      fetch,
    });
    expect(fetch).not.toHaveBeenCalled(); // local asset, never an S3 read
    const warn = vi.fn<(s: string) => void>();
    const out = applyBaseline(stamped, b, {
      declaredByLogical: new Map(resources.map((r) => [r.logicalId, r.declared])),
      warn,
    });
    return { out, notes: warn.mock.calls.map((c) => c[0]) };
  };

  it('live == local asset: folds with the nudge, no coverage note', async () => {
    const { out, notes } = await run(expected);
    expect(out.map((f) => f.tier)).toEqual(['generated']);
    expect(notes).toHaveLength(1);
  });

  it('live != local asset: the out-of-band overwrite is drift', async () => {
    const { out, notes } = await run('overwritten');
    expect(out[0]).toMatchObject({ tier: 'undeclared', actual: 'overwritten', desired: expected });
    expect(notes).toEqual([]);
  });

  it('deployed key not in the local assembly: unverified', async () => {
    const { out, notes } = await run('overwritten', {});
    expect(out.map((f) => f.tier)).toEqual(['generated']);
    expect(notes[1]).toContain('could not verify Job.ScriptSha256');
  });
});

describe('#1960 TrustStore CA bundle after a legit bundle redeploy', () => {
  const declaredV1 = { CaCertificatesBundleS3Bucket: 'b', CaCertificatesBundleS3Key: 'old.pem' };
  const declaredV2 = { CaCertificatesBundleS3Bucket: 'b', CaCertificatesBundleS3Key: 'cakey.pem' };
  const b = base('Ts', TS, 'CaCertificatesBundleSha256', declaredV1);
  const resources = [{ logicalId: 'Ts', declared: declaredV2 }];
  // the TrustStore hash is a plain `undeclared` finding (not a `generated` tier)
  const live = (actual: string): Finding => ({
    tier: 'undeclared',
    logicalId: 'Ts',
    resourceType: TS,
    path: 'CaCertificatesBundleSha256',
    actual,
  });
  const run = async (actual: string) => {
    const stamped = await annotateDeployedSourceHashes([live(actual)], b, resources, 'r', {
      localAssets: localFileAssetHashes([assembly()]),
    });
    return applyBaseline(stamped, b, {
      declaredByLogical: new Map([['Ts', declaredV2]]),
      warn: () => {},
    });
  };

  it('verified: suppressed (never surfaces as undeclared drift)', async () => {
    expect(await run(hashCaBundle(PEM)!)).toEqual([]);
  });

  it('swapped: drift', async () => {
    const out = await run('swapped');
    expect(out[0]).toMatchObject({ tier: 'undeclared', desired: hashCaBundle(PEM) });
    expect(out[0]!.unrecorded).toBeUndefined();
  });
});

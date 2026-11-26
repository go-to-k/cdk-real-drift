import { createHash } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DEPLOYED_SOURCE_VERIFIABLE,
  recordedKey,
  sourceRedeployedKeys,
  type BaselineFile,
} from '../baseline/baseline-file.js';
import type { Finding } from '../types.js';
import { READ_RETRY } from './client-config.js';

export interface S3ObjectRef {
  bucket: string;
  key: string;
  versionId?: string | undefined;
}

// Fetch one S3 object and return its SHA-256 as base64 — the encoding Lambda reports
// `CodeSha256` in for a zip package. Streams the body so a large package is never buffered.
export type S3Sha256Fetcher = (ref: S3ObjectRef, region: string) => Promise<string>;

const s3Clients = new Map<string, S3Client>();

export const fetchS3Sha256Base64: S3Sha256Fetcher = async (ref, region) => {
  let s3 = s3Clients.get(region);
  if (s3 === undefined) {
    s3 = new S3Client({ region, followRegionRedirects: true, ...READ_RETRY });
    s3Clients.set(region, s3);
  }
  const obj = await s3.send(
    new GetObjectCommand({
      Bucket: ref.bucket,
      Key: ref.key,
      ...(ref.versionId !== undefined && { VersionId: ref.versionId }),
    })
  );
  const body = obj.Body as AsyncIterable<Uint8Array> | undefined;
  if (body === undefined) throw new Error('empty S3 object body');
  const h = createHash('sha256');
  for await (const chunk of body) h.update(chunk);
  return h.digest('base64');
};

const FETCH_CONCURRENCY = 4;

// The S3 object a Lambda function's declared `Code` deploys, or undefined for an inline
// `ZipFile`, an `ImageUri`, or a bucket/key that did not resolve to a literal string.
export function lambdaCodeS3Ref(
  declared: Record<string, unknown> | undefined
): S3ObjectRef | undefined {
  const code = declared?.['Code'];
  if (code === null || typeof code !== 'object' || Array.isArray(code)) return undefined;
  const { S3Bucket, S3Key, S3ObjectVersion } = code as Record<string, unknown>;
  if (typeof S3Bucket !== 'string' || typeof S3Key !== 'string') return undefined;
  if (S3ObjectVersion !== undefined && typeof S3ObjectVersion !== 'string') return undefined;
  return { bucket: S3Bucket, key: S3Key, versionId: S3ObjectVersion };
}

/**
 * #1958: stamp `deployedSourceHash` on each live content-hash finding whose recorded entry
 * the stale-source void (#1606) would drop — a legit code redeploy since record — so
 * `applyBaseline` can still catch an out-of-band swap made AFTER that redeploy instead of
 * reading CLEAN until the next `record`. Only the voided entries are fetched (an S3 read of
 * every function's package on every check would be the wrong cost). Fail-safe: any read
 * failure (no s3:GetObject on the asset bucket, a lifecycle-expired asset) or a non-S3 source
 * leaves the finding unstamped, which keeps today's void plus a coverage note.
 */
export async function annotateDeployedSourceHashes(
  findings: Finding[],
  baseline: BaselineFile | undefined,
  resources: { logicalId: string; declared: Record<string, unknown> }[],
  region: string,
  fetch: S3Sha256Fetcher = fetchS3Sha256Base64
): Promise<Finding[]> {
  if (!baseline) return findings;
  const declaredByLogical = new Map(resources.map((r) => [r.logicalId, r.declared]));
  const voided = sourceRedeployedKeys(baseline, declaredByLogical);
  if (voided.size === 0) return findings;
  const jobs: { i: number; ref: S3ObjectRef }[] = [];
  findings.forEach((f, i) => {
    if (f.deployedSourceHash !== undefined) return;
    if (DEPLOYED_SOURCE_VERIFIABLE[f.resourceType] !== f.path) return;
    if (!voided.has(recordedKey(f))) return;
    const ref = lambdaCodeS3Ref(declaredByLogical.get(f.logicalId));
    if (ref !== undefined) jobs.push({ i, ref });
  });
  if (jobs.length === 0) return findings;
  // Bounded concurrency: every package download streams a whole zip.
  const hashes = new Map<number, string>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const { i, ref } = jobs[next++]!;
      try {
        hashes.set(i, await fetch(ref, region));
      } catch {
        // unverifiable — keep today's void (applyBaseline emits the coverage note)
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, jobs.length) }, worker));
  if (hashes.size === 0) return findings;
  return findings.map((f, i) => {
    const h = hashes.get(i);
    return h === undefined ? f : { ...f, deployedSourceHash: h };
  });
}

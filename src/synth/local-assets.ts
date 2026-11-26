import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { hashCaBundle, sha256Hex } from '../read/pem.js';

// #1960: the content hashes of a stack's local FILE assets in the synthesized cloud assembly,
// keyed by the S3 object key each one publishes to. CDK asset keys are content-addressed, so
// a key the DEPLOYED template points at that also appears here was built from these exact
// bytes — the hash of what the template deploys, for a content hash whose S3 object IS the
// live artifact (Glue script, TrustStore CA bundle) and so cannot be its own "expected".
// Hashed at synth time because the assembly is disposed once synth returns.
export interface LocalAssetHash {
  sha256Hex: string; // Glue ScriptSha256 encoding
  caBundleSha256?: string; // TrustStore CaCertificatesBundleSha256 encoding (PEM content only)
}
export type LocalAssetHashes = Record<string, LocalAssetHash>;

// A file larger than this is never a script or a CA bundle; skip it rather than read it.
const MAX_ASSET_BYTES = 16 * 1024 * 1024;

interface AssetManifestFile {
  source?: { path?: unknown; packaging?: unknown };
  destinations?: Record<string, { objectKey?: unknown }>;
}

/** Hash the `file`-packaged assets of the given asset manifest files (absolute paths). */
export function localFileAssetHashes(manifestFiles: string[]): LocalAssetHashes {
  const out: LocalAssetHashes = {};
  for (const manifestFile of manifestFiles) {
    let files: Record<string, AssetManifestFile>;
    try {
      files =
        (JSON.parse(readFileSync(manifestFile, 'utf8')) as { files?: typeof files }).files ?? {};
    } catch {
      continue; // unreadable manifest: those assets stay unverifiable
    }
    for (const asset of Object.values(files)) {
      const { path, packaging } = asset.source ?? {};
      if (typeof path !== 'string' || (packaging !== undefined && packaging !== 'file')) continue;
      const abs = isAbsolute(path) ? path : join(dirname(manifestFile), path);
      let bytes: Buffer;
      try {
        if (statSync(abs).size > MAX_ASSET_BYTES) continue;
        bytes = readFileSync(abs);
      } catch {
        continue;
      }
      const hex = sha256Hex(bytes);
      if (hex === undefined) continue;
      const ca = hashCaBundle(bytes.toString('utf8'));
      const hash: LocalAssetHash = {
        sha256Hex: hex,
        ...(ca !== undefined && { caBundleSha256: ca }),
      };
      for (const d of Object.values(asset.destinations ?? {}))
        if (typeof d.objectKey === 'string') out[d.objectKey] = hash;
    }
  }
  return out;
}

// The asset-manifest files a cx-api stack artifact depends on (duck-typed: an
// AssetManifestArtifact carries an absolute `file`; avoids an instanceof across packages).
export function assetManifestFilesOf(stack: { dependencies?: readonly unknown[] }): string[] {
  const out: string[] = [];
  for (const d of stack.dependencies ?? []) {
    const file = (d as { file?: unknown; manifest?: { type?: unknown } }).file;
    const type = (d as { manifest?: { type?: unknown } }).manifest?.type;
    if (typeof file === 'string' && type === 'cdk:asset-manifest') out.push(file);
  }
  return out;
}

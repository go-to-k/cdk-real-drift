import { createHash } from 'node:crypto';

// A stable, order- and whitespace-insensitive digest of a PEM CA-certificate BUNDLE — the
// integrity signal cdkrd records for an ELBv2 TrustStore, whose CA bundle location is
// writeOnly (unreadable) but whose live CONTENT is reachable via a presigned S3 URL
// (issue #505). A TrustStore's trust anchors are a SET, so the certificates are canonicalized
// (base64 body only, all whitespace stripped) and SORTED before hashing — reordering or
// re-wrapping the same anchors yields the same hash, while adding / removing / swapping any
// anchor changes it. Returns undefined when the text contains no CERTIFICATE block (e.g. a
// failed fetch returned HTML), so a bogus hash is never recorded.
export function hashCaBundle(pem: unknown): string | undefined {
  if (typeof pem !== 'string') return undefined;
  const bodies: string[] = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  for (let m = re.exec(pem); m !== null; m = re.exec(pem)) {
    const body = (m[1] ?? '').replace(/\s+/g, '');
    if (body.length > 0) bodies.push(body);
  }
  if (bodies.length === 0) return undefined;
  bodies.sort();
  return createHash('sha256').update(bodies.join('\n')).digest('hex');
}

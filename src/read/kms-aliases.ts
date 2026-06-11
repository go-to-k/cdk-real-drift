// Resolve AWS-managed KMS aliases (`alias/aws/<service>`) to their concrete target
// key id, so the classifier can tell a managed-default key (declared as the alias,
// stored by AWS as the key ARN) apart from a customer-managed key swapped in out of
// band — the latter is a real, security-relevant drift the shape-only check missed.
// Listing aliases is account-wide, so one paginated ListAliases per region is enough;
// cached per region. On any error (e.g. missing kms:ListAliases) returns {} so the
// classifier falls back to the conservative shape-based match (noise, not false drift).
import { KMSClient, ListAliasesCommand } from '@aws-sdk/client-kms';
import { READ_RETRY } from './client-config.js';

const cache = new Map<string, Record<string, string>>();

export async function fetchManagedAliasTargets(region: string): Promise<Record<string, string>> {
  const cached = cache.get(region);
  if (cached) return cached;
  const out: Record<string, string> = {};
  try {
    const c = new KMSClient({ region, ...READ_RETRY });
    let marker: string | undefined;
    do {
      const r = await c.send(new ListAliasesCommand({ Marker: marker, Limit: 100 }));
      for (const a of r.Aliases ?? []) {
        if (a.AliasName?.startsWith('alias/aws/') && a.TargetKeyId)
          out[a.AliasName] = a.TargetKeyId;
      }
      marker = r.Truncated ? r.NextMarker : undefined;
    } while (marker);
  } catch {
    // no kms:ListAliases (or any error) → fall back to shape-based suppression
    return {};
  }
  cache.set(region, out);
  return out;
}

/** True when any resolved declared value in the stack references an AWS-managed KMS
 *  alias, i.e. a ListAliases prefetch is worth doing. */
export function usesManagedKmsAlias(v: unknown): boolean {
  if (typeof v === 'string') return v.startsWith('alias/aws/');
  if (Array.isArray(v)) return v.some(usesManagedKmsAlias);
  if (v && typeof v === 'object') return Object.values(v).some(usesManagedKmsAlias);
  return false;
}

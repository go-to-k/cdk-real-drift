// Resolve AWS-managed KMS aliases (`alias/aws/<service>`) to their concrete target
// key id, so the classifier can tell a managed-default key (declared as the alias,
// stored by AWS as the key ARN) apart from a customer-managed key swapped in out of
// band — the latter is a real, security-relevant drift the shape-only check missed.
// Listing aliases is account-wide, so one paginated ListAliases per region is enough;
// cached per region. On any error (e.g. missing kms:ListAliases) returns `denied: true`
// with empty targets so the classifier falls back to the conservative shape-based match
// (noise, not false drift) — but the caller WARNS, because that fallback is blind to a
// customer-key swap (it suppresses every `alias/aws/*` vs key-ARN pair). The result
// (success OR denial) is cached so a denied region is not re-queried per stack.
import { KMSClient, ListAliasesCommand } from '@aws-sdk/client-kms';
import { READ_RETRY } from './client-config.js';

export interface ManagedAliasTargets {
  targets: Record<string, string>; // alias/aws/<svc> -> target key id
  denied: boolean; // true when ListAliases failed (e.g. missing kms:ListAliases)
}

const cache = new Map<string, ManagedAliasTargets>();

export async function fetchManagedAliasTargets(region: string): Promise<ManagedAliasTargets> {
  const cached = cache.get(region);
  if (cached) return cached;
  const targets: Record<string, string> = {};
  let result: ManagedAliasTargets;
  try {
    const c = new KMSClient({ region, ...READ_RETRY });
    let marker: string | undefined;
    do {
      const r = await c.send(new ListAliasesCommand({ Marker: marker, Limit: 100 }));
      for (const a of r.Aliases ?? []) {
        if (a.AliasName?.startsWith('alias/aws/') && a.TargetKeyId)
          targets[a.AliasName] = a.TargetKeyId;
      }
      marker = r.Truncated ? r.NextMarker : undefined;
    } while (marker);
    result = { targets, denied: false };
  } catch {
    // no kms:ListAliases (or any error) → fall back to shape-based suppression
    result = { targets: {}, denied: true };
  }
  cache.set(region, result);
  return result;
}

/** The one-line warning emitted when ListAliases is denied but the stack declares an
 *  AWS-managed alias: the managed-vs-customer key check degrades to shape-only, which
 *  is BLIND to a customer-managed key swapped in for an `alias/aws/*` default. Pure +
 *  exported so the wording is unit-tested. */
export function kmsListAliasesDeniedWarning(region: string): string {
  return (
    `warning: ${region}: kms:ListAliases denied — managed-KMS-alias drift detection is degraded. ` +
    `A customer-managed key swapped in for an AWS-managed default (alias/aws/*) will NOT be detected ` +
    `(every alias/aws/* is treated as matching any live key). Grant kms:ListAliases for full coverage.`
  );
}

/** True when any resolved declared value in the stack references an AWS-managed KMS
 *  alias, i.e. a ListAliases prefetch is worth doing. */
export function usesManagedKmsAlias(v: unknown): boolean {
  if (typeof v === 'string') return v.startsWith('alias/aws/');
  if (Array.isArray(v)) return v.some(usesManagedKmsAlias);
  if (v && typeof v === 'object') return Object.values(v).some(usesManagedKmsAlias);
  return false;
}

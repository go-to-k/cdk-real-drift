// Resolve AWS-managed KMS aliases (`alias/aws/<service>`) to their concrete target
// key id, so the classifier can tell a managed-default key (declared as the alias,
// stored by AWS as the key ARN) apart from a customer-managed key swapped in out of
// band — the latter is a real, security-relevant drift the shape-only check missed.
// Listing aliases is account-wide, so one paginated ListAliases per region is enough;
// cached per region. On error returns `denied: true` with empty targets so the
// classifier falls back to the conservative shape-based match (noise, not false drift)
// — but the caller WARNS, because that fallback is blind to a customer-key swap (it
// suppresses every `alias/aws/*` vs key-ARN pair).
//
// Only DEFINITIVE outcomes are cached (#789, mirroring gather.ts's post-#754
// isManagedBySiblingStack): a success, or a definitive access-denial (missing
// kms:ListAliases). A TRANSIENT error (throttle / network blip / 5xx / timeout that
// survives adaptive retry) is NOT cached — it degrades THIS call gracefully
// (`denied: true, transient: true`) but leaves the cache empty so the NEXT stack in the
// region re-queries. Caching a transient failure would blind customer-KMS-key-swap
// detection for every subsequent stack in the region for the whole run AND misreport
// the blip as "kms:ListAliases denied", sending the user to fix IAM that isn't broken.
import { KMSClient, ListAliasesCommand } from '@aws-sdk/client-kms';
import { READ_RETRY } from './client-config.js';

export interface ManagedAliasTargets {
  targets: Record<string, string>; // alias/aws/<svc> -> target key id
  denied: boolean; // true when ListAliases failed (e.g. missing kms:ListAliases)
  transient?: boolean; // true when the failure was transient (not cached; retry next stack)
}

const cache = new Map<string, ManagedAliasTargets>();

/** True when the error is a DEFINITIVE access-denial (cacheable), NOT a transient blip.
 *  Matches an AccessDenied(Exception) / UnauthorizedOperation by name or code, or the AWS
 *  HTTP 403 status. Anything else (throttle, network, 5xx, timeout) is treated as
 *  transient and must NOT be cached. */
export function isDefinitiveDenial(err: unknown): boolean {
  const e = err as
    | { name?: string; code?: string; $metadata?: { httpStatusCode?: number } }
    | undefined;
  if (!e) return false;
  const definitive = /^(AccessDenied(Exception)?|UnauthorizedOperation)$/;
  if (e.name && definitive.test(e.name)) return true;
  if (e.code && definitive.test(e.code)) return true;
  return e.$metadata?.httpStatusCode === 403;
}

export async function fetchManagedAliasTargets(region: string): Promise<ManagedAliasTargets> {
  const cached = cache.get(region);
  if (cached) return cached;
  const targets: Record<string, string> = {};
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
    const result: ManagedAliasTargets = { targets, denied: false };
    cache.set(region, result);
    return result;
  } catch (e) {
    if (isDefinitiveDenial(e)) {
      // definitive: no kms:ListAliases → cache the denial (a denied region is not
      // re-queried per stack) and fall back to shape-based suppression.
      const result: ManagedAliasTargets = { targets: {}, denied: true };
      cache.set(region, result);
      return result;
    }
    // transient (throttle / network / 5xx / timeout): degrade THIS call gracefully but
    // do NOT cache, so the next stack in the region retries ListAliases.
    return { targets: {}, denied: true, transient: true };
  }
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

/** The one-line warning emitted when ListAliases fails TRANSIENTLY (throttle / network
 *  blip / 5xx) for a stack that declares an AWS-managed alias: the managed-vs-customer
 *  key check is degraded for THIS stack only — the error is NOT an IAM denial, and the
 *  region is not poisoned, so the next stack retries. Pure + exported so the wording is
 *  unit-tested. */
export function kmsListAliasesTransientWarning(region: string): string {
  return (
    `warning: ${region}: kms:ListAliases failed transiently (throttle/network) — ` +
    `managed-KMS-alias drift detection is degraded for THIS stack and will be retried for ` +
    `the next stack in the region. This is NOT an IAM permission problem; no action is needed.`
  );
}

/** Pure decision for the gather-time KMS warning: given a resolved ListAliases outcome
 *  and the two per-region dedupe sets' membership, decide WHICH warning to emit (if any)
 *  and WHICH set to stamp. The split is the #963 fix: a TRANSIENT failure must warn with
 *  the transient message and stamp ONLY the transient set — it must NOT stamp the
 *  permanent-denial set, or a later stack's GENUINE denial in the same region would be
 *  silenced. Transient and denied dedupe independently (separate sets) so neither masks
 *  the other. `warning` is null when nothing should print (not denied, or already warned
 *  in that region). */
export function kmsWarnDecision(
  region: string,
  resolved: Pick<ManagedAliasTargets, 'denied' | 'transient'>,
  deniedWarned: boolean,
  transientWarned: boolean
): { warning: string | null; stampDenied: boolean; stampTransient: boolean } {
  if (!resolved.denied) return { warning: null, stampDenied: false, stampTransient: false };
  if (resolved.transient) {
    // Transient blip: dedupe via the SEPARATE transient set; never touch the denial set.
    return {
      warning: transientWarned ? null : kmsListAliasesTransientWarning(region),
      stampDenied: false,
      stampTransient: !transientWarned,
    };
  }
  // Genuine denial: dedupe via the permanent-denial set.
  return {
    warning: deniedWarned ? null : kmsListAliasesDeniedWarning(region),
    stampDenied: !deniedWarned,
    stampTransient: false,
  };
}

/** True when any resolved declared value in the stack references an AWS-managed KMS
 *  alias, i.e. a ListAliases prefetch is worth doing. */
export function usesManagedKmsAlias(v: unknown): boolean {
  if (typeof v === 'string') return v.startsWith('alias/aws/');
  if (Array.isArray(v)) return v.some(usesManagedKmsAlias);
  if (v && typeof v === 'object') return Object.values(v).some(usesManagedKmsAlias);
  return false;
}

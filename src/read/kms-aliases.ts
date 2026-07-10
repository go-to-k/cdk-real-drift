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

// #704: some resource types read back an UNDECLARED encryption-key property whose default
// is the account/region AWS-managed service key (`alias/aws/<service>`), stored by AWS as a
// full key ARN. These are folded value-independent (GENERATED_NESTED_PATHS) — which HID an
// out-of-band swap to a customer-managed key (a security-relevant, MUTABLE change: DynamoDB
// SSE is changeable via `UpdateTable --sse-specification`, unlike RDS's create-only KmsKeyId).
// This table maps each such (resourceType, nested schema path) to the AWS-managed alias whose
// resolved key ARN is the fold-eligible default. The classifier gates the value-independent
// fold against the resolved managed key: it folds ONLY when the live key IS that managed key,
// and SURFACES any other value (a CMK). Fail OPEN (keep folding) when the alias can't be
// resolved (no ListAliases / denied / transient) — biased to noise, never a new false positive.
export const MANAGED_KEY_ALIAS_PATHS: Record<string, Record<string, string>> = {
  // A DynamoDB table with `SSESpecification.SSEEnabled: true` and no explicit KMS key reads
  // back `SSESpecification.KMSMasterKeyId` = the account's AWS-managed `alias/aws/dynamodb`
  // key ARN. Only that managed key is the default to fold; a CMK swapped in surfaces.
  'AWS::DynamoDB::Table': { 'SSESpecification.KMSMasterKeyId': 'alias/aws/dynamodb' },
  // GlobalTable's per-replica twin (same managed key, nested under Replicas.*).
  'AWS::DynamoDB::GlobalTable': {
    'Replicas.*.SSESpecification.KMSMasterKeyId': 'alias/aws/dynamodb',
  },
  // An OpenSearch domain with encryption-at-rest enabled and no explicit KMS key reads back
  // `EncryptionAtRestOptions.KmsKeyId` = the account's AWS-managed `alias/aws/es` key.
  'AWS::OpenSearchService::Domain': { 'EncryptionAtRestOptions.KmsKeyId': 'alias/aws/es' },
};

// Match live key values to a managed-key ARN: the live value is a full key ARN
// (`arn:aws:kms:...:key/<id>`); the alias TargetKeyId from ListAliases is a bare key id.
// Compare on the trailing key-id segment so both forms line up.
const keyIdOf = (s: string): string => s.slice(s.lastIndexOf('/') + 1);

/** #704 fold decision for an UNDECLARED managed-service-key nested path (DynamoDB SSE,
 *  OpenSearch EncryptionAtRest). Returns whether the value-independent fold should still
 *  apply for this live value:
 *   - `true`  → FOLD (atDefault): the live key IS the account/region AWS-managed key, OR the
 *               alias could not be resolved (fail OPEN — no ListAliases / denied / transient).
 *   - `false` → SURFACE (undeclared): the live key is some OTHER key (a customer-managed key
 *               swapped in out of band — a real, security-relevant drift).
 *  Pure; `aliasTargets` is the resolved alias-name -> target-key-id map (empty when unresolved).*/
export function shouldFoldManagedServiceKey(
  resourceType: string,
  schemaPath: string,
  liveValue: unknown,
  aliasTargets?: Record<string, string>
): boolean {
  const alias = MANAGED_KEY_ALIAS_PATHS[resourceType]?.[schemaPath];
  if (!alias) return false; // not a managed-key path — caller shouldn't gate it here
  const target = aliasTargets?.[alias];
  // Fail OPEN: alias unresolved (no ListAliases / denied / transient / not in this account) →
  // keep folding, preserving today's value-independent behavior (no new false positive).
  if (!target) return true;
  // A non-string live value can't be compared to a key ARN → fold (unchanged behavior).
  if (typeof liveValue !== 'string') return true;
  // Strict: fold ONLY when the live key resolves to the SAME managed key; any other key surfaces.
  return keyIdOf(liveValue) === keyIdOf(target);
}

/** #704: True when a resource TYPE has an UNDECLARED managed-service-key nested path
 *  (DynamoDB SSE, OpenSearch EncryptionAtRest) whose value-independent fold must be gated
 *  against the resolved AWS-managed key — so a ListAliases prefetch is worth doing even when
 *  NO `alias/aws/*` is DECLARED. gather.ts's prefetch trigger should OR this in alongside the
 *  declared-alias check (`usesManagedKmsAlias`) so the LIVE-only managed-key path is resolvable.
 */
export function typeNeedsManagedKeyResolution(resourceType: string): boolean {
  return resourceType in MANAGED_KEY_ALIAS_PATHS;
}

/** True when any resolved declared value in the stack references an AWS-managed KMS
 *  alias, i.e. a ListAliases prefetch is worth doing. */
export function usesManagedKmsAlias(v: unknown): boolean {
  if (typeof v === 'string') return v.startsWith('alias/aws/');
  if (Array.isArray(v)) return v.some(usesManagedKmsAlias);
  if (v && typeof v === 'object') return Object.values(v).some(usesManagedKmsAlias);
  return false;
}

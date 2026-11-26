// Classify "this CloudFormation stack is not deployed (yet)" errors. Synth-based
// stack discovery can surface a stack that exists in the CDK code but has not been
// deployed (new stack, renamed stack, different region) — that is not an error, it
// just means there is nothing to drift-check.
export function isStackNotDeployed(e: unknown): boolean {
  // A failed `--assume-role` is never "not deployed": its STS message is free text and
  // must not be pattern-matched into a benign skip of a stack nobody could read.
  if (e instanceof AssumeRoleError) return false;
  const msg = (e as { message?: string })?.message ?? String(e);
  return /does not exist/i.test(msg) || (/ValidationError/i.test(msg) && /stack/i.test(msg));
}

// #1971: `--assume-role` could not produce credentials for a stack — the role ARN could not
// be resolved (`{account}` with no account to fill it) or sts:AssumeRole failed. The
// message names the ARN so a CI log says WHICH role to fix; the verb reports it as that
// stack's error (exit 2) and moves on.
export class AssumeRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssumeRoleError';
  }
}

// A stack that EXISTS but is in a state with no meaningful deployed reality to compare
// against — REVIEW_IN_PROGRESS (a change set was created but never executed; nothing is
// deployed) or a delete in progress. loadDesired throws this so `check` SKIPS it with a
// clear note instead of silently comparing live state against a template that was never
// deployed (which would read as a meaningless CLEAN).
export class StackNotCheckableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StackNotCheckableError';
  }
}

// Classify a CloudFormation StackStatus for checkability:
//   skip — REVIEW_IN_PROGRESS (change set never deployed), DELETE_IN_PROGRESS, or
//          ROLLBACK_COMPLETE (a failed initial CREATE rolled back — CloudFormation has
//          DELETED every resource, so there is no deployed reality to compare): comparing
//          is nonsense (loadDesired throws).
//   warn — any OTHER `*_IN_PROGRESS` (mid-operation: live state in flux) or `*_FAILED`
//          (the deployed template may not match live reality): the comparison runs but
//          results may be transient/unreliable, so `check` prints a warning.
//   ok   — a stable `*_COMPLETE` state (incl. UPDATE_ROLLBACK_COMPLETE / IMPORT_COMPLETE):
//          a valid comparison. NB: UPDATE_ROLLBACK_COMPLETE is `ok` — it keeps a deployed
//          reality (a prior successful create) — but ROLLBACK_COMPLETE is `skip` (its
//          resources were all deleted by the rollback). Pure + exported for tests.
export function classifyStackStatus(status: string | undefined): {
  kind: 'ok' | 'skip' | 'warn';
  message: string;
} {
  const s = status ?? '';
  if (s === 'REVIEW_IN_PROGRESS')
    return {
      kind: 'skip',
      message:
        'in REVIEW_IN_PROGRESS — a change set was created but never deployed, so there is no deployed state to check',
    };
  if (s === 'DELETE_IN_PROGRESS')
    return {
      kind: 'skip',
      message: 'is being deleted (DELETE_IN_PROGRESS) — nothing stable to check',
    };
  // ROLLBACK_COMPLETE is reachable ONLY after a failed INITIAL create + rollback:
  // CloudFormation has deleted every resource, so there is no deployed reality to
  // compare against (checking would report every resource as deleted out of band).
  // Distinct from UPDATE_ROLLBACK_COMPLETE (a failed UPDATE rolled back to the prior
  // deployed state — that keeps a real deployed reality and stays `ok`).
  if (s === 'ROLLBACK_COMPLETE')
    return {
      kind: 'skip',
      message:
        'in ROLLBACK_COMPLETE — the initial create failed and rolled back, deleting every resource, so there is no deployed state to check; delete and re-deploy',
    };
  if (s.endsWith('_IN_PROGRESS'))
    return {
      kind: 'warn',
      message: `stack is mid-operation (${s}) — live state is in flux, so drift results may be transient`,
    };
  if (s.endsWith('_FAILED'))
    return {
      kind: 'warn',
      message: `stack is in a failed state (${s}) — the deployed template may not match live reality, so drift results may be unreliable`,
    };
  return { kind: 'ok', message: '' };
}

// "the resource itself no longer exists in AWS" — i.e. it was deleted out of band.
// Covers Cloud Control GetResource + every SDK-override reader's not-found error:
//   CC API / Lambda     : ResourceNotFoundException
//   S3                  : NoSuchBucket / NoSuchBucketPolicy
//   SQS                 : AWS.SimpleQueueService.NonExistentQueue / QueueDoesNotExist
//   SNS / Budgets       : NotFoundException
//   IAM                 : NoSuchEntity / NoSuchEntityException
//   EC2 EIP             : InvalidAllocationID.NotFound / InvalidAddress.NotFound
//   EC2 LaunchTemplate  : InvalidLaunchTemplateId.NotFound (deleted launch template)
//   EC2 NetworkAcl      : InvalidNetworkAclID.NotFound (NACL of a NetworkAclEntry deleted)
//   EC2 ClientVPN       : InvalidClientVpnEndpointId.NotFound (endpoint of a deleted
//                         Client VPN endpoint — its Describe{AuthorizationRules,TargetNetworks} children)
//   Glue                : EntityNotFoundException (GetTable on a deleted table/db)
//   DMS                 : ResourceNotFoundFault (Describe{Endpoints,ReplicationSubnetGroups})
//   DAX                 : ClusterNotFoundFault / ParameterGroupNotFoundFault /
//                         SubnetGroupNotFoundFault (Describe{Clusters,ParameterGroups,SubnetGroups})
//   ElastiCache         : CacheParameterGroupNotFoundFault (DescribeCacheParameterGroups)
//   Route53             : NoSuchHostedZone (ListResourceRecordSets on a deleted hosted zone)
//   cdkrd ResourceGoneError : a list/describe-based override whose PARENT container
//                             exists but whose specific keyed resource is absent (a
//                             Route53 record / MetricFilter deleted while its zone /
//                             log group survives) — the SDK returns success+empty, not
//                             a throw, so the reader raises this to mean "deleted".
// Distinct from "target not resolvable from the template" (override returns
// undefined → skipped) — this means the resource was read for and is gone.
const NOT_FOUND_ERROR_NAMES = new Set([
  'ResourceNotFoundException',
  'NoSuchBucket',
  'NoSuchBucketPolicy',
  'QueueDoesNotExist',
  'AWS.SimpleQueueService.NonExistentQueue',
  'NotFoundException',
  'NoSuchEntity',
  'NoSuchEntityException',
  'InvalidAllocationID.NotFound',
  'InvalidAddress.NotFound',
  // EC2 DescribeLaunchTemplateVersions on a deleted launch template (readEc2LaunchTemplate).
  'InvalidLaunchTemplateId.NotFound',
  // EC2 DescribeNetworkAcls on a deleted NACL (readEc2NetworkAclEntry's parent NACL).
  'InvalidNetworkAclID.NotFound',
  // EC2 ClientVPN DescribeClientVpnAuthorizationRules / DescribeClientVpnTargetNetworks on a
  // deleted Client VPN endpoint (#534 added the readers, #966 folds their not-found → deleted).
  // The association code (InvalidClientVpnAssociationId.NotFound) is a live-probe follow-up:
  // unconfirmed against the AWS docs, so left out until a real probe surfaces it.
  'InvalidClientVpnEndpointId.NotFound',
  'EntityNotFoundException',
  // DocumentDB describe-db-clusters / describe-db-instances on a deleted target.
  'DBClusterNotFoundFault',
  'DBInstanceNotFoundFault',
  // DMS DescribeEndpoints / DescribeReplicationSubnetGroups on a deleted target.
  'ResourceNotFoundFault',
  // DAX DescribeClusters / DescribeParameterGroups / DescribeSubnetGroups on a deleted target.
  'ClusterNotFoundFault',
  'ParameterGroupNotFoundFault',
  'SubnetGroupNotFoundFault',
  // ElastiCache DescribeCacheParameterGroups on a deleted parameter group.
  'CacheParameterGroupNotFoundFault',
  // Route53 ListResourceRecordSets when the record's hosted ZONE was deleted out of band.
  'NoSuchHostedZone',
  // Cloud Map (ServiceDiscovery) GetNamespace / GetService on a deleted target.
  'NamespaceNotFound',
  'ServiceNotFound',
  // SES DescribeReceiptRuleSet / DescribeReceiptRule on a deleted inbound rule set / rule.
  'RuleSetDoesNotExistException',
  'RuleDoesNotExistException',
  'ResourceGoneError',
]);

// Raised by a list/describe-based SDK-override reader when the parent container was
// queried successfully but the specific keyed resource is ABSENT — i.e. it was deleted
// out of band (the AWS API returns success with the item missing, not a not-found
// throw). The router maps this (via isResourceNotFoundError) to the `deleted` tier, the
// same as a native not-found error. NOT used for "couldn't resolve the target from the
// template" — that case returns undefined → `skipped`.
export class ResourceGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceGoneError';
  }
}

export function isResourceNotFoundError(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? '';
  if (NOT_FOUND_ERROR_NAMES.has(name)) return true;
  const code = (e as { Code?: string })?.Code ?? '';
  return NOT_FOUND_ERROR_NAMES.has(code);
}

/**
 * The stderr line for an error that escaped a verb (src/cli.ts' top-level catch). Pure so it
 * is testable — cli.ts runs main() on import. An AssumeRoleError passes through verbatim: it
 * names the role and the fix, and its STS text ("security token", "not authorized") would
 * otherwise be rewritten into the generic credentials / access-denied hints, dropping both.
 */
export function topLevelErrorMessage(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e);
  if (e instanceof AssumeRoleError) return `error: ${msg}`;
  if (/credential|could not load cred|security token/i.test(msg))
    return 'error: no AWS credentials available. Configure them (aws configure / AWS_PROFILE / env vars) and retry.';
  if (/stack/i.test(msg) && /(does not exist|ValidationError)/i.test(msg))
    return 'error: stack not found in this account/region. Check the stack name and --region.';
  if (/AccessDenied|not authorized/i.test(msg)) return `error: access denied — ${msg}`;
  return `error: ${msg}`;
}

// Classify "this CloudFormation stack is not deployed (yet)" errors. Synth-based
// stack discovery can surface a stack that exists in the CDK code but has not been
// deployed (new stack, renamed stack, different region) — that is not an error, it
// just means there is nothing to drift-check.
export function isStackNotDeployed(e: unknown): boolean {
  const msg = (e as { message?: string })?.message ?? String(e);
  return /does not exist/i.test(msg) || (/ValidationError/i.test(msg) && /stack/i.test(msg));
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
//   skip — REVIEW_IN_PROGRESS (change set never deployed) or DELETE_IN_PROGRESS: no
//          meaningful deployed reality, so comparing is nonsense (loadDesired throws).
//   warn — any OTHER `*_IN_PROGRESS` (mid-operation: live state in flux) or `*_FAILED`
//          (the deployed template may not match live reality): the comparison runs but
//          results may be transient/unreliable, so `check` prints a warning.
//   ok   — a stable `*_COMPLETE` state (incl. ROLLBACK_COMPLETE / IMPORT_COMPLETE): a
//          valid comparison. Pure + exported for tests.
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
//   Glue                : EntityNotFoundException (GetTable on a deleted table/db)
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
  'EntityNotFoundException',
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

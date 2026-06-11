// Classify "this CloudFormation stack is not deployed (yet)" errors. Synth-based
// stack discovery can surface a stack that exists in the CDK code but has not been
// deployed (new stack, renamed stack, different region) — that is not an error, it
// just means there is nothing to drift-check.
export function isStackNotDeployed(e: unknown): boolean {
  const msg = (e as { message?: string })?.message ?? String(e);
  return /does not exist/i.test(msg) || (/ValidationError/i.test(msg) && /stack/i.test(msg));
}

// "the resource itself no longer exists in AWS" — i.e. it was deleted out of band.
// Covers Cloud Control GetResource + every SDK-override reader's not-found error:
//   CC API / Lambda     : ResourceNotFoundException
//   S3                  : NoSuchBucket / NoSuchBucketPolicy
//   SQS                 : AWS.SimpleQueueService.NonExistentQueue / QueueDoesNotExist
//   SNS / Budgets       : NotFoundException
//   IAM                 : NoSuchEntity / NoSuchEntityException
//   EC2 EIP             : InvalidAllocationID.NotFound / InvalidAddress.NotFound
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
]);

export function isResourceNotFoundError(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? '';
  if (NOT_FOUND_ERROR_NAMES.has(name)) return true;
  const code = (e as { Code?: string })?.Code ?? '';
  return NOT_FOUND_ERROR_NAMES.has(code);
}

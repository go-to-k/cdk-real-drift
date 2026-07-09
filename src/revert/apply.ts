// Apply a revert via Cloud Control API — UpdateResource (RFC6902 patch) for a
// property revert, or DeleteResource for an `added` out-of-band resource — polling the
// async request to completion. This is the only AWS-MUTATING path in cdkrd.
import {
  type CloudControlClient,
  DeleteResourceCommand,
  GetResourceRequestStatusCommand,
  type ProgressEvent,
  UpdateResourceCommand,
} from '@aws-sdk/client-cloudcontrol';
import { type RevertItem, toPatchDocument } from './plan.js';
import { errorText, type RetryOptions, retryTransient } from './transient.js';

export interface ApplyResult {
  ok: boolean;
  error?: string;
  // Set when the FINAL failure (after bounded retries) is a transient "resource is
  // mid-update" class — carries a targeted hint for the report layer (issue #467).
  transient?: boolean;
  hint?: string;
}

const POLL_INTERVAL_MS = 2000;
// Generous ceiling: Cloud Control operations on stateful resources legitimately take
// many minutes (e.g. deleting an RDS DBInstance is ~5-10 min). pollToCompletion returns
// as soon as the operation reaches a terminal state, so a high ceiling never slows the
// common case — it only bounds how long we wait on an operation that never terminates.
const TIMEOUT_MS = 15 * 60 * 1000;

// A DELETE whose target is ALREADY absent is the goal state, not a failure. Two ways
// this happens for an `added`-resource revert: (1) deleting an API Gateway Resource
// CASCADE-deletes its child Resources/Methods — and each added child is an independent
// finding applied in unspecified order, so a later DeleteResource on a child can race
// the cascade; (2) the user removed it between `check` and `revert`. Cloud Control
// surfaces an absent target as ResourceNotFoundException (thrown) or a FAILED event
// whose message says not-found. Treat both as success so a revert that REACHES the
// goal state isn't reported as FAILED (which would also wrongly bump the exit code).
export function isAlreadyGone(e: unknown): boolean {
  const o = (e ?? {}) as { name?: unknown; message?: unknown };
  const name = typeof o.name === 'string' ? o.name : '';
  if (name === 'ResourceNotFoundException' || name === 'NotFoundException') return true;
  const m = (typeof o.message === 'string' ? o.message : '').toLowerCase();
  return m.includes('not found') || m.includes('does not exist') || m.includes('notfound');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Poll a Cloud Control ProgressEvent (Update or Delete) to a terminal state.
async function pollToCompletion(
  cc: CloudControlClient,
  first: ProgressEvent | undefined
): Promise<ApplyResult> {
  let event = first;
  const token = event?.RequestToken;
  if (!token) return { ok: false, error: 'no request token returned' };
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = event?.OperationStatus;
    if (status === 'SUCCESS') return { ok: true };
    if (status === 'FAILED' || status === 'CANCEL_COMPLETE') {
      // StatusMessage carries the service code (e.g. RSLVR-00705) for transient
      // classification; ErrorCode is a coarser CC enum, appended when present.
      const msg = event?.StatusMessage ?? status;
      const code = event?.ErrorCode;
      return { ok: false, error: code && !msg.includes(code) ? `${code}: ${msg}` : msg };
    }
    await sleep(POLL_INTERVAL_MS);
    const polled = await cc.send(new GetResourceRequestStatusCommand({ RequestToken: token }));
    event = polled.ProgressEvent;
  }
  return { ok: false, error: 'timed out waiting for Cloud Control request' };
}

export async function applyRevertItem(
  cc: CloudControlClient,
  item: RevertItem,
  // The Cloud Control resource identifier. Defaults to the CFn physical id, but
  // composite-identifier types (e.g. AWS::ECS::Service = `${ServiceArn}|${Cluster}`)
  // need the same adapted identifier the READ path uses — the caller resolves it via
  // CC_IDENTIFIER_ADAPTERS and passes it here, else UpdateResource ValidationExceptions.
  identifier: string = item.physicalId,
  // Bounded-backoff retry knobs (issue #467) — tests inject a no-op sleep.
  retry: RetryOptions = {}
): Promise<ApplyResult> {
  // Retry ONLY transient "resource is mid-update" failures (RSLVR-00705 & friends);
  // a terminal ValidationException returns on the first attempt.
  return retryTransient(async () => {
    try {
      const res = await cc.send(
        new UpdateResourceCommand({
          TypeName: item.resourceType,
          Identifier: identifier,
          PatchDocument: toPatchDocument(item),
        })
      );
      return await pollToCompletion(cc, res.ProgressEvent);
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  }, retry);
}

// Per-item outcome of a batch delete pass (issue #765). Carries the source item so the
// caller can fold the result back into its own state (failedDeleteIds / applied / worst)
// exactly as the inline single-item path does.
export interface BatchDeleteOutcome<T> {
  item: T;
  result: ApplyResult;
}

// Apply a batch of `delete`-kind revert items with DEPENDENCY-AWARE retry (issue #765).
//
// Deleting out-of-band `added` resources in an arbitrary order can fail on a
// DependencyViolation: a resource can only be deleted AFTER the resource that depends on
// it is gone (e.g. a security group still referenced by an ENI, an API Gateway parent
// Resource whose child Methods are also queued for deletion). A single pass in the wrong
// order leaves such an item stuck as FAILED even though it WOULD succeed once its
// dependent siblings are deleted.
//
// Strategy: run a FIRST pass over all delete items, collecting the still-failed ones.
// Then, while the LAST pass deleted >=1 item AND some remain failed, run another pass
// over only the still-failed items — a freed dependency can now succeed. Bounded by
// `deleteItems.length` total passes (each pass must clear >=1 item to continue, so at
// most N passes) with an explicit no-progress break, guaranteeing termination.
//
// Behavior is IDENTICAL to a single inline pass when there are 0 failures (one pass, all
// succeed) or 0 progress (one pass, the still-failed set never shrinks so no retry runs).
// `applyOne` performs ONE delete (reusing applyRevertDelete semantics, incl. isAlreadyGone
// already-gone tolerance) and returns its ApplyResult. Results are returned in the SAME
// order as `deleteItems` so the caller's output/state folding is deterministic.
export async function applyRevertDeletes<T>(
  deleteItems: readonly T[],
  applyOne: (item: T) => Promise<ApplyResult>
): Promise<BatchDeleteOutcome<T>[]> {
  // Latest result per item, keyed by array index (stable + preserves input order).
  const results = new Map<number, ApplyResult>();
  let pending = deleteItems.map((item, index) => ({ item, index }));

  // First pass + bounded retry passes. Total passes capped at deleteItems.length: each
  // continuing pass must have cleared >=1 item, so N items settle in at most N passes.
  const maxPasses = Math.max(1, deleteItems.length);
  for (let pass = 0; pass < maxPasses && pending.length > 0; pass++) {
    const stillFailed: typeof pending = [];
    for (const p of pending) {
      const r = await applyOne(p.item);
      results.set(p.index, r);
      if (!r.ok) stillFailed.push(p);
    }
    // No progress this pass (nothing cleared) → retrying cannot help; stop.
    if (stillFailed.length === pending.length) break;
    pending = stillFailed;
  }

  return deleteItems.map((item, index) => ({
    item,
    // Every index is populated: the loop runs at least one pass over every item.
    result: results.get(index) ?? { ok: false, error: 'delete not attempted' },
  }));
}

// DELETE an `added` (out-of-band) resource via Cloud Control DeleteResource. The
// identifier is the resource's CC primaryIdentifier (for API Gateway children, the
// `RestApiId|ResourceId[|HttpMethod]` composite already carried on the finding).
export async function applyRevertDelete(
  cc: CloudControlClient,
  item: RevertItem,
  identifier: string = item.physicalId,
  retry: RetryOptions = {}
): Promise<ApplyResult> {
  // Same transient-retry wrapper as the update path: a DeleteResource can also hit a
  // "resource is currently updating / in use" window and settle on a retry.
  return retryTransient(async () => {
    try {
      const res = await cc.send(
        new DeleteResourceCommand({ TypeName: item.resourceType, Identifier: identifier })
      );
      const result = await pollToCompletion(cc, res.ProgressEvent);
      // already-gone surfaced as a FAILED event (vs a thrown error, handled below)
      if (!result.ok && isAlreadyGone({ message: result.error })) return { ok: true };
      return result;
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (isAlreadyGone(err)) return { ok: true };
      return { ok: false, error: errorText(e) };
    }
  }, retry);
}

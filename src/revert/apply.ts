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
import { classifyTransient, errorText, type RetryOptions, retryTransient } from './transient.js';

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
// A GetResourceRequestStatus poll-read can fail TRANSIENTLY (throttling / network / 5xx)
// while the UpdateResource/DeleteResource it is observing is still running server-side.
// That poll failure is NOT an operation failure — retry the POLL with the SAME request
// token rather than letting it bubble to retryTransient, which would RE-SEND the whole
// mutation while the first op is still in flight (#1064). Bound the consecutive poll
// failures so a PERSISTENT poll outage still terminates (the mutating client already
// retries each send internally, so each throw here follows several SDK attempts).
const MAX_POLL_READ_FAILURES = 10;

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

// A delete failure whose blocker is ANOTHER resource still present — the resource can
// only be deleted after its dependent sibling is gone (#765/#969). In a delete BATCH the
// blocker is almost always INTERNAL to the plan (a sibling `added`-delete queued later),
// so time alone never fixes it — only the next `applyRevertDeletes` pass, once the sibling
// is deleted, does. Such an error MUST NOT burn the per-item transient retry budget: the
// generic transient patterns (`ConflictException`, `resource is in use`, …) classify it
// TRANSIENT, so an in-item `retryTransient` would spin its full backoff / `--wait` deadline
// against a blocker the pass loop is designed to clear for free (the exact #969 blowup —
// a wrong-ordered Route→Integration pair burning a guaranteed-futile 10-minute `--wait`).
// Deferring it to the pass loop is a NO-COST fail-fast; a genuine throttle (below) still
// gets its in-item retry. Matches the DependencyViolation code (EC2/ELB/etc.) plus the
// cross-service "still referenced / still in use / cannot delete because …" phrasings and
// ApiGatewayV2's ConflictException "referenced by" form for the #765 child-delete pairs.
export function isDependencyViolation(error: string | undefined): boolean {
  if (!error) return false;
  return /DependencyViolation|dependent object|still (in use|referenced|being used|depends on|contains|has (a |an |dependent |associated ))|cannot (be )?delete[d]?[^.]*because[^.]*(referenced|in use|dependent|attached|associated|member|child)|is (still )?(referenced|attached|associated|in use)/i.test(
    error
  );
}

// Internal sentinel: a dependency-violation delete swaps its (transient-CLASSIFIED) error
// for this string so retryTransient sees a TERMINAL failure and returns immediately without
// retrying/sleeping. Deliberately worded to match NONE of transient.ts's TRANSIENT_PATTERNS.
// Never surfaced to the user — the real error is restored before applyRevertDelete returns.
const DEP_VIOLATION_TERMINAL = 'dependency-violation deferred to delete-batch pass loop';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Poll a Cloud Control ProgressEvent (Update or Delete) to a terminal state. `sleep`/`now`
// are injectable so tests exercise the poll loop without real 2s waits.
async function pollToCompletion(
  cc: CloudControlClient,
  first: ProgressEvent | undefined,
  poll: Pick<RetryOptions, 'sleep' | 'now'> = {}
): Promise<ApplyResult> {
  const doSleep = poll.sleep ?? sleep;
  const clock = poll.now ?? Date.now;
  let event = first;
  const token = event?.RequestToken;
  if (!token) return { ok: false, error: 'no request token returned' };
  const deadline = clock() + TIMEOUT_MS;
  // Consecutive transient poll-read failures (reset on any successful read).
  let pollFailures = 0;
  while (clock() < deadline) {
    const status = event?.OperationStatus;
    if (status === 'SUCCESS') return { ok: true };
    if (status === 'FAILED' || status === 'CANCEL_COMPLETE') {
      // StatusMessage carries the service code (e.g. RSLVR-00705) for transient
      // classification; ErrorCode is a coarser CC enum, appended when present.
      const msg = event?.StatusMessage ?? status;
      const code = event?.ErrorCode;
      return { ok: false, error: code && !msg.includes(code) ? `${code}: ${msg}` : msg };
    }
    await doSleep(POLL_INTERVAL_MS);
    try {
      const polled = await cc.send(new GetResourceRequestStatusCommand({ RequestToken: token }));
      event = polled.ProgressEvent;
      pollFailures = 0;
    } catch (e) {
      // A poll-read error, NOT an operation failure — the mutation is still in flight.
      const text = errorText(e);
      // A terminal poll error (e.g. an invalid/expired RequestToken) cannot be resolved
      // by re-reading: return it as a NON-transient failure so retryTransient does not
      // re-send the mutation. Keep polling the SAME token only for transient poll errors.
      if (!classifyTransient(text).transient) return { ok: false, error: text };
      if (++pollFailures >= MAX_POLL_READ_FAILURES) {
        // Persistent poll outage: the operation likely converged (or is still running) —
        // do NOT re-send it. Report a NON-transient failure — the message deliberately
        // omits the raw poll error's transient keyword (e.g. "Throttling") so retryTransient
        // classifies it terminal and does NOT re-send the mutation; the next `check`
        // re-reads the true state. #1064: better a stale FAILED than a duplicate AWS
        // mutation racing the in-flight op.
        return {
          ok: false,
          error: `unable to confirm Cloud Control request status after ${MAX_POLL_READ_FAILURES} poll attempts (mutation NOT resent, to avoid a duplicate write)`,
        };
      }
      // else: re-poll the same request token (event unchanged → still non-terminal).
    }
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
      return await pollToCompletion(cc, res.ProgressEvent, retry);
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
  // ONE DeleteResource send + poll. Self-contained (catches its own throws) so it can be
  // re-invoked verbatim by the transient retry — same contract retryTransient requires.
  const oneDelete = async (): Promise<ApplyResult> => {
    try {
      const res = await cc.send(
        new DeleteResourceCommand({ TypeName: item.resourceType, Identifier: identifier })
      );
      const result = await pollToCompletion(cc, res.ProgressEvent, retry);
      // already-gone surfaced as a FAILED event (vs a thrown error, handled below)
      if (!result.ok && isAlreadyGone({ message: result.error })) return { ok: true };
      return result;
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (isAlreadyGone(err)) return { ok: true };
      return { ok: false, error: errorText(e) };
    }
  };

  return retryDeleteDeferringDependencies(oneDelete, retry);
}

// Shared retry driver for ONE delete attempt-function (the CC path above and the SDK path
// below) — a DEPENDENCY-VIOLATION failure (#969) must NOT burn the in-item transient-retry
// budget. In a delete BATCH the blocker is a sibling delete queued later in the SAME pass, so
// time (and the `--wait` deadline) can never free it — only the next applyRevertDeletes pass,
// after that sibling is deleted, does. It must fail FAST back to the pass loop (the pass IS
// the retry) rather than spin its private backoff / `--wait` deadline on a guaranteed-futile
// wait (the #969 blowup: a wrong-ordered Route→Integration pair burning a full 10-minute
// `--wait` before the Route even runs). The generic transient patterns classify a
// dependency error TRANSIENT (`ConflictException`, `resource is in use`, …), so we can't let
// retryTransient see the raw text. Wrap the op: on a dependency violation, stash the real
// error and hand retryTransient a TERMINAL-classified sentinel so it returns immediately
// (no retry, no sleep); a genuine transient (throttle / mid-update) still flows through with
// the full backoff / `--wait` semantics unchanged. This keeps retryTransient the single
// driver of backoff/deadline/onRetry — no duplicated retry math, no double send.
async function retryDeleteDeferringDependencies(
  oneDelete: () => Promise<ApplyResult>,
  retry: RetryOptions
): Promise<ApplyResult> {
  let deferredDepError: string | undefined;
  const guardedDelete = async (): Promise<ApplyResult> => {
    const r = await oneDelete();
    if (!r.ok && isDependencyViolation(r.error)) {
      deferredDepError = r.error;
      return { ok: false, error: DEP_VIOLATION_TERMINAL };
    }
    return r;
  };
  const r = await retryTransient(guardedDelete, retry);
  // Restore the real dependency-violation text for the caller (the pass loop folds it back).
  // deferredDepError is always set when the sentinel appears (guardedDelete sets it in the
  // same call that returns the sentinel); fall back defensively to the sentinel otherwise.
  if (!r.ok && r.error === DEP_VIOLATION_TERMINAL) {
    return { ok: false, error: deferredDepError ?? DEP_VIOLATION_TERMINAL };
  }
  return r;
}

// DELETE an `added` resource via a type-specific SDK deleter (#1386) — for a type Cloud
// Control cannot delete (AWS::AppSync::ApiKey: DeleteResource throws
// UnsupportedActionException). `doDelete` is the bound SDK call (a revert/writers.ts
// SDK_DELETERS entry with its context already threaded by the caller); this wrapper gives it
// the SAME contract as the Cloud Control applyRevertDelete: an already-gone target is the
// goal state (success, not failure), a dependency-violation failure defers to the
// applyRevertDeletes pass loop without burning the transient budget, and a genuine transient
// gets the full retryTransient backoff / `--wait` semantics. An SDK delete is synchronous
// (the send IS the terminal state) so there is no ProgressEvent poll.
export async function applyRevertDeleteSdk(
  doDelete: () => Promise<void>,
  retry: RetryOptions = {}
): Promise<ApplyResult> {
  const oneDelete = async (): Promise<ApplyResult> => {
    try {
      await doDelete();
      return { ok: true };
    } catch (e) {
      if (isAlreadyGone(e)) return { ok: true };
      return { ok: false, error: errorText(e) };
    }
  };
  return retryDeleteDeferringDependencies(oneDelete, retry);
}

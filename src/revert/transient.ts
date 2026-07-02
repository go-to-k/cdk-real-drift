// Cross-service classification of TRANSIENT "the resource is mid-operation, retry
// later" revert failures — as opposed to terminal validation/permission/state errors.
//
// The motivating case (issue #467): after an out-of-band `route53resolver
// update-resolver-rule`, the rule stays `Status: UPDATING` for minutes (async
// propagation to endpoint ENIs). A `cdkrd revert` issued in that window fails with
//   [RSLVR-00705] Cannot update Resolver Rule because it's currently updating.
// That is not a real failure — a later revert succeeds. The whole class (concurrent
// modification, throttling, "another operation in progress") is retry-then-hint
// material, not generic-FAILED material.
//
// We only have the error TEXT to work with (Cloud Control surfaces async failures as a
// FAILED ProgressEvent StatusMessage; thrown SDK errors are caught to a message string).
// `errorText` prepends the error `name`/`code` so name-only signals (e.g.
// `ThrottlingException`) survive into the string the classifier matches on.

// Verdict for a single error string.
export interface TransientVerdict {
  transient: boolean;
  // A short human-facing explanation, shown once retries are exhausted (hybrid UX:
  // bounded backoff first, then this hint instead of a bare `FAILED: … — <raw error>`).
  hint?: string;
}

const RETRY_HINT = 'the resource is still applying a previous update — retry in a few minutes';
const THROTTLE_HINT = 'AWS throttled the request — retry shortly';

// First match wins. Patterns match against `errorText` (case-insensitive). Keep this
// focused on the genuinely-transient class: a false positive here turns a permanent
// failure into wasted backoff + a misleading "retry later" hint, so err toward
// specificity (service codes, unambiguous phrases) over broad substrings.
const TRANSIENT_PATTERNS: readonly { pattern: RegExp; hint: string }[] = [
  // Route53Resolver rule/endpoint mid-update (async ENI propagation).
  {
    pattern: /RSLVR-00705|currently updating/i,
    hint:
      'the resource is still applying a previous update (async propagation) — ' +
      'retry in a few minutes',
  },
  // Generic concurrent-modification / operation-in-progress across services
  // (e.g. ConcurrentModificationException, OperationInProgressException,
  // ResourceConflictException/ConflictException) plus Cloud Control's bare
  // HandlerErrorCode forms (ResourceConflict, NetworkFailure, InternalFailure,
  // ServiceInternalError) surfaced on a FAILED ProgressEvent.
  {
    pattern:
      /ConcurrentModificationException|OperationInProgressException|OperationAbortedException|ResourceConflictException|ConflictException|\bResourceConflict\b|\bNetworkFailure\b|\bInternalFailure\b|\bServiceInternalError\b/i,
    hint: RETRY_HINT,
  },
  {
    pattern:
      /another (operation|update|change|request)[^.]*in progress|operation[^.]*(already )?in progress|update[^.]*in progress|modification[^.]*in progress|currently being (created|updated|modified|deleted|provisioned)|is not in a stable state|resource is in use|please try again|try again (later|in a few)/i,
    hint: RETRY_HINT,
  },
  // Throttling / rate limiting — retryable, but a distinct hint.
  {
    pattern:
      /ThrottlingException|ThrottledException|TooManyRequestsException|RequestThrottled|RequestLimitExceeded|ServiceUnavailable|\bThrottling\b|rate exceeded/i,
    hint: THROTTLE_HINT,
  },
];

// Best-effort text extraction: `name: message` when the name adds signal the message
// lacks, else the message alone. Accepts already-stringified errors too.
export function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  const o = (e ?? {}) as { name?: unknown; code?: unknown; message?: unknown };
  const name = typeof o.name === 'string' ? o.name : typeof o.code === 'string' ? o.code : '';
  const message = typeof o.message === 'string' ? o.message : '';
  if (name && (!message || !message.includes(name))) {
    return message ? `${name}: ${message}` : name;
  }
  return message || String(e);
}

export function classifyTransient(error: string | undefined): TransientVerdict {
  if (!error) return { transient: false };
  for (const { pattern, hint } of TRANSIENT_PATTERNS) {
    if (pattern.test(error)) return { transient: true, hint };
  }
  return { transient: false };
}

// The shape a retryable revert step returns. `applyRevertItem` / `applyRevertDelete`
// and the SDK-writer path all normalize to this (ok + error string); on exhaustion the
// retry annotates it with `transient` + `hint` for the report layer.
export interface RetryableResult {
  ok: boolean;
  error?: string;
  transient?: boolean;
  hint?: string;
}

export interface RetryOptions {
  // Total attempts including the first (default 3 → up to 2 retries). Ignored when
  // `deadlineMs` is set (the `revert --wait` path retries until the deadline instead).
  maxAttempts?: number;
  // Linear backoff base: waits baseDelayMs * attempt between tries (3s, 6s, …).
  baseDelayMs?: number;
  // Cap on a single backoff wait, so the deadline mode's linear growth stays bounded.
  maxDelayMs?: number;
  // `revert --wait` mode: keep retrying a transient failure until this wall-clock time
  // (ms epoch), NOT a fixed attempt count — so a resource that stays UPDATING for
  // minutes (RSLVR-00705) can converge in ONE command. `maxAttempts` is ignored.
  deadlineMs?: number;
  // Injectable clock (default Date.now) so deadline-mode tests don't wait for real time.
  now?: () => number;
  // Called before each backoff wait (a transient failure about to be retried) — the
  // report layer uses it to print a per-retry progress line so a multi-minute `--wait`
  // never looks frozen. `attempt` is the 1-based number of the attempt that just failed.
  onRetry?: (info: { attempt: number; delayMs: number; hint?: string }) => void;
  // Injectable for tests (default real setTimeout).
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 3000;
export const DEFAULT_MAX_DELAY_MS = 30_000;
// `revert --wait` with no explicit duration: block for up to 10 minutes (a
// Route53Resolver rule's UPDATING window is typically a few minutes).
export const DEFAULT_WAIT_MS = 10 * 60 * 1000;

// Parse a `--wait` duration: a bare number is SECONDS; a `s`/`m`/`h` suffix scales
// (e.g. "300", "300s", "5m", "1h"). Returns ms. Throws on a malformed value so a
// typo'd `--wait=5min` fails fast rather than silently defaulting.
export function parseDurationMs(raw: string): number {
  const m = /^(\d+)(s|m|h)?$/.exec(raw.trim());
  if (!m) {
    throw new Error(`invalid --wait duration "${raw}" — use e.g. 90, 30s, 5m, 1h`);
  }
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const scale = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000;
  return n * scale;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Run `op` with bounded backoff, retrying ONLY while its failure classifies as
// transient. A terminal failure returns immediately (no wasted waiting). Two stop
// conditions: the default fixed `maxAttempts`, or — when `deadlineMs` is set
// (`revert --wait`) — a wall-clock deadline so a minutes-long UPDATING window can
// converge in one command. When the retries are exhausted on a still-transient failure,
// the returned result carries `transient: true` + the classifier's `hint` so the caller
// can show the targeted message instead of a bare FAILED. `op` must be self-contained
// (catch its own throws into `{ ok:false, error }`) — it is re-invoked verbatim each try.
export async function retryTransient<T extends RetryableResult>(
  op: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const max = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const base = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const cap = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const doSleep = opts.sleep ?? realSleep;
  const clock = opts.now ?? Date.now;
  const deadline = opts.deadlineMs;
  let result = await op();
  let attempt = 1;
  while (!result.ok) {
    const verdict = classifyTransient(result.error);
    if (!verdict.transient) return result; // terminal — stop, no annotation
    // More tries allowed? deadline mode: only if there is time left to at least retry
    // AFTER a (possibly shortened) wait; attempt mode: until maxAttempts.
    const more = deadline !== undefined ? clock() < deadline : attempt < max;
    if (!more) return { ...result, transient: true, hint: verdict.hint };
    // In deadline mode, never sleep past the deadline (so the last wait doesn't overrun).
    const wait =
      deadline !== undefined
        ? Math.max(0, Math.min(base * attempt, cap, deadline - clock()))
        : Math.min(base * attempt, cap);
    opts.onRetry?.({ attempt, delayMs: wait, ...(verdict.hint && { hint: verdict.hint }) });
    await doSleep(wait);
    attempt++;
    result = await op();
  }
  return result;
}

// #1309: the #740 cross-account mismatch gate was CHECK-ONLY. `record`, `ignore`, and
// `revert` destructured `{ stackName, region, template }` and ignored the resolved
// `account`, so a stack env-pinned to account A, run with account-B credentials:
//   - revert: with a same-named stack in B, the gather read B's live state and the
//     confirmed ops were WRITTEN to account B's resources — a wrong-account AWS write,
//   - record: wrote a fresh `<stack>.<B-account>.<region>.json` baseline snapshotting
//     the wrong account's live values as reviewed intent,
//   - ignore: appended rules scoped to the wrong accountId,
// and without the same-named-stack coincidence all three misreported the pinned stack
// as "not deployed" instead of check's accurate cross-account skip message.
//
// The fix extracts check's gate into src/commands/account-gate.ts and applies it in the
// three verb loops: a proven mismatch is a per-stack ERROR (exit 2) for revert (the user
// explicitly asked to mutate that stack) and a skip (mirroring check's message style)
// for record/ignore. These tests drive the three run* loops with the same module-mock
// shape as record-footer-949.test.ts, plus aws-sdk-client-mock for the gate's real
// sts:GetCallerIdentity, and pin the pure classifiers (including that check's messages
// stayed byte-identical).

import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  classifyAccountMismatch,
  classifyReadAccountMismatch,
  createAccountGate,
} from '../src/commands/account-gate.js';

const PINNED = '111111111111'; // the stack's env.account
const CALLER = '222222222222'; // the active credentials' account

// One stack list per test, swapped via this hoisted holder (the vi.mock factory is
// hoisted above module consts, so it must close over something hoisted too).
const h = vi.hoisted(() => ({
  stacks: [] as {
    stackName: string;
    region: string | undefined;
    account: string | undefined;
    template: Record<string, unknown>;
  }[],
  json: false,
}));

vi.mock('../src/commands/resolve-stacks.js', () => ({
  resolveStacks: () => Promise.resolve(h.stacks),
}));

const gatherFindings = vi.fn();
vi.mock('../src/commands/gather.js', () => ({
  gatherFindings: (...a: unknown[]) => gatherFindings(...a),
}));

vi.mock('../src/commands/progress.js', () => ({
  gatherWithProgress: (_show: boolean, _label: string, fn: () => unknown) => fn(),
  progressLabel: () => '',
}));

vi.mock('../src/config/config-file.js', () => ({
  loadConfig: () => Promise.resolve({}),
  applyIgnores: (findings: unknown) => findings,
}));

vi.mock('../src/cli-args.js', () => ({
  parseCommonArgs: () => ({
    profile: undefined,
    json: h.json,
    yes: true,
    verbose: false,
    stackNames: [],
    all: false,
  }),
  isInteractive: () => false,
}));

const recordStack = vi.fn();
const ignoreStack = vi.fn();
const revertStack = vi.fn();
vi.mock('../src/commands/stack-actions.js', () => ({
  recordStack: (...a: unknown[]) => recordStack(...a),
  ignoreStack: (...a: unknown[]) => ignoreStack(...a),
  revertStack: (...a: unknown[]) => revertStack(...a),
  warnStackStatus: () => {},
}));

// ignore.ts / revert.ts reconcile against the baseline before their stack action; none
// of that is under test here, so stub the file I/O away (loadBaseline → no baseline).
vi.mock('../src/baseline/baseline-file.js', () => ({
  loadBaseline: () => Promise.resolve(undefined),
  checkBaselineAccount: () => {},
  applyBaseline: (findings: unknown) => findings,
  declaredKeysByLogical: () => new Map(),
  constructPathsByLogical: () => new Map(),
  physicalIdsByLogical: () => new Map(),
}));

import { runIgnore } from '../src/commands/ignore.js';
import { runRecord } from '../src/commands/record.js';
import { runRevert } from '../src/commands/revert.js';

const sts = mockClient(STSClient);

// A gather result whose resolved accountId is the CALLER's (the reachable account) —
// the same-named-stack-in-the-wrong-account shape when the loop's stack is PINNED.
function gatherResult(accountId: string): unknown {
  return {
    desired: { accountId, resources: [], stackStatusWarning: undefined },
    findings: [],
    schemas: new Map(),
    liveByLogical: new Map(),
  };
}

function pinnedStack(): void {
  h.stacks = [{ stackName: 'Pinned', region: 'us-east-1', account: PINNED, template: {} }];
}

describe('#1309 cross-account gate in record / ignore / revert', () => {
  let errs: string[];
  let logs: string[];
  let origErr: typeof console.error;
  let origLog: typeof console.log;

  beforeEach(() => {
    sts.reset();
    sts.on(GetCallerIdentityCommand).resolves({ Account: CALLER });
    gatherFindings.mockReset();
    gatherFindings.mockResolvedValue(gatherResult(CALLER));
    recordStack.mockReset();
    recordStack.mockResolvedValue({ wrote: true, refused: false, count: 1 });
    ignoreStack.mockReset();
    ignoreStack.mockResolvedValue({ wrote: true, refused: false, added: 1 });
    revertStack.mockReset();
    revertStack.mockResolvedValue({ exit: 0, reverted: 1, failed: 0, aborted: false });
    h.json = false;
    errs = [];
    logs = [];
    origErr = console.error;
    origLog = console.log;
    console.error = (s: unknown) => errs.push(String(s));
    console.log = (s: unknown) => logs.push(String(s));
  });

  afterEach(() => {
    console.error = origErr;
    console.log = origLog;
  });

  describe('revert — a proven mismatch is a per-stack ERROR (exit 2), never a write', () => {
    it('REFUSES pre-read: exit 2, no gather (wrong account never read), no revertStack', async () => {
      pinnedStack();
      const rc = await runRevert([]);
      expect(rc).toBe(2);
      expect(gatherFindings).not.toHaveBeenCalled();
      expect(revertStack).not.toHaveBeenCalled();
      const err = errs.join('\n');
      expect(err).toContain(`error: Pinned:`);
      expect(err).toContain(`pinned to account ${PINNED}`);
      expect(err).toContain(CALLER);
      expect(err).toContain('refusing to revert');
      expect(err).toContain(`account-${PINNED} credentials`);
    });

    it('REFUSES post-read when STS is blocked (caller unresolved) but the read proves the wrong account', async () => {
      pinnedStack();
      sts.on(GetCallerIdentityCommand).rejects(new Error('ExpiredToken'));
      const rc = await runRevert([]);
      expect(rc).toBe(2);
      expect(gatherFindings).toHaveBeenCalledTimes(1); // pre-read gate could not prove, so it read…
      expect(revertStack).not.toHaveBeenCalled(); // …but the post-read guard refused the write
      const err = errs.join('\n');
      expect(err).toContain(`compared against account ${CALLER}`);
      expect(err).toContain('refusing to revert');
    });

    it('carries the refusal into the --json element (exit 2 + error)', async () => {
      pinnedStack();
      h.json = true;
      const rc = await runRevert([]);
      expect(rc).toBe(2);
      const reports = JSON.parse(logs.join('\n')) as { exit: number; error?: string }[];
      expect(reports).toHaveLength(1);
      expect(reports[0]!.exit).toBe(2);
      expect(reports[0]!.error).toContain('refusing to revert');
    });

    it('proceeds normally when the pinned account matches the caller', async () => {
      pinnedStack();
      sts.on(GetCallerIdentityCommand).resolves({ Account: PINNED });
      gatherFindings.mockResolvedValue(gatherResult(PINNED));
      const rc = await runRevert([]);
      expect(rc).toBe(0);
      expect(revertStack).toHaveBeenCalledTimes(1);
    });
  });

  describe('record — a mismatch never writes a wrong-account baseline', () => {
    it('SKIPS pre-read (exit 0, note): no gather, no recordStack → no baseline written', async () => {
      pinnedStack();
      const rc = await runRecord([]);
      expect(rc).toBe(0); // a skip, mirroring check — not an error
      expect(gatherFindings).not.toHaveBeenCalled();
      expect(recordStack).not.toHaveBeenCalled();
      const err = errs.join('\n');
      expect(err).toContain(`note: Pinned:`);
      expect(err).toContain(`pinned to account ${PINNED}`);
      expect(err).toContain(`skipped (run with account-${PINNED} credentials to record it)`);
    });

    it('SKIPS post-read when STS is blocked but the read resolved the wrong account', async () => {
      pinnedStack();
      sts.on(GetCallerIdentityCommand).rejects(new Error('ExpiredToken'));
      const rc = await runRecord([]);
      expect(rc).toBe(0);
      expect(gatherFindings).toHaveBeenCalledTimes(1);
      expect(recordStack).not.toHaveBeenCalled();
      expect(errs.join('\n')).toContain(`compared against account ${CALLER}`);
    });

    it('reports the accurate cross-account skip, NOT "not deployed", when no same-named stack exists', async () => {
      // Without the fix the ungated gather throws DescribeStacks "does not exist" and the
      // catch prints the misleading "not deployed yet — nothing to record".
      pinnedStack();
      gatherFindings.mockRejectedValue(
        Object.assign(new Error('Stack with id Pinned does not exist'), {
          name: 'ValidationError',
        })
      );
      const rc = await runRecord([]);
      expect(rc).toBe(0);
      const err = errs.join('\n');
      expect(err).toContain(`pinned to account ${PINNED}`);
      expect(err).not.toContain('not deployed');
    });

    it('proceeds normally when the pinned account matches the caller', async () => {
      pinnedStack();
      sts.on(GetCallerIdentityCommand).resolves({ Account: PINNED });
      gatherFindings.mockResolvedValue(gatherResult(PINNED));
      const rc = await runRecord([]);
      expect(rc).toBe(0);
      expect(recordStack).toHaveBeenCalledTimes(1);
    });
  });

  describe('ignore — a mismatch never writes wrong-account rules', () => {
    it('SKIPS pre-read (exit 0, note): no gather, no ignoreStack → no rules written', async () => {
      pinnedStack();
      const rc = await runIgnore([]);
      expect(rc).toBe(0);
      expect(gatherFindings).not.toHaveBeenCalled();
      expect(ignoreStack).not.toHaveBeenCalled();
      const err = errs.join('\n');
      expect(err).toContain(`note: Pinned:`);
      expect(err).toContain(`skipped (run with account-${PINNED} credentials to ignore it)`);
    });

    it('SKIPS post-read when STS is blocked but the read resolved the wrong account', async () => {
      pinnedStack();
      sts.on(GetCallerIdentityCommand).rejects(new Error('ExpiredToken'));
      const rc = await runIgnore([]);
      expect(rc).toBe(0);
      expect(ignoreStack).not.toHaveBeenCalled();
      expect(errs.join('\n')).toContain(`compared against account ${CALLER}`);
    });
  });

  describe('the gate is lazy — an env-agnostic app never pays the STS call', () => {
    it('makes NO GetCallerIdentity call when no stack carries an env.account pin', async () => {
      // The pre-#1309 verb loops made no STS call at all; the gate must not add one for
      // the (common) unpinned case — it can prove nothing without a declared account.
      h.stacks = [{ stackName: 'Agnostic', region: 'us-east-1', account: undefined, template: {} }];
      const rc = await runRecord([]);
      expect(rc).toBe(0);
      expect(sts.calls()).toHaveLength(0);
      expect(recordStack).toHaveBeenCalledTimes(1); // proceeds as before
    });

    it('resolves the caller AT MOST ONCE across a multi-stack run', async () => {
      h.stacks = [
        { stackName: 'A', region: 'us-east-1', account: PINNED, template: {} },
        { stackName: 'B', region: 'us-west-2', account: PINNED, template: {} },
      ];
      await runRecord([]);
      expect(sts.calls()).toHaveLength(1);
    });
  });
});

describe('#1309 pure classifiers (shared home of the #740 gate)', () => {
  it("classifyAccountMismatch default keeps check's message byte-identical", () => {
    const r = classifyAccountMismatch(PINNED, CALLER);
    expect(r.skip).toBe(true);
    expect(r.message).toBe(
      `stack is pinned to account ${PINNED} but the active credentials are for account ${CALLER} — skipped (run with account-${PINNED} credentials to check it)`
    );
  });

  it('classifyAccountMismatch tails name the invoking verb (record / ignore)', () => {
    expect(classifyAccountMismatch(PINNED, CALLER, 'record').message).toContain(
      `skipped (run with account-${PINNED} credentials to record it)`
    );
    expect(classifyAccountMismatch(PINNED, CALLER, 'ignore').message).toContain(
      `skipped (run with account-${PINNED} credentials to ignore it)`
    );
  });

  it('classifyAccountMismatch revert tail is a refusal, not a skip', () => {
    const r = classifyAccountMismatch(PINNED, CALLER, 'revert');
    expect(r.skip).toBe(true);
    expect(r.message).toContain('refusing to revert');
    expect(r.message).not.toContain('skipped');
  });

  it("classifyReadAccountMismatch default keeps check's post-read message byte-identical", () => {
    const r = classifyReadAccountMismatch(PINNED, CALLER);
    expect(r.skip).toBe(true);
    expect(r.message).toBe(
      `compared against account ${CALLER} but the stack is pinned to ${PINNED} — skipped (run with account-${PINNED} credentials to check it)`
    );
  });

  it('classifyReadAccountMismatch does not fire when unpinned or matching', () => {
    expect(classifyReadAccountMismatch(undefined, CALLER).skip).toBe(false);
    expect(classifyReadAccountMismatch(PINNED, PINNED).skip).toBe(false);
  });

  it('createAccountGate.preRead cannot prove a mismatch without a declared account', async () => {
    const gate = createAccountGate('record');
    // account undefined → no STS call is even attempted (nothing to compare against).
    expect((await gate.preRead(undefined, 'us-east-1')).skip).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// #761: two state bugs in interactive-resolve.ts's `perFinding` flow.
//  A — a CANCELLED revert confirm was still treated as "applied" + terminal.
//  B — record ran before ignore with a STALE config → completeness under-marked.
//
// The top menu `select` returns 'per-finding'; the action-picker returns the per-row
// action assignment; the AWS/local writers are spied.

vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, select: vi.fn(), isCancel: () => false };
});

// Replace the per-finding action picker with a spy so a test can dictate the action
// assigned to each decidable row (the real one drives a TTY).
vi.mock('../src/commands/action-picker.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, actionPicker: vi.fn() };
});

// Keep the real availableActions/applicableActions/groupByAction, but spy the writers so
// we can assert HOW perFinding calls them (revert's aborted outcome, record's findings).
vi.mock('../src/commands/stack-actions.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    revertStack: vi.fn().mockResolvedValue({ exit: 0, aborted: false }),
    ignoreStack: vi.fn().mockResolvedValue({ wrote: true, refused: false, added: 1 }),
    recordStack: vi.fn().mockResolvedValue({ wrote: true, refused: false }),
  };
});

// Spy loadConfig + applyIgnores (config-file) so Bug B can assert the record call re-reads
// the config AFTER ignore wrote its rules. applyIgnores stays a real pass-through wrapper
// so we can capture which config object it was handed on each call.
vi.mock('../src/config/config-file.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadConfig: vi.fn(),
    applyIgnores: vi.fn(),
  };
});

import { select } from '@clack/prompts';
import { actionPicker } from '../src/commands/action-picker.js';
import { ignoreStack, recordStack, revertStack } from '../src/commands/stack-actions.js';
import { applyIgnores, loadConfig } from '../src/config/config-file.js';
import { resolveInteractively } from '../src/commands/interactive-resolve.js';
import type { Finding } from '../src/types.js';

const undeclaredDrift: Finding = {
  tier: 'undeclared',
  logicalId: 'R',
  physicalId: 'r-phys',
  resourceType: 'AWS::S3::Bucket',
  path: 'OwnershipControls',
  actual: 'x',
};
const declaredDrift: Finding = {
  tier: 'declared',
  logicalId: 'B',
  physicalId: 'b-phys',
  resourceType: 'AWS::S3::Bucket',
  path: 'VersioningConfiguration.Status',
  desired: 'Enabled',
  actual: 'Suspended',
};

// The initial config passed into resolveInteractively (pre-ignore); a fresh reload returns
// a DIFFERENT object so a test can tell which one the record call was handed.
const preConfig = { version: 1, ignore: [] } as const;
const postConfig = { version: 1, ignore: [{ path: 'R.OwnershipControls' }] } as const;

const params = (findings: Finding[]) =>
  ({
    stackName: 'S',
    region: 'us-east-1',
    desired: {
      accountId: '111122223333',
      resources: [
        { logicalId: 'R', resourceType: 'AWS::S3::Bucket', declared: {} },
        { logicalId: 'B', resourceType: 'AWS::S3::Bucket', declared: {} },
      ],
    },
    findings,
    reconciled: findings,
    baseline: { schemaVersion: 1, recorded: [] },
    schemas: new Map(),
    liveByLogical: new Map(),
    config: preConfig,
    code: 1,
    yes: false,
    removeUnrecorded: false,
    verbose: false,
  }) as unknown as Parameters<typeof resolveInteractively>[0];

// Capture what console.error emitted (the closing note) for the current test.
let notes: string[];
const errSpy = vi.spyOn(console, 'error');

beforeEach(() => {
  vi.mocked(select).mockReset();
  vi.mocked(actionPicker).mockReset();
  vi.mocked(revertStack).mockClear();
  vi.mocked(recordStack).mockClear();
  vi.mocked(ignoreStack).mockClear();
  vi.mocked(revertStack).mockResolvedValue({ exit: 0, aborted: false });
  vi.mocked(recordStack).mockResolvedValue({ wrote: true, refused: false });
  vi.mocked(ignoreStack).mockResolvedValue({ wrote: true, refused: false, added: 1 });
  // applyIgnores: identity pass-through (returns the findings unchanged) so reconciliation
  // works; loadConfig: return the post-ignore config so a reload is observable.
  vi.mocked(applyIgnores).mockImplementation(
    (findings: Finding[]) => findings as unknown as ReturnType<typeof applyIgnores>
  );
  vi.mocked(loadConfig).mockResolvedValue(
    postConfig as unknown as Awaited<ReturnType<typeof loadConfig>>
  );
  notes = [];
  errSpy.mockClear();
  errSpy.mockImplementation((...a: unknown[]) => {
    notes.push(a.join(' '));
  });
});

describe('#761 Bug A — a CANCELLED per-finding revert is not "applied" nor terminal', () => {
  it('cancelled revert (outcome.aborted) → awsMutated false (menu re-shows) + note says "cancelled"', async () => {
    // per-finding needs >1 decidable finding to appear in the menu; assign revert to both.
    vi.mocked(select)
      .mockResolvedValueOnce('per-finding') // top menu
      .mockResolvedValueOnce('nothing'); // re-shown menu (revert cancelled, drift stands) → exit
    vi.mocked(actionPicker).mockResolvedValueOnce(['revert', 'revert']);
    // The AWS-write confirm is DECLINED → nothing written.
    vi.mocked(revertStack).mockResolvedValueOnce({ exit: 0, aborted: true });

    await resolveInteractively(params([undeclaredDrift, declaredDrift]));

    // The menu was re-shown (a second `select` call) — proof the pass was NOT terminal.
    expect(vi.mocked(select)).toHaveBeenCalledTimes(2);
    // The closing note flags the revert as cancelled, not applied.
    const note = notes.find((n) => n.includes('per-finding decisions applied'));
    expect(note).toBeDefined();
    expect(note!).toContain('2 revert cancelled');
    // the APPLIED-summary segment (before the "(… cancelled)" tail) must NOT claim a revert
    // ran — with only a cancelled revert it degrades to "nothing selected".
    const appliedSegment = note!.slice(0, note!.indexOf(' (2 revert cancelled)'));
    expect(appliedSegment).not.toMatch(/revert/);
    expect(appliedSegment).toContain('nothing selected');
  });

  it('applied revert (not aborted) → awsMutated true (terminal, menu NOT re-shown) + note says the revert', async () => {
    vi.mocked(select).mockResolvedValueOnce('per-finding'); // top menu ONLY — terminal after write
    vi.mocked(actionPicker).mockResolvedValueOnce(['revert', 'revert']);
    vi.mocked(revertStack).mockResolvedValueOnce({ exit: 0, aborted: false });

    await resolveInteractively(params([undeclaredDrift, declaredDrift]));

    // Terminal: only the ONE top-menu select fired (no re-show).
    expect(vi.mocked(select)).toHaveBeenCalledTimes(1);
    const note = notes.find((n) => n.includes('per-finding decisions applied'));
    expect(note).toBeDefined();
    expect(note!).not.toContain('cancelled');
    expect(note!).toContain('2 revert'); // applied summary counts the revert
  });
});

describe('#761 Bug B — record sees the ignore rules written earlier in the same pass', () => {
  it('ignore X + record Y → record runs AFTER ignore with a RELOADED (post-ignore) config', async () => {
    // Two undeclared findings on distinct resources: X ignored, Y recorded.
    const ignoreMe: Finding = { ...undeclaredDrift, logicalId: 'R', path: 'OwnershipControls' };
    const recordMe: Finding = { ...undeclaredDrift, logicalId: 'B', path: 'ObjectLockEnabled' };
    vi.mocked(select).mockResolvedValueOnce('per-finding').mockResolvedValueOnce('nothing'); // re-shown menu → exit (no AWS write in this pass)
    // row 0 (X) → ignore, row 1 (Y) → record
    vi.mocked(actionPicker).mockResolvedValueOnce(['ignore', 'record']);

    await resolveInteractively(params([ignoreMe, recordMe]));

    // ignore ran, then record ran.
    expect(ignoreStack).toHaveBeenCalledTimes(1);
    expect(recordStack).toHaveBeenCalledTimes(1);
    // The config was RELOADED (loadConfig re-read) so record sees the just-written rule.
    // Without the fix, record used p.config (preConfig) and loadConfig would only be called
    // in the post-action recomputeExit — never BEFORE recordStack.
    const recordOrder = vi.mocked(recordStack).mock.invocationCallOrder[0]!;
    const ignoreOrder = vi.mocked(ignoreStack).mock.invocationCallOrder[0]!;
    expect(ignoreOrder).toBeLessThan(recordOrder); // ignore BEFORE record

    // The applyIgnores call that built record's findings received the POST-ignore config,
    // not the stale preConfig. Find the applyIgnores call whose config is postConfig and
    // assert it happened before recordStack.
    const postIgnoreCall = vi
      .mocked(applyIgnores)
      .mock.calls.find((c) => c[2] === (postConfig as unknown));
    expect(postIgnoreCall).toBeDefined();
  });

  it('record with NO ignore in the same pass does NOT force a config reload before record', async () => {
    // Only a record action → no ignore rule to reload for; p.config is fresh enough.
    const recordMe: Finding = { ...undeclaredDrift, logicalId: 'B', path: 'ObjectLockEnabled' };
    const other: Finding = { ...undeclaredDrift, logicalId: 'R', path: 'OwnershipControls' };
    vi.mocked(select).mockResolvedValueOnce('per-finding').mockResolvedValueOnce('nothing');
    vi.mocked(actionPicker).mockResolvedValueOnce(['record', 'skip']);

    await resolveInteractively(params([recordMe, other]));

    expect(ignoreStack).not.toHaveBeenCalled();
    expect(recordStack).toHaveBeenCalledTimes(1);
    // record's findings were built with the ORIGINAL preConfig (no reload needed).
    const recordFindingsCall = vi
      .mocked(applyIgnores)
      .mock.calls.find((c) => c[2] === (preConfig as unknown));
    expect(recordFindingsCall).toBeDefined();
  });
});

import { describe, expect, it } from 'vite-plus/test';
import type { BaselineFile } from '../src/baseline/baseline-file.js';
import type { GatherResult } from '../src/commands/gather.js';
import {
  availableActions,
  formatPlan,
  resolveInteractiveRevertExit,
  revertStack,
} from '../src/commands/stack-actions.js';
import type { RevertPlan } from '../src/revert/plan.js';
import type { Finding, SchemaInfo } from '../src/types.js';

const NO_SCHEMAS = new Map<string, SchemaInfo>();

const declared = (): Finding => ({
  tier: 'declared',
  logicalId: 'B',
  resourceType: 'AWS::S3::Bucket',
  path: 'VersioningConfiguration',
  physicalId: 'b-phys',
  desired: { Status: 'Enabled' },
  actual: { Status: 'Suspended' },
});
const undeclared = (): Finding => ({
  tier: 'undeclared',
  logicalId: 'B',
  resourceType: 'AWS::S3::Bucket',
  path: 'AccelerateConfiguration',
  physicalId: 'b-phys',
  actual: { AccelerationStatus: 'Enabled' },
});
const deleted = (): Finding => ({
  tier: 'deleted',
  logicalId: 'B',
  resourceType: 'AWS::S3::Bucket',
  path: '',
  physicalId: 'b-phys',
});

const blessed = (entries: BaselineFile['accepted']): BaselineFile => ({
  schemaVersion: 1,
  stackName: 's',
  region: 'r',
  accountId: '111122223333',
  capturedAt: '',
  templateHash: '',
  accepted: entries,
});

describe('availableActions (R28 interactive choice logic)', () => {
  it('declared-only → Accept hidden (cannot bless declared), Revert shown', () => {
    expect(availableActions([declared()], undefined, NO_SCHEMAS, false)).toEqual({
      accept: false,
      revert: true,
    });
  });

  it('undeclared-only with NO baseline → Accept shown, Revert hidden (no-baseline guard)', () => {
    expect(availableActions([undeclared()], undefined, NO_SCHEMAS, false)).toEqual({
      accept: true,
      revert: false,
    });
  });

  it('undeclared-only with --remove-unblessed → Revert becomes available', () => {
    expect(availableActions([undeclared()], undefined, NO_SCHEMAS, true)).toEqual({
      accept: true,
      revert: true,
    });
  });

  it('deleted-only → neither (deleted is not revertable, nothing to bless)', () => {
    expect(availableActions([deleted()], undefined, NO_SCHEMAS, false)).toEqual({
      accept: false,
      revert: false,
    });
  });

  it('mixed declared + undeclared (with baseline making undeclared revertable) → both', () => {
    const b = blessed([
      {
        logicalId: 'B',
        resourceType: 'AWS::S3::Bucket',
        path: 'AccelerateConfiguration',
        value: { AccelerationStatus: 'Suspended' },
      },
    ]);
    // undeclared is blessed-then-changed → revertable to the blessed value; declared → revertable
    expect(availableActions([declared(), undeclared()], b, NO_SCHEMAS, false)).toEqual({
      accept: true,
      revert: true,
    });
  });
});

describe('formatPlan (R35 — NOT-revertable folds to a per-reason summary)', () => {
  const nr = (reason: string, path = 'P'): RevertPlan['notRevertable'][number] => ({
    displayId: 'Stack/Res',
    resourceType: 'AWS::S3::Bucket',
    path,
    reason,
  });

  it('folds notRevertable into one line per reason, sorted by count desc', () => {
    const plan: RevertPlan = {
      items: [],
      notRevertable: [nr('no baseline — x', 'A'), nr('no baseline — x', 'B'), nr('deleted — y')],
    };
    const lines = formatPlan('s', 'r', plan, {});
    expect(lines).toContain('\n  NOT revertable: 2 (no baseline — x)');
    expect(lines).toContain('                · 1 (deleted — y)');
    expect(lines).toContain('    (run with --verbose for the full list)');
    // no per-finding lines in the folded view
    expect(lines.some((l) => l.includes('Stack/Res.A'))).toBe(false);
  });

  it('--verbose expands to the full per-finding list', () => {
    const plan: RevertPlan = {
      items: [],
      notRevertable: [nr('no baseline — x', 'A'), nr('deleted — y')],
    };
    const lines = formatPlan('s', 'r', plan, { verbose: true });
    expect(lines).toContain('\n  NOT revertable (2):');
    expect(lines).toContain('    - Stack/Res.A (AWS::S3::Bucket) — no baseline — x');
    expect(lines.some((l) => l.includes('(run with --verbose'))).toBe(false);
  });

  it('revertable items keep full detail regardless of verbose (the point of the plan)', () => {
    const plan: RevertPlan = {
      items: [
        {
          logicalId: 'R',
          displayId: 'Stack/Res',
          resourceType: 'AWS::S3::Bucket',
          physicalId: 'p',
          kind: 'cc',
          ops: [{ op: 'add', path: '/A', value: 1, human: 'A -> deployed-template value' }],
        },
      ],
      notRevertable: [],
    };
    for (const verbose of [false, true]) {
      const lines = formatPlan('s', 'r', plan, { verbose });
      expect(lines).toContain('\n  Stack/Res (AWS::S3::Bucket)');
      expect(lines).toContain('    - A -> deployed-template value');
    }
  });

  it('noBaselineGuidance leads with the accept-first route', () => {
    const plan: RevertPlan = { items: [], notRevertable: [nr('no baseline — x')] };
    const lines = formatPlan('MyStack', 'r', plan, { noBaselineGuidance: true });
    expect(lines[1]).toBe(
      '\nnote: MyStack has no baseline — undeclared drift has no revert target.'
    );
    expect(lines[2]).toContain('cdkrd check` or `cdkrd accept');
  });
});

describe('revertStack exit semantics (R35 — drift with nothing revertable is exit 1)', () => {
  // findings-only params: every path under test returns BEFORE any AWS client is used
  const params = (findings: Finding[]) => ({
    stackName: 's',
    region: 'r',
    gathered: {
      desired: { accountId: '111122223333', resources: [], rawTemplate: '' },
      findings,
      schemas: NO_SCHEMAS,
    } as unknown as GatherResult,
    baseline: undefined,
    config: { ignore: [] },
    dryRun: false,
    yes: true,
    removeUnblessed: false,
    verbose: false,
  });

  const captured = async (findings: Finding[]) => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => logs.push(String(s));
    try {
      const outcome = await revertStack(params(findings));
      return { outcome, logs };
    } finally {
      console.log = orig;
    }
  };

  it('no drift at all -> "no drift to revert." + exit 0 (regression)', async () => {
    const { outcome, logs } = await captured([]);
    expect(outcome).toEqual({ exit: 0, aborted: false });
    expect(logs.join('\n')).toContain('no drift to revert.');
  });

  it('informational-only findings -> still exit 0 (not drift)', async () => {
    const { outcome } = await captured([
      { tier: 'readGap', logicalId: 'R', resourceType: 'AWS::X::Y', path: 'P' },
    ]);
    expect(outcome).toEqual({ exit: 0, aborted: false });
  });

  it('drift exists but nothing revertable (deleted-only) -> summary + exit 1', async () => {
    const { outcome, logs } = await captured([deleted()]);
    expect(outcome).toEqual({ exit: 1, aborted: false });
    const out = logs.join('\n');
    expect(out).toContain('NOT revertable: 1 (deleted — recreate via cdk deploy)');
    expect(out).toContain('nothing revertable — 1 drift(s) remain.');
  });

  it('un-blessed undeclared drift -> no-baseline guidance + exit 1', async () => {
    const { outcome, logs } = await captured([undeclared()]);
    expect(outcome).toEqual({ exit: 1, aborted: false });
    const out = logs.join('\n');
    expect(out).toContain('note: s has no baseline — undeclared drift has no revert target.');
    expect(out).toContain('NOT revertable: 1 (no baseline — run `cdkrd accept` first');
    expect(out).toContain('nothing revertable — 1 drift(s) remain.');
  });
});

describe('resolveInteractiveRevertExit (R30 — abort must not drop drift to exit 0)', () => {
  it('aborted confirm → keep the pre-revert code (drift still stands)', () => {
    // check is always in the drift branch (code 1) when it reaches revert
    expect(resolveInteractiveRevertExit(1, { exit: 0, aborted: true })).toBe(1);
  });

  it('revert applied & converged → adopt the outcome exit (0 clean)', () => {
    expect(resolveInteractiveRevertExit(1, { exit: 0, aborted: false })).toBe(0);
  });

  it('revert applied but drift remains → adopt exit 1', () => {
    expect(resolveInteractiveRevertExit(1, { exit: 1, aborted: false })).toBe(1);
  });

  it('revert apply failure → adopt exit 2', () => {
    expect(resolveInteractiveRevertExit(1, { exit: 2, aborted: false })).toBe(2);
  });
});

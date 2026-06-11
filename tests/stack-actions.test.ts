import { existsSync, readFileSync, rmSync } from 'node:fs';
import {
  CloudControlClient,
  GetResourceCommand,
  UpdateResourceCommand,
} from '@aws-sdk/client-cloudcontrol';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { BaselineFile } from '../src/baseline/baseline-file.js';
import { baselinePath } from '../src/baseline/baseline-file.js';
import type { GatherResult } from '../src/commands/gather.js';
import type { Desired } from '../src/desired/template-adapter.js';
import {
  acceptStack,
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
  // findings-only params: every path under test returns BEFORE any AWS client is
  // used — either nothing is revertable, or --dry-run returns at the preview branch.
  type Overrides = { removeUnblessed?: boolean; dryRun?: boolean };
  const params = (findings: Finding[], over: Overrides = {}) => ({
    stackName: 's',
    region: 'r',
    gathered: {
      desired: { accountId: '111122223333', resources: [], rawTemplate: '' },
      findings,
      schemas: NO_SCHEMAS,
    } as unknown as GatherResult,
    baseline: undefined,
    config: { ignore: [] },
    dryRun: over.dryRun ?? false,
    yes: true,
    removeUnblessed: over.removeUnblessed ?? false,
    verbose: false,
    interactive: true, // these paths return before any confirm (yes:true); value is irrelevant
  });

  const captured = async (findings: Finding[], over: Overrides = {}) => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => logs.push(String(s));
    try {
      const outcome = await revertStack(params(findings, over));
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

  it('--remove-unblessed: no-baseline note is suppressed; the plan removes the undeclared drift', async () => {
    // dry-run returns at the preview branch (no AWS write). The note would contradict
    // a plan that DOES remove the drift, so it must not appear (R35 review).
    const { outcome, logs } = await captured([undeclared()], {
      removeUnblessed: true,
      dryRun: true,
    });
    expect(outcome).toEqual({ exit: 0, aborted: false });
    const out = logs.join('\n');
    expect(out).not.toContain('has no baseline — undeclared drift has no revert target');
    expect(out).toContain('remove (undeclared, not in baseline)'); // a real revert item is planned
    expect(out).toContain('(dry-run) would apply');
  });
});

describe('revertStack convergence re-check (R44 — scoped to touched resources)', () => {
  const EMPTY_SCHEMA = {
    readOnly: new Set<string>(),
    writeOnly: new Set<string>(),
    createOnly: new Set<string>(),
    readOnlyPaths: [],
    writeOnlyPaths: [],
    createOnlyPaths: [],
    defaults: {},
  } as SchemaInfo;

  // One bucket with declared VersioningConfiguration drift (the declared() fixture).
  const gathered = (): GatherResult =>
    ({
      desired: {
        stackName: 's',
        region: 'r',
        accountId: '111122223333',
        resources: [
          {
            logicalId: 'B',
            resourceType: 'AWS::S3::Bucket',
            physicalId: 'b-phys',
            declared: { VersioningConfiguration: { Status: 'Enabled' } },
          },
        ],
        rawTemplate: '{}',
        ctx: {
          params: {},
          pseudo: {},
          conditions: {},
          physIds: {},
          liveAttrs: {},
          mappings: {},
          exports: {},
          condCache: new Map(),
        },
      },
      findings: [declared()],
      schemas: new Map([['AWS::S3::Bucket', EMPTY_SCHEMA]]),
    }) as GatherResult;

  const params = () => ({
    stackName: 's',
    region: 'r',
    gathered: gathered(),
    baseline: undefined,
    config: { ignore: [] },
    dryRun: false,
    yes: true,
    removeUnblessed: false,
    verbose: false,
    interactive: false, // yes:true — no confirm prompt is reached
    convergeRetryDelayMs: 0, // do not sleep for real in tests
  });

  const liveRead = (status: string) => ({
    ResourceDescription: {
      Identifier: 'b-phys',
      Properties: JSON.stringify({ VersioningConfiguration: { Status: status } }),
    },
  });

  const run = async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => logs.push(String(s));
    try {
      const outcome = await revertStack(params());
      return { outcome, logs: logs.join('\n') };
    } finally {
      console.log = orig;
    }
  };

  const mockApplySuccess = (cc: ReturnType<typeof mockClient>) => {
    cc.on(UpdateResourceCommand).resolves({
      ProgressEvent: { OperationStatus: 'SUCCESS', RequestToken: 't' },
    });
  };

  it('converged on the first scoped read → CLEAN, exit 0, exactly ONE re-read', async () => {
    const cc = mockClient(CloudControlClient);
    mockApplySuccess(cc);
    cc.on(GetResourceCommand).resolves(liveRead('Enabled'));

    const { outcome, logs } = await run();
    expect(outcome).toEqual({ exit: 0, aborted: false });
    expect(logs).toContain('verifying convergence (re-reading 1 resource(s))...');
    expect(logs).toContain('s: CLEAN after revert.');
    // scoped: the single touched resource was read once — no full-stack re-gather,
    // and no eventual-consistency retry when the first read already converged
    expect(cc.commandCalls(GetResourceCommand)).toHaveLength(1);
  });

  it('stale first read → ONE retry, then CLEAN (eventual-consistency guard)', async () => {
    const cc = mockClient(CloudControlClient);
    mockApplySuccess(cc);
    let reads = 0;
    cc.on(GetResourceCommand).callsFake(() => liveRead(++reads === 1 ? 'Suspended' : 'Enabled'));

    const { outcome, logs } = await run();
    expect(outcome).toEqual({ exit: 0, aborted: false });
    expect(logs).toContain('s: CLEAN after revert.');
    expect(cc.commandCalls(GetResourceCommand)).toHaveLength(2);
  });

  it('still drifted after the retry → "1 drift(s) remain." + exit 1', async () => {
    const cc = mockClient(CloudControlClient);
    mockApplySuccess(cc);
    cc.on(GetResourceCommand).resolves(liveRead('Suspended'));

    const { outcome, logs } = await run();
    expect(outcome).toEqual({ exit: 1, aborted: false });
    expect(logs).toContain('s: 1 drift(s) remain.');
    expect(cc.commandCalls(GetResourceCommand)).toHaveLength(2); // first read + one retry, no more
  });
});

describe('acceptStack non-interactive refusal (R38)', () => {
  it('yes:false + interactive:false + undeclared present → refuses, writes nothing, errors', async () => {
    // Unique account/region so no baseline file exists on disk for this stack.
    const desired = {
      stackName: 'R38Stack',
      region: 'r38-region',
      accountId: '999988887777',
      resources: [],
      rawTemplate: '{}',
      ctx: {},
    } as unknown as Desired;
    const path = baselinePath(desired.stackName, desired.accountId, desired.region);
    if (existsSync(path)) rmSync(path);

    const errs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
      errs.push(String(m));
    });
    try {
      const result = await acceptStack({
        stackName: desired.stackName,
        region: desired.region,
        desired,
        findings: [undeclared()],
        yes: false,
        interactive: false,
      });
      expect(result).toEqual({ wrote: false, refused: true });
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(path)).toBe(false); // no baseline written
    expect(errs.join('\n')).toContain(
      'error: accept needs a decision — pass --yes to bless ALL undeclared values, or run interactively'
    );
  });

  it('yes:true → blesses ALL undeclared values with no prompt (regression)', async () => {
    const desired = {
      stackName: 'R38YesStack',
      region: 'r38-yes-region',
      accountId: '999988887777',
      resources: [],
      rawTemplate: '{}',
      ctx: {},
    } as unknown as Desired;
    const path = baselinePath(desired.stackName, desired.accountId, desired.region);
    if (existsSync(path)) rmSync(path);

    try {
      const result = await acceptStack({
        stackName: desired.stackName,
        region: desired.region,
        desired,
        findings: [undeclared()],
        yes: true,
        interactive: false, // ignored when yes:true — --yes blesses all regardless
      });
      expect(result).toEqual({ wrote: true, refused: false });
      expect(existsSync(path)).toBe(true);
      const written = JSON.parse(readFileSync(path, 'utf8')) as BaselineFile;
      // the full undeclared set is blessed (no selective multiselect under --yes)
      expect(written.accepted).toEqual([
        {
          logicalId: 'B',
          resourceType: 'AWS::S3::Bucket',
          path: 'AccelerateConfiguration',
          value: { AccelerationStatus: 'Enabled' },
        },
      ]);
    } finally {
      if (existsSync(path)) rmSync(path);
    }
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

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
  acceptSelectMessage,
  acceptStack,
  availableActions,
  filterRevertPlan,
  formatPlan,
  formatSurvivingDrift,
  resolveInteractiveRevertExit,
  revertConfirmMessage,
  revertSelectOptions,
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

const baselineWith = (entries: BaselineFile['accepted']): BaselineFile => ({
  schemaVersion: 1,
  stackName: 's',
  region: 'r',
  accountId: '111122223333',
  capturedAt: '',
  templateHash: '',
  accepted: entries,
});

describe('availableActions (R28 interactive choice logic)', () => {
  it('declared-only → Accept hidden (cannot accept declared), Revert shown', () => {
    expect(availableActions([declared()], undefined, NO_SCHEMAS, false)).toEqual({
      accept: false,
      revert: true,
    });
  });

  it('unrecorded-only → Accept shown, Revert hidden (no recorded state to restore, R62)', () => {
    // applyBaseline tags entry-less values on never-complete resources as unrecorded
    expect(
      availableActions([{ ...undeclared(), unrecorded: true }], undefined, NO_SCHEMAS, false)
    ).toEqual({
      accept: true,
      revert: false,
    });
  });

  it('unrecorded-only with --remove-unaccepted → Revert becomes available', () => {
    expect(
      availableActions([{ ...undeclared(), unrecorded: true }], undefined, NO_SCHEMAS, true)
    ).toEqual({
      accept: true,
      revert: true,
    });
  });

  it('deleted-only → neither (deleted is not revertable, nothing to accept)', () => {
    expect(availableActions([deleted()], undefined, NO_SCHEMAS, false)).toEqual({
      accept: false,
      revert: false,
    });
  });

  it('mixed declared + undeclared (with baseline making undeclared revertable) → both', () => {
    const b = baselineWith([
      {
        logicalId: 'B',
        resourceType: 'AWS::S3::Bucket',
        path: 'AccelerateConfiguration',
        value: { AccelerationStatus: 'Suspended' },
      },
    ]);
    // undeclared is accepted-then-changed → revertable to the baseline value; declared → revertable
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

  it('unrecordedGuidance explains the accept-vs-remove FORK, not a sequence (R55/R62)', () => {
    const plan: RevertPlan = { items: [], notRevertable: [nr('unrecorded — x')] };
    const lines = formatPlan('MyStack', 'r', plan, { unrecordedGuidance: true });
    expect(lines[1]).toBe(
      '\nnote: MyStack has unrecorded value(s) — never accepted, so there is no recorded state to restore.'
    );
    expect(lines[2]).toContain('If the live values are RIGHT, accept them');
    expect(lines[3]).toContain('REMOVED, re-run revert with --remove-unaccepted');
  });
});

describe('revertStack exit semantics (R35 — drift with nothing revertable is exit 1)', () => {
  // findings-only params: every path under test returns BEFORE any AWS client is
  // used — either nothing is revertable, or --dry-run returns at the preview branch.
  type Overrides = { removeUnaccepted?: boolean; dryRun?: boolean };
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
    removeUnaccepted: over.removeUnaccepted ?? false,
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

  it('unrecorded values (no baseline) -> unrecorded guidance + exit 1, named as unrecorded not drift', async () => {
    // revertStack's own applyBaseline tags the no-baseline findings as unrecorded
    const { outcome, logs } = await captured([undeclared()]);
    expect(outcome).toEqual({ exit: 1, aborted: false });
    const out = logs.join('\n');
    expect(out).toContain(
      'note: s has unrecorded value(s) — never accepted, so there is no recorded state to restore.'
    );
    expect(out).toContain('NOT revertable: 1 (unrecorded — accept it if the live value is right');
    expect(out).toContain('nothing revertable — 1 unrecorded value(s) remain.');
  });

  it('--remove-unaccepted: unrecorded note is suppressed; the plan removes the value', async () => {
    // dry-run returns at the preview branch (no AWS write). The note would contradict
    // a plan that DOES remove the value, so it must not appear (R35 review).
    const { outcome, logs } = await captured([undeclared()], {
      removeUnaccepted: true,
      dryRun: true,
    });
    expect(outcome).toEqual({ exit: 0, aborted: false });
    const out = logs.join('\n');
    expect(out).not.toContain('has unrecorded value(s) — never accepted');
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
    defaultPaths: {},
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
    removeUnaccepted: false,
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
    // R46: each surviving drift is listed (id.path + tier) so the user does not
    // have to re-run `check` just to learn what failed to converge.
    expect(logs).toContain('  - B.VersioningConfiguration.Status (declared)');
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
      'error: accept needs a decision — pass --yes to accept ALL undeclared values, or run interactively'
    );
  });

  it('yes:true → accepts ALL undeclared values with no prompt (regression)', async () => {
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
        interactive: false, // ignored when yes:true — --yes accepts all regardless
      });
      expect(result).toEqual({ wrote: true, refused: false });
      expect(existsSync(path)).toBe(true);
      const written = JSON.parse(readFileSync(path, 'utf8')) as BaselineFile;
      // the full undeclared set is accepted (no selective multiselect under --yes)
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

describe('revertConfirmMessage (R52 — the confirm must scope what gets written)', () => {
  it('with NOT-revertable findings present, states ONLY the selected ops are written', () => {
    const msg = revertConfirmMessage('s', 1, 113);
    expect(msg).toContain('Apply 1 revert op(s) to s? This WRITES to AWS.');
    expect(msg).toContain('Only the 1 selected op(s) are written');
    expect(msg).toContain('113 NOT-revertable finding(s) are untouched');
  });

  it('without NOT-revertable findings, no scope clause (nothing to disclaim)', () => {
    expect(revertConfirmMessage('s', 2, 0)).toBe('Apply 2 revert op(s) to s? This WRITES to AWS.');
  });
});

describe('revertSelectOptions / filterRevertPlan (R57 — pick what to revert)', () => {
  const plan = (): RevertPlan => ({
    items: [
      {
        logicalId: 'R',
        displayId: 'Stack/Rule',
        resourceType: 'AWS::Events::Rule',
        physicalId: 'r-phys',
        kind: 'cc',
        ops: [
          {
            op: 'add',
            path: '/State',
            value: 'ENABLED',
            human: 'State -> deployed-template value',
          },
        ],
      },
      {
        logicalId: 'B',
        displayId: 'Stack/Bucket',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'b-phys',
        kind: 'cc',
        ops: [
          { op: 'add', path: '/Acc', value: 'Enabled', human: 'Acc -> baseline value' },
          { op: 'remove', path: '/Extra', human: 'Extra -> remove (undeclared, not in baseline)' },
        ],
      },
    ],
    notRevertable: [],
  });

  it('RESTORE ops are pre-selected; REMOVE ops start unselected with a (REMOVE) label', () => {
    const options = revertSelectOptions(plan());
    expect(options).toHaveLength(3);
    expect(options[0]).toMatchObject({ selected: true });
    expect(options[0]!.label).toBe('Stack/Rule: State -> deployed-template value');
    expect(options[1]).toMatchObject({ selected: true });
    const remove = options[2]!;
    expect(remove.selected).toBe(false);
    expect(remove.label).toContain('(REMOVE)');
  });

  it('filterRevertPlan keeps only the picked ops and drops emptied items', () => {
    const options = revertSelectOptions(plan());
    // pick only the bucket's restore op
    const filtered = filterRevertPlan(plan(), new Set([options[1]!.value]));
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]!.logicalId).toBe('B');
    expect(filtered.items[0]!.ops).toHaveLength(1);
    expect(filtered.items[0]!.ops[0]!.path).toBe('/Acc');
  });

  it('picking nothing empties the plan (the caller aborts)', () => {
    expect(filterRevertPlan(plan(), new Set()).items).toHaveLength(0);
  });

  it('notRevertable carries through untouched', () => {
    const p = {
      ...plan(),
      notRevertable: [{ displayId: 'X', resourceType: 'T', path: 'P', reason: 'r' }],
    };
    expect(filterRevertPlan(p, new Set()).notRevertable).toHaveLength(1);
  });
});

describe('formatSurvivingDrift (R52 — cap the post-revert survivor list)', () => {
  const survivors = (n: number): Finding[] =>
    Array.from({ length: n }, (_, i) => ({
      tier: 'undeclared' as const,
      logicalId: `R${i}`,
      resourceType: 'AWS::X::Y',
      path: 'P',
    }));

  it('lists every survivor when at or under the cap', () => {
    const lines = formatSurvivingDrift(survivors(3));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('  - R0.P (undeclared)');
  });

  it('folds beyond the cap with a pointer to `cdkrd check`', () => {
    const lines = formatSurvivingDrift(survivors(113));
    expect(lines).toHaveLength(11); // 10 entries + the fold line
    expect(lines[10]).toContain('and 103 more');
    expect(lines[10]).toContain('cdkrd check');
  });

  it('prefers the construct path and omits an empty path segment', () => {
    const lines = formatSurvivingDrift([
      {
        tier: 'deleted',
        logicalId: 'B',
        constructPath: 'Stack/Bucket',
        resourceType: 'AWS::S3::Bucket',
        path: '',
      },
    ]);
    expect(lines[0]).toBe('  - Stack/Bucket (deleted)');
  });
});

describe('acceptSelectMessage (R49 — multiselect key hints)', () => {
  it('spells out the clack keys: space / a / i / enter (clack shows no hints by default)', () => {
    const msg = acceptSelectMessage('ApiStack');
    expect(msg).toContain('ApiStack: select undeclared value(s) to accept');
    expect(msg).toContain('unselected stay reported');
    expect(msg).toContain('space = toggle');
    expect(msg).toContain('a = toggle all');
    expect(msg).toContain('i = invert');
    expect(msg).toContain('enter = confirm');
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

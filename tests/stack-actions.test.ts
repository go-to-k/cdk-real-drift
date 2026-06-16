import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CloudControlClient,
  GetResourceCommand,
  UpdateResourceCommand,
} from '@aws-sdk/client-cloudcontrol';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { BaselineFile } from '../src/baseline/baseline-file.js';
import { baselinePath, buildRecorded, recordedKey } from '../src/baseline/baseline-file.js';
import type { GatherResult } from '../src/commands/gather.js';
import type { Desired } from '../src/desired/template-adapter.js';
import {
  ignoreSelectMessage,
  ignoreStack,
  recordScopeNote,
  recordSelectMessage,
  recordStack,
  availableActions,
  filterRevertPlan,
  formatPlan,
  formatSurvivingDrift,
  includeUnrecordedRemovals,
  resolveInteractiveRevertExit,
  revertConfirmMessage,
  revertSelectOptions,
  revertStack,
} from '../src/commands/stack-actions.js';

describe('includeUnrecordedRemovals (R113 — surface undeclared REMOVE in a gated prompt)', () => {
  it('the explicit --remove-unrecorded flag always includes removals', () => {
    expect(includeUnrecordedRemovals(true, false, false)).toBe(true);
    expect(includeUnrecordedRemovals(true, true, true)).toBe(true); // even with --yes
  });
  it('interactive without --yes includes them (the multiselect gates per-item)', () => {
    expect(includeUnrecordedRemovals(false, true, false)).toBe(true);
  });
  it('--yes (no multiselect to gate) requires the explicit flag', () => {
    expect(includeUnrecordedRemovals(false, true, true)).toBe(false);
  });
  it('non-interactive (CI/pipe) requires the explicit flag', () => {
    expect(includeUnrecordedRemovals(false, false, false)).toBe(false);
  });
});
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

const baselineWith = (entries: BaselineFile['recorded']): BaselineFile => ({
  schemaVersion: 1,
  stackName: 's',
  region: 'r',
  accountId: '111122223333',
  capturedAt: '',
  templateHash: '',
  recorded: entries,
});

describe('availableActions (R28 interactive choice logic)', () => {
  it('declared-only → Record hidden (cannot record declared), Ignore + Revert shown', () => {
    expect(availableActions([declared()], undefined, NO_SCHEMAS, false)).toEqual({
      record: false,
      ignore: true,
      revert: true,
    });
  });

  it('unrecorded-only → Record + Ignore shown, Revert hidden (no recorded state to restore, R62)', () => {
    // applyBaseline tags entry-less values on never-complete resources as unrecorded
    expect(
      availableActions([{ ...undeclared(), unrecorded: true }], undefined, NO_SCHEMAS, false)
    ).toEqual({
      record: true,
      ignore: true,
      revert: false,
    });
  });

  it('unrecorded-only with --remove-unrecorded → Revert becomes available', () => {
    expect(
      availableActions([{ ...undeclared(), unrecorded: true }], undefined, NO_SCHEMAS, true)
    ).toEqual({
      record: true,
      ignore: true,
      revert: true,
    });
  });

  it('deleted-only → none (deleted is not revertable, not ignorable, nothing to record)', () => {
    expect(availableActions([deleted()], undefined, NO_SCHEMAS, false)).toEqual({
      record: false,
      ignore: false,
      revert: false,
    });
  });

  // PR4: `added` is now record-able (the resource-level sibling of undeclared).
  const addedFinding = (): Finding => ({
    tier: 'added',
    logicalId: 'Api/abc|root|ANY',
    resourceType: 'AWS::ApiGateway::Method',
    path: '',
    physicalId: 'abc|root|ANY',
    actual: { HttpMethod: 'ANY' },
  });

  it('recorded-changed added → Record + Ignore + Revert all shown (revert DELETEs it)', () => {
    expect(availableActions([addedFinding()], undefined, NO_SCHEMAS, false)).toEqual({
      record: true,
      ignore: true,
      revert: true,
    });
  });

  it('unrecorded added → Record + Ignore shown; Revert guarded (no --remove-unrecorded)', () => {
    expect(
      availableActions([{ ...addedFinding(), unrecorded: true }], undefined, NO_SCHEMAS, false)
    ).toEqual({
      record: true,
      ignore: true,
      revert: false,
    });
  });

  it('unrecorded added with --remove-unrecorded → Revert becomes available (DELETE)', () => {
    expect(
      availableActions([{ ...addedFinding(), unrecorded: true }], undefined, NO_SCHEMAS, true)
    ).toEqual({
      record: true,
      ignore: true,
      revert: true,
    });
  });

  it('mixed declared + undeclared (with baseline making undeclared revertable) → all', () => {
    const b = baselineWith([
      {
        logicalId: 'B',
        resourceType: 'AWS::S3::Bucket',
        path: 'AccelerateConfiguration',
        value: { AccelerationStatus: 'Suspended' },
      },
    ]);
    // undeclared is recorded-then-changed → revertable to the baseline value; declared → revertable
    expect(availableActions([declared(), undeclared()], b, NO_SCHEMAS, false)).toEqual({
      record: true,
      ignore: true,
      revert: true,
    });
  });

  it('R141: clean stack + NO baseline → Record offered (establish the day-1 baseline)', () => {
    expect(availableActions([], undefined, NO_SCHEMAS, false)).toEqual({
      record: true,
      ignore: false,
      revert: false,
    });
  });

  it('R141: clean stack WITH a baseline → nothing offered (no establish nag)', () => {
    expect(availableActions([], baselineWith([]), NO_SCHEMAS, false)).toEqual({
      record: false,
      ignore: false,
      revert: false,
    });
  });

  it('R141: drift + NO baseline → establish NOT mixed in (Record gated off, only its real actions)', () => {
    // declared drift on a never-recorded stack: Record must NOT appear wearing the
    // "all undeclared" label for a declared drift it cannot address.
    expect(availableActions([declared()], undefined, NO_SCHEMAS, false)).toEqual({
      record: false,
      ignore: true,
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

  it('unrecordedGuidance explains the record-vs-remove FORK, not a sequence (R55/R62)', () => {
    const plan: RevertPlan = { items: [], notRevertable: [nr('unrecorded — x')] };
    const lines = formatPlan('MyStack', 'r', plan, { unrecordedGuidance: true });
    expect(lines[1]).toBe(
      '\nnote: MyStack has unrecorded value(s) — never recorded, so there is no recorded state to restore.'
    );
    expect(lines[2]).toContain('If the live values are RIGHT, record them');
    expect(lines[3]).toContain('REMOVED, re-run revert with --remove-unrecorded');
  });
});

describe('revertSelectOptions / filterRevertPlan distinguish ELB attribute-bag ops', () => {
  // Every ELB attribute-bag op shares ONE op.path (/LoadBalancerAttributes) and is
  // distinguished only by its attributeKey. The multiselect row key must include the
  // attributeKey, else all bag attributes collapse to one row and toggle together —
  // the user can't deselect a single attribute.
  const plan: RevertPlan = {
    items: [
      {
        logicalId: 'LB',
        displayId: 'Stack/LB',
        resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        physicalId: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/x/y',
        kind: 'sdk',
        ops: [
          {
            op: 'add',
            path: '/LoadBalancerAttributes',
            attributeKey: 'idle_timeout.timeout_seconds',
            value: '120',
            human: 'idle_timeout.timeout_seconds -> 120',
          },
          {
            op: 'add',
            path: '/LoadBalancerAttributes',
            attributeKey: 'deletion_protection.enabled',
            value: 'true',
            human: 'deletion_protection.enabled -> true',
          },
        ],
      },
    ],
    notRevertable: [],
  };

  it('emits a DISTINCT multiselect value per attribute (not collapsed to one)', () => {
    const opts = revertSelectOptions(plan);
    expect(opts).toHaveLength(2);
    expect(new Set(opts.map((o) => o.value)).size).toBe(2);
  });

  it('filterRevertPlan can keep just ONE attribute of the bag', () => {
    const opts = revertSelectOptions(plan);
    const filtered = filterRevertPlan(plan, new Set([opts[0]!.value]));
    expect(filtered.items[0]!.ops).toHaveLength(1);
    expect(filtered.items[0]!.ops[0]!.attributeKey).toBe('idle_timeout.timeout_seconds');
  });
});

describe('revertStack exit semantics (R35 — drift with nothing revertable is exit 1)', () => {
  // findings-only params: every path under test returns BEFORE any AWS client is
  // used — either nothing is revertable, or --dry-run returns at the preview branch.
  type Overrides = { removeUnrecorded?: boolean; dryRun?: boolean };
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
    removeUnrecorded: over.removeUnrecorded ?? false,
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
      'note: s has unrecorded value(s) — never recorded, so there is no recorded state to restore.'
    );
    expect(out).toContain('NOT revertable: 1 (unrecorded — record it if the live value is right');
    expect(out).toContain('nothing revertable — 1 unrecorded value(s) remain.');
  });

  it('--remove-unrecorded: unrecorded note is suppressed; the plan removes the value', async () => {
    // dry-run returns at the preview branch (no AWS write). The note would contradict
    // a plan that DOES remove the value, so it must not appear (R35 review).
    const { outcome, logs } = await captured([undeclared()], {
      removeUnrecorded: true,
      dryRun: true,
    });
    expect(outcome).toEqual({ exit: 0, aborted: false });
    const out = logs.join('\n');
    expect(out).not.toContain('has unrecorded value(s) — never recorded');
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
      liveByLogical: new Map(),
    }) as GatherResult;

  const params = () => ({
    stackName: 's',
    region: 'r',
    gathered: gathered(),
    baseline: undefined,
    config: { ignore: [] },
    dryRun: false,
    yes: true,
    removeUnrecorded: false,
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

describe('recordStack non-interactive refusal (R38)', () => {
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
      const result = await recordStack({
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
      'error: record needs a decision — pass --yes to record ALL undeclared values, or run interactively'
    );
  });

  it('yes:true → records ALL undeclared values with no prompt (regression)', async () => {
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
      const result = await recordStack({
        stackName: desired.stackName,
        region: desired.region,
        desired,
        findings: [undeclared()],
        yes: true,
        interactive: false, // ignored when yes:true — --yes records all regardless
      });
      expect(result).toEqual({ wrote: true, refused: false });
      expect(existsSync(path)).toBe(true);
      const written = JSON.parse(readFileSync(path, 'utf8')) as BaselineFile;
      // the full undeclared set is recorded (no selective multiselect under --yes)
      expect(written.recorded).toEqual([
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

describe('recordStack preselectedKeys (R121 — per-finding path skips the multiselect)', () => {
  it('records exactly the preselected undeclared values, no prompt', async () => {
    const desired = {
      stackName: 'R121Stack',
      region: 'r121-region',
      accountId: '999988887777',
      resources: [],
      rawTemplate: '{}',
      ctx: {},
    } as unknown as Desired;
    const path = baselinePath(desired.stackName, desired.accountId, desired.region);
    if (existsSync(path)) rmSync(path);

    const a = undeclared(); // logicalId B, path AccelerateConfiguration
    const b: Finding = { ...undeclared(), path: 'OwnershipControls', actual: { Rules: [] } };
    // pick only `a`
    const keyA = recordedKey(buildRecorded([a])[0]!);

    const errs: string[] = [];
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((m?: unknown) => void errs.push(String(m)));
    try {
      const result = await recordStack({
        stackName: desired.stackName,
        region: desired.region,
        desired,
        findings: [a, b],
        yes: false,
        interactive: true,
        preselectedKeys: new Set([keyA]),
      });
      expect(result).toEqual({ wrote: true, refused: false });
      const written = JSON.parse(readFileSync(path, 'utf8')) as BaselineFile;
      // only `a` recorded; `b` stays unrecorded (was not preselected)
      expect(written.recorded.map((e) => e.path)).toEqual(['AccelerateConfiguration']);
    } finally {
      spy.mockRestore();
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

  it('R137: EVERY op starts UNSELECTED (revert writes to AWS — nothing pre-armed)', () => {
    const options = revertSelectOptions(plan());
    expect(options).toHaveLength(3);
    // RESTORE ops (declared/baseline) are no longer pre-selected …
    expect(options[0]).toMatchObject({ selected: false });
    expect(options[0]!.label).toBe('Stack/Rule: State -> deployed-template value');
    expect(options[1]).toMatchObject({ selected: false });
    // … and REMOVE ops stay unselected, still carrying the (REMOVE) label.
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

  it('a `delete`-kind item (added resource) gets a loud (DELETE) marker, unselected', () => {
    const delPlan: RevertPlan = {
      items: [
        {
          logicalId: 'Api/abc|root|ANY',
          displayId: 'Stack/Api ▸ ANY /',
          resourceType: 'AWS::ApiGateway::Method',
          physicalId: 'abc|root|ANY',
          kind: 'delete',
          ops: [{ op: 'remove', path: '', human: 'DELETE out-of-band AWS::ApiGateway::Method' }],
        },
      ],
      notRevertable: [],
    };
    const [opt] = revertSelectOptions(delPlan);
    expect(opt!.selected).toBe(false); // destructive — never pre-armed
    expect(opt!.label).toContain('(DELETE)');
    expect(opt!.label).toContain('Stack/Api ▸ ANY /');
    // round-trips through filterRevertPlan (the pseudo-op is selectable by its key)
    expect(filterRevertPlan(delPlan, new Set([opt!.value])).items).toHaveLength(1);
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

describe('recordSelectMessage (R49, R116 — bulkMultiselect renders the key hints now)', () => {
  it('is the one-line prompt header only (the space/→/←/enter hints live in bulkMultiselect)', () => {
    const msg = recordSelectMessage('ApiStack');
    expect(msg).toContain('ApiStack: select undeclared value(s) to record');
    expect(msg).toContain('unselected stay reported');
    // the hint line moved into bulkMultiselect's render — the header is now single-line
    expect(msg).not.toContain('\n');
    expect(msg).not.toContain('toggle all');
  });
});

describe('recordScopeNote (R117 — record snapshots undeclared + added; say what it did NOT approve)', () => {
  const added = (): Finding => ({
    tier: 'added',
    logicalId: 'Api/abc|root|ANY',
    resourceType: 'AWS::ApiGateway::Method',
    path: '',
    physicalId: 'abc|root|ANY',
  });

  it('returns undefined when there is no declared/deleted drift (nothing left unapproved)', () => {
    expect(recordScopeNote('ApiStack', [undeclared(), undeclared()])).toBeUndefined();
    expect(recordScopeNote('ApiStack', [])).toBeUndefined();
  });

  it('PR4: an `added` resource alone leaves nothing unapproved (record now snapshots it)', () => {
    expect(recordScopeNote('ApiStack', [added(), undeclared()])).toBeUndefined();
  });

  it('names ONLY the declared/deleted count (added is approved by record) + how to resolve', () => {
    const note = recordScopeNote('ApiStack', [declared(), deleted(), added(), undeclared()]);
    expect(note).toContain('ApiStack');
    expect(note).toContain('2 declared/deleted drift NOT approved');
    expect(note).toContain('undeclared + added state into the baseline only');
    // resolution now includes `cdkrd ignore` (declared drift is ignorable in-tool)
    expect(note).toContain('cdkrd ignore');
    expect(note).toMatch(/cdkrd revert|cdk deploy/);
  });
});

describe('ignoreSelectMessage', () => {
  it('is a one-line header naming the stack + that it writes config.json', () => {
    const msg = ignoreSelectMessage('ApiStack');
    expect(msg).toContain('ApiStack');
    expect(msg).toContain('config.json');
    expect(msg).not.toContain('\n');
  });
});

describe('ignoreStack (PR-B — write config.json ignore rules; declared + undeclared)', () => {
  let dir: string;
  let prevCwd: string;
  beforeEach(async () => {
    prevCwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'cdkrd-ignst-'));
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(prevCwd);
    await rm(dir, { recursive: true, force: true });
  });

  it('no declared/undeclared findings → nothing to ignore, no file written', async () => {
    const deleted: Finding = {
      tier: 'deleted',
      logicalId: 'B',
      resourceType: 'AWS::S3::Bucket',
      path: '',
    };
    const r = await ignoreStack({
      stackName: 'S',
      findings: [deleted],
      yes: true,
      interactive: false,
    });
    expect(r).toEqual({ wrote: false, refused: false, added: 0 });
    expect(existsSync('.cdkrd/config.json')).toBe(false);
  });

  it('yes:false + interactive:false → refuses (a required decision, like record)', async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
      errs.push(String(m));
    });
    try {
      const r = await ignoreStack({
        stackName: 'S',
        findings: [declared()],
        yes: false,
        interactive: false,
      });
      expect(r).toEqual({ wrote: false, refused: true, added: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(existsSync('.cdkrd/config.json')).toBe(false);
    expect(errs.join('\n')).toContain('ignore needs a decision');
  });

  it('yes:true → writes a rule for every declared + undeclared finding', async () => {
    const r = await ignoreStack({
      stackName: 'S',
      findings: [declared(), undeclared()],
      yes: true,
      interactive: false,
    });
    expect(r.wrote).toBe(true);
    expect(r.added).toBe(2);
    expect(JSON.parse(await readFile('.cdkrd/config.json', 'utf8')).ignore).toEqual([
      { path: 'B.AccelerateConfiguration' },
      { path: 'B.VersioningConfiguration' },
    ]);
  });

  it('yes:true is idempotent — re-ignoring already-present rules writes nothing new', async () => {
    await ignoreStack({ stackName: 'S', findings: [declared()], yes: true, interactive: false });
    const r = await ignoreStack({
      stackName: 'S',
      findings: [declared()],
      yes: true,
      interactive: false,
    });
    expect(r.wrote).toBe(false);
    expect(r.added).toBe(0);
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

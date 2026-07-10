import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CloudControlClient,
  GetResourceCommand,
  UpdateResourceCommand,
} from '@aws-sdk/client-cloudcontrol';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { BaselineFile } from '../src/baseline/baseline-file.js';
import { baselinePath, buildRecorded, recordedKey } from '../src/baseline/baseline-file.js';
import type { GatherResult } from '../src/commands/gather.js';
import { type CdkrdConfig, loadConfig } from '../src/config/config-file.js';
import type { Desired } from '../src/desired/template-adapter.js';
import {
  ignoreSelectMessage,
  ignoreStack,
  recordOutcomeMessage,
  recordScopeNote,
  recordSelectMessage,
  recordStack,
  splitFoldedNested,
  availableActions,
  filterRevertPlan,
  formatPlan,
  formatSurvivingDrift,
  ignoreSelectOptions,
  includeUnrecordedRemovals,
  resolveInteractiveRevertExit,
  revertConfirmMessage,
  revertSelectMessage,
  revertSelectOptions,
  revertStack,
  stackLabel,
  summarizeRevertResults,
  warnStackStatus,
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
  it('declared-only + NO baseline → Record SHOWN (establish + start watching; declared stays reported), Ignore + Revert too', () => {
    // A declared drift no longer blocks establishing the day-1 baseline: Record begins
    // undeclared watching (orthogonal to the declared drift, which keeps being reported).
    expect(availableActions([declared()], undefined, NO_SCHEMAS, false)).toEqual({
      record: true,
      ignore: true,
      revert: true,
    });
  });

  it('declared-only WITH a baseline → Record hidden (baseline exists, nothing new undeclared to snapshot)', () => {
    expect(availableActions([declared()], baselineWith([]), NO_SCHEMAS, false)).toEqual({
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

  it('deleted-only + NO baseline → only Record (establish day-1 baseline); deleted is not revertable/ignorable, and snapshots nothing', () => {
    // Record here establishes the baseline (starts undeclared watching). The deleted finding
    // itself stays unaddressable: not revertable, not ignorable, and never recorded.
    expect(availableActions([deleted()], undefined, NO_SCHEMAS, false)).toEqual({
      record: true,
      ignore: false,
      revert: false,
    });
  });

  it('deleted-only WITH a baseline → none (baseline exists, deleted is unaddressable)', () => {
    expect(availableActions([deleted()], baselineWith([]), NO_SCHEMAS, false)).toEqual({
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

  it('a resource split into a cc item + a prop-scoped sdk item renders ONE block (not two)', () => {
    // e.g. a Logs LogGroup whose RetentionInDays reverts via Cloud Control while
    // BearerTokenAuthenticationEnabled reverts via the SDK writer — two plan items, same
    // logical id. The listing must merge them into one header + all ops.
    const plan: RevertPlan = {
      items: [
        {
          logicalId: 'LG',
          displayId: 'Stack/LogGroup',
          resourceType: 'AWS::Logs::LogGroup',
          physicalId: '/aws/lambda/fn',
          kind: 'cc',
          ops: [
            {
              op: 'add',
              path: '/RetentionInDays',
              value: 731,
              human: 'RetentionInDays -> deployed-template value',
            },
          ],
        },
        {
          logicalId: 'LG',
          displayId: 'Stack/LogGroup',
          resourceType: 'AWS::Logs::LogGroup',
          physicalId: '/aws/lambda/fn',
          kind: 'sdk',
          ops: [
            {
              op: 'remove',
              path: '/BearerTokenAuthenticationEnabled',
              human: 'BearerTokenAuthenticationEnabled -> remove (undeclared, not in baseline)',
            },
          ],
        },
      ],
      notRevertable: [],
    };
    const lines = formatPlan('s', 'r', plan, {});
    expect(lines.filter((l) => l === '\n  Stack/LogGroup (AWS::Logs::LogGroup)')).toHaveLength(1);
    expect(lines).toContain('    - RetentionInDays -> deployed-template value');
    expect(lines).toContain(
      '    - BearerTokenAuthenticationEnabled -> remove (undeclared, not in baseline)'
    );
  });
});

describe('summarizeRevertResults (one outcome per resource even when it split into cc+sdk items)', () => {
  it('all items for a resource ok -> a single reverted entry', () => {
    const out = summarizeRevertResults([
      { logicalId: 'LG', displayId: 'Stack/LogGroup', ok: true },
      { logicalId: 'LG', displayId: 'Stack/LogGroup', ok: true },
    ]);
    expect(out).toEqual([{ displayId: 'Stack/LogGroup', ok: true }]);
  });

  it('any item failing -> a single FAILED entry joining the errors (never a duplicate success)', () => {
    const out = summarizeRevertResults([
      { logicalId: 'LG', displayId: 'Stack/LogGroup', ok: true },
      { logicalId: 'LG', displayId: 'Stack/LogGroup', ok: false, error: 'boom' },
    ]);
    expect(out).toEqual([{ displayId: 'Stack/LogGroup', ok: false, error: 'boom' }]);
  });

  it('distinct resources keep distinct entries in first-seen order', () => {
    const out = summarizeRevertResults([
      { logicalId: 'B', displayId: 'Stack/B', ok: true },
      { logicalId: 'A', displayId: 'Stack/A', ok: false, error: 'e1' },
      { logicalId: 'A', displayId: 'Stack/A', ok: false, error: 'e2' },
    ]);
    expect(out).toEqual([
      { displayId: 'Stack/B', ok: true },
      { displayId: 'Stack/A', ok: false, error: 'e1; e2' },
    ]);
  });

  it('carries a transient hint through on a failed entry (issue #467)', () => {
    const out = summarizeRevertResults([
      {
        logicalId: 'RR',
        displayId: 'Stack/ResolverRule',
        ok: false,
        error: '[RSLVR-00705] currently updating',
        hint: 'retry in a few minutes',
      },
    ]);
    expect(out).toEqual([
      {
        displayId: 'Stack/ResolverRule',
        ok: false,
        error: '[RSLVR-00705] currently updating',
        hint: 'retry in a few minutes',
      },
    ]);
  });

  it('deduplicates identical hints from a cc+sdk split into one', () => {
    const out = summarizeRevertResults([
      { logicalId: 'X', displayId: 'Stack/X', ok: false, error: 'e1', hint: 'retry later' },
      { logicalId: 'X', displayId: 'Stack/X', ok: false, error: 'e2', hint: 'retry later' },
    ]);
    expect(out).toEqual([
      { displayId: 'Stack/X', ok: false, error: 'e1; e2', hint: 'retry later' },
    ]);
  });

  it('omits the hint entirely for a plain (non-transient) failure', () => {
    const out = summarizeRevertResults([
      { logicalId: 'Y', displayId: 'Stack/Y', ok: false, error: 'AccessDenied' },
    ]);
    expect(out).toEqual([{ displayId: 'Stack/Y', ok: false, error: 'AccessDenied' }]);
    expect(out[0]).not.toHaveProperty('hint');
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
  type Overrides = { removeUnrecorded?: boolean; dryRun?: boolean; config?: CdkrdConfig };
  const params = (findings: Finding[], over: Overrides = {}) => ({
    stackName: 's',
    region: 'r',
    gathered: {
      desired: { accountId: '111122223333', resources: [], rawTemplate: '' },
      findings,
      schemas: NO_SCHEMAS,
    } as unknown as GatherResult,
    baseline: undefined,
    config: over.config ?? { ignore: [] },
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
    // #1096: the refusal reason is carried on the outcome (for the --json element)
    expect(outcome).toEqual({
      exit: 1,
      aborted: false,
      refusedReason: 'nothing revertable — 1 drift(s) remain.',
    });
    const out = logs.join('\n');
    expect(out).toContain('NOT revertable: 1 (deleted — recreate via cdk deploy)');
    expect(out).toContain('nothing revertable — 1 drift(s) remain.');
  });

  it('unrecorded values (no baseline) -> unrecorded guidance + exit 1, named as unrecorded not drift', async () => {
    // revertStack's own applyBaseline tags the no-baseline findings as unrecorded
    const { outcome, logs } = await captured([undeclared()]);
    expect(outcome).toMatchObject({ exit: 1, aborted: false });
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
    // #1096: the dry-run outcome carries the would-apply counts (1 op on 1 resource) so the
    // --json element is not mistaken for a clean no-op.
    expect(outcome).toEqual({
      exit: 0,
      aborted: false,
      plannedOps: 1,
      plannedResources: 1,
    });
    const out = logs.join('\n');
    expect(out).not.toContain('has unrecorded value(s) — never recorded');
    expect(out).toContain('remove (undeclared, not in baseline)'); // a real revert item is planned
    expect(out).toContain('(dry-run) would apply');
  });

  // Threading guard: revertStack must pass gathered.desired.accountId (here
  // '111122223333') into applyIgnores' ACCOUNT slot — not the region ('r') or stack
  // ('s'). An account-scoped ignore rule that matches the gathered account suppresses the
  // finding (-> "no drift to revert"); the same rule with a non-matching account does NOT.
  // A region/account transposition at the call site would flip the matching case to exit 1.
  it('an account-scoped ignore rule matching the gathered account suppresses the finding', async () => {
    const { outcome, logs } = await captured([undeclared()], {
      config: { ignore: [{ path: 'B.AccelerateConfiguration', account: '111122223333' }] },
    });
    expect(outcome).toEqual({ exit: 0, aborted: false });
    expect(logs.join('\n')).toContain('no drift to revert.');
  });

  it('an account-scoped ignore rule with a NON-matching account does NOT suppress it', async () => {
    const { outcome, logs } = await captured([undeclared()], {
      config: { ignore: [{ path: 'B.AccelerateConfiguration', account: '999999999999' }] },
    });
    expect(outcome).toMatchObject({ exit: 1, aborted: false }); // still unrecorded drift, not ignored
    expect(logs.join('\n')).toContain('unrecorded value(s) remain.');
  });
});

describe('revertStack --json plan-info carriage (#1096 — dry-run counts + refused reason)', () => {
  // A revertable DECLARED drift so the plan has real items (1 op on 1 resource): the bucket
  // has a live template resource whose declared VersioningConfiguration diverged.
  const gathered = () =>
    ({
      desired: {
        accountId: '111122223333',
        resources: [
          {
            logicalId: 'B',
            resourceType: 'AWS::S3::Bucket',
            physicalId: 'b-phys',
            declared: { VersioningConfiguration: { Status: 'Enabled' } },
          },
        ],
        rawTemplate: '',
      },
      findings: [declared()],
      schemas: NO_SCHEMAS,
    }) as unknown as GatherResult;

  const params = (over: Partial<{ dryRun: boolean; yes: boolean; interactive: boolean }> = {}) => ({
    stackName: 's',
    region: 'r',
    gathered: gathered(),
    baseline: undefined,
    config: { ignore: [] },
    dryRun: over.dryRun ?? false,
    yes: over.yes ?? true,
    removeUnrecorded: false,
    verbose: false,
    interactive: over.interactive ?? true,
  });

  const run = async (over: Parameters<typeof params>[0] = {}) => {
    const logs: string[] = [];
    const errs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (s: unknown) => logs.push(String(s));
    console.error = (s: unknown) => errs.push(String(s));
    try {
      return { outcome: await revertStack(params(over)), logs, errs };
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  };

  it('--dry-run carries plannedOps + plannedResources (not a no-op-looking element)', async () => {
    const { outcome, logs } = await run({ dryRun: true });
    expect(outcome).toEqual({
      exit: 0,
      aborted: false,
      plannedOps: 1,
      plannedResources: 1,
    });
    // the human summary reports the SAME counts
    expect(logs.join('\n')).toContain('(dry-run) would apply 1 op(s) to 1 resource(s).');
  });

  it('a non-interactive refusal (no --yes) carries refusedReason', async () => {
    const { outcome, errs } = await run({ yes: false, interactive: false });
    expect(outcome.exit).toBe(2);
    expect(outcome.refusedReason).toContain('refusing to write to AWS non-interactively');
    // reason still surfaces on stderr for a human
    expect(errs.join('\n')).toContain('refusing to write to AWS non-interactively');
  });
});

describe('revertStack convergence re-check (R44 — scoped to touched resources)', () => {
  // #786: revertStack now re-reads StackStatus right before the write (the TOCTOU gate).
  // Mock CloudFormation to a stable state so these convergence tests exercise the apply path
  // (the gate itself is covered by its own describe block below).
  let cfnMock: ReturnType<typeof mockClient>;
  beforeEach(() => {
    cfnMock = mockClient(CloudFormationClient);
    cfnMock
      .on(DescribeStacksCommand)
      .resolves({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' } as never] });
  });
  afterEach(() => cfnMock.restore());

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
    expect(outcome).toMatchObject({ exit: 0, aborted: false });
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
    expect(outcome).toMatchObject({ exit: 0, aborted: false });
    expect(logs).toContain('s: CLEAN after revert.');
    expect(cc.commandCalls(GetResourceCommand)).toHaveLength(2);
  });

  it('still drifted after the retry → "1 drift(s) remain." + exit 1', async () => {
    const cc = mockClient(CloudControlClient);
    mockApplySuccess(cc);
    cc.on(GetResourceCommand).resolves(liveRead('Suspended'));

    const { outcome, logs } = await run();
    expect(outcome).toMatchObject({ exit: 1, aborted: false });
    expect(logs).toContain('s: 1 drift(s) remain.');
    // R46: each surviving drift is listed (id.path + tier) so the user does not
    // have to re-run `check` just to learn what failed to converge.
    expect(logs).toContain('  - B.VersioningConfiguration.Status (declared)');
    expect(cc.commandCalls(GetResourceCommand)).toHaveLength(2); // first read + one retry, no more
  });

  it('verification re-read FAILS → NOT "CLEAN", exit 1 (a skipped re-read is not proof the write landed)', async () => {
    // The write was accepted (200), but the convergence re-read throttles, so the
    // touched resource comes back `skipped`. Before the fix this counted as zero drift
    // and printed "CLEAN after revert." with exit 0 — a false success on a possibly-
    // failed write. Now it is reported as unconfirmed and exits 1.
    const cc = mockClient(CloudControlClient);
    mockApplySuccess(cc);
    cc.on(GetResourceCommand).rejects(new Error('ThrottlingException'));

    const { outcome, logs } = await run();
    expect(outcome.exit).toBe(1);
    expect(logs).not.toContain('CLEAN after revert');
    expect(logs).toContain('could not be confirmed converged');
    expect(logs).toContain('could not be re-read to verify');
  });

  // #631: a FAILED update op must NOT ride under a CLEAN verdict even if the re-read
  // happens to look converged — "never claim convergence we could not verify". The SNS
  // FilterPolicyScope `remove` hard-failed (InvalidRequest[null]) yet the summary still
  // said CLEAN. Here the write FAILS (non-transient) but the re-read returns the desired
  // value; before the fix only failed DELETES fed the verdict, so this printed CLEAN.
  it('a FAILED update op is unconfirmed, never CLEAN — even if the re-read looks converged', async () => {
    const cc = mockClient(CloudControlClient);
    cc.on(UpdateResourceCommand).resolves({
      ProgressEvent: {
        OperationStatus: 'FAILED',
        RequestToken: 't',
        StatusMessage: 'InvalidRequest: Invalid value [null]',
      },
    });
    cc.on(GetResourceCommand).resolves(liveRead('Enabled')); // re-read LOOKS clean

    const { outcome, logs } = await run();
    expect(outcome.exit).toBe(2); // a failed apply bumps the exit to 2
    expect(logs).not.toContain('CLEAN after revert');
    expect(logs).toContain('FAILED:');
    expect(logs).toContain('could not be confirmed converged');
  });

  // #631: a `remove`-style revert the provider SILENTLY IGNORED (reports ok, value
  // persists) on an UNRECORDED undeclared value re-reads as "awaiting a baseline" (not
  // isDrift), so it escaped the verdict and the stack was falsely called CLEAN (Cognito
  // UserPool DeletionProtection remove-revert, live 2026-07-08). Now the persisted value is
  // detected as a no-op removal and reported.
  it('a no-op remove of an unrecorded undeclared value is NOT CLEAN (persisted value detected)', async () => {
    const noopGathered = (): GatherResult =>
      ({
        desired: {
          stackName: 's',
          region: 'r',
          accountId: '111122223333',
          resources: [
            { logicalId: 'B', resourceType: 'AWS::S3::Bucket', physicalId: 'b-phys', declared: {} },
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
        findings: [undeclared()], // AccelerateConfiguration, unrecorded (no baseline)
        schemas: new Map([['AWS::S3::Bucket', EMPTY_SCHEMA]]),
        liveByLogical: new Map(),
      }) as GatherResult;

    const cc = mockClient(CloudControlClient);
    mockApplySuccess(cc); // the UpdateResource "succeeds"...
    // ...but the value persists unchanged (the provider ignored the omitted property).
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Identifier: 'b-phys',
        Properties: JSON.stringify({ AccelerateConfiguration: { AccelerationStatus: 'Enabled' } }),
      },
    });

    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => logs.push(String(s));
    let outcome;
    try {
      outcome = await revertStack({
        ...params(),
        gathered: noopGathered(),
        removeUnrecorded: true,
      });
    } finally {
      console.log = orig;
    }
    const out = logs.join('\n');
    expect(out).not.toContain('CLEAN after revert');
    expect(out).toContain('NOT reverted:');
    expect(out).toContain('AccelerateConfiguration');
    expect(outcome!.exit).toBe(1);
  });

  // issue #467 — the `revert --wait` path.
  const rslvrFailed = {
    ProgressEvent: {
      OperationStatus: 'FAILED' as const,
      RequestToken: 't',
      StatusMessage: "[RSLVR-00705] Cannot update Resolver Rule because it's currently updating.",
    },
  };
  const runWith = async (extra: Record<string, unknown>) => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => logs.push(String(s));
    try {
      const outcome = await revertStack({ ...params(), ...extra } as Parameters<
        typeof revertStack
      >[0]);
      return { outcome, logs: logs.join('\n') };
    } finally {
      console.log = orig;
    }
  };

  it('--wait retries a transient mid-update failure PAST the default attempts until it settles', async () => {
    const cc = mockClient(CloudControlClient);
    // Four RSLVR-00705 failures (past the 3-attempt default), then success.
    cc.on(UpdateResourceCommand)
      .resolvesOnce(rslvrFailed)
      .resolvesOnce(rslvrFailed)
      .resolvesOnce(rslvrFailed)
      .resolvesOnce(rslvrFailed)
      .resolves({ ProgressEvent: { OperationStatus: 'SUCCESS', RequestToken: 't' } });
    cc.on(GetResourceCommand).resolves(liveRead('Enabled'));

    const { outcome, logs } = await runWith({
      waitMs: 600_000,
      waitNow: () => 0, // constant clock < deadline → keep retrying (waitSleep is a no-op)
      waitSleep: () => Promise.resolve(),
    });
    expect(outcome).toMatchObject({ exit: 0, aborted: false });
    expect(cc.commandCalls(UpdateResourceCommand).length).toBe(5); // 4 fails + 1 success
    expect(logs).toMatch(/↻ .*retry 1/); // per-retry progress line printed
    expect(logs).toContain('s: CLEAN after revert.');
  });

  it('without --wait, a persistent transient failure stops after the short backoff and suggests --wait', async () => {
    const cc = mockClient(CloudControlClient);
    cc.on(UpdateResourceCommand).resolves(rslvrFailed);
    cc.on(GetResourceCommand).resolves(liveRead('Suspended')); // still drifted

    const { outcome, logs } = await runWith({
      waitSleep: () => Promise.resolve(), // no-op the DEFAULT backoff so the test is fast
    });
    expect(outcome.exit).toBe(2); // apply failed
    expect(cc.commandCalls(UpdateResourceCommand).length).toBe(3); // default maxAttempts
    expect(logs).toContain('or re-run with --wait to block until it settles');
  });
});

describe('revertStack custom-bus Events::Rule identifier (#1088 — revert must send the rule ARN, not the raw composite)', () => {
  // #1088: PR #1003 taught the READ path (readLive) to pass region+account to the
  // CC_IDENTIFIER_ADAPTERS Events::Rule adapter so a custom-bus rule's `<bus>|<name>`
  // composite becomes the full rule ARN. But the REVERT-side call site omitted
  // region/account — so with the common CDK `EventBusName: { Ref: Bus }` (which resolves
  // to the bare bus NAME, not the bus ARN) the adapter fell through to `undefined` and the
  // `?? item.physicalId` fallback sent the raw `myBus|myRule` composite to UpdateResource →
  // ValidationException → exit 2. The fix threads region + gathered.desired.accountId into
  // both revert call sites so the region/account branch fires and the ARN is built.
  // #786: stub the pre-write StackStatus re-read to a stable state (see gate below).
  let cfnMock: ReturnType<typeof mockClient>;
  beforeEach(() => {
    cfnMock = mockClient(CloudFormationClient);
    cfnMock
      .on(DescribeStacksCommand)
      .resolves({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' } as never] });
  });
  afterEach(() => cfnMock.restore());

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

  // A declared State drift on a rule bound to a CUSTOM bus. The physical id is the
  // `<busName>|<ruleName>` composite; EventBusName resolves to the bare bus NAME (the
  // Ref-of-EventBus case), so ONLY the region/account adapter branch can build the ARN.
  const ruleDrift = (): Finding => ({
    tier: 'declared',
    logicalId: 'R',
    resourceType: 'AWS::Events::Rule',
    path: 'State',
    physicalId: 'myBus|myRule',
    desired: 'ENABLED',
    actual: 'DISABLED',
  });

  const gathered = (): GatherResult =>
    ({
      desired: {
        stackName: 's',
        region: 'us-east-1',
        accountId: '111111111111',
        resources: [
          {
            logicalId: 'R',
            resourceType: 'AWS::Events::Rule',
            physicalId: 'myBus|myRule',
            declared: { State: 'ENABLED', EventBusName: 'myBus' },
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
      findings: [ruleDrift()],
      schemas: new Map([['AWS::Events::Rule', EMPTY_SCHEMA]]),
      liveByLogical: new Map(),
    }) as GatherResult;

  const params = () => ({
    stackName: 's',
    region: 'us-east-1',
    gathered: gathered(),
    baseline: undefined,
    config: { ignore: [] },
    dryRun: false,
    yes: true,
    removeUnrecorded: false,
    verbose: false,
    interactive: false,
    convergeRetryDelayMs: 0,
  });

  it('sends the full rule ARN as the UpdateResource identifier (region/account branch), NOT the raw bus|name composite', async () => {
    const cc = mockClient(CloudControlClient);
    cc.on(UpdateResourceCommand).resolves({
      ProgressEvent: { OperationStatus: 'SUCCESS', RequestToken: 't' },
    });
    // Post-revert convergence re-read: report the desired State so the run reports CLEAN.
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Identifier: 'arn:aws:events:us-east-1:111111111111:rule/myBus/myRule',
        Properties: JSON.stringify({ State: 'ENABLED' }),
      },
    });

    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => logs.push(String(s));
    try {
      await revertStack(params());
    } finally {
      console.log = orig;
    }

    const calls = cc.commandCalls(UpdateResourceCommand);
    expect(calls).toHaveLength(1);
    const ident = calls[0]!.args[0]!.input.Identifier;
    // WITHOUT the fix this is the raw `myBus|myRule` composite (the adapter returns
    // undefined for a bare-name EventBusName when region/account are not threaded through)
    // → ValidationException. WITH the fix it is the full rule ARN.
    expect(ident).toBe('arn:aws:events:us-east-1:111111111111:rule/myBus/myRule');
    expect(ident).not.toBe('myBus|myRule');
  });
});

describe('revertStack stack-stability gate (#786 — refuse a write onto a mid-operation stack)', () => {
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

  // A declared VersioningConfiguration drift on one bucket — a real revertable item, so the
  // run reaches the pre-apply StackStatus gate (dry-run / nothing-revertable return earlier).
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
    interactive: false,
    convergeRetryDelayMs: 0,
  });

  const run = async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (s: unknown) => logs.push(String(s));
    console.error = (s: unknown) => errs.push(String(s));
    try {
      const outcome = await revertStack(params());
      return { outcome, logs: logs.join('\n'), errs: errs.join('\n') };
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  };

  let cfnMock: ReturnType<typeof mockClient>;
  afterEach(() => cfnMock?.restore());

  it('REFUSES (exit 2, NO Cloud Control write) when the pre-apply StackStatus is UPDATE_IN_PROGRESS', async () => {
    cfnMock = mockClient(CloudFormationClient);
    cfnMock
      .on(DescribeStacksCommand)
      .resolves({ Stacks: [{ StackStatus: 'UPDATE_IN_PROGRESS' } as never] });
    const cc = mockClient(CloudControlClient);
    cc.on(UpdateResourceCommand).resolves({
      ProgressEvent: { OperationStatus: 'SUCCESS', RequestToken: 't' },
    });

    const { outcome, errs } = await run();
    expect(outcome.exit).toBe(2);
    expect(outcome.aborted).toBe(false);
    expect(outcome.refusedReason).toContain('mid-operation (UPDATE_IN_PROGRESS)');
    expect(errs).toContain('mid-operation (UPDATE_IN_PROGRESS)');
    // the write must NOT have been issued — the whole point of the TOCTOU gate
    expect(cc.commandCalls(UpdateResourceCommand)).toHaveLength(0);
    cc.restore();
  });

  it('PROCEEDS with the write when the pre-apply StackStatus is a stable *_COMPLETE', async () => {
    cfnMock = mockClient(CloudFormationClient);
    cfnMock
      .on(DescribeStacksCommand)
      .resolves({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE' } as never] });
    const cc = mockClient(CloudControlClient);
    cc.on(UpdateResourceCommand).resolves({
      ProgressEvent: { OperationStatus: 'SUCCESS', RequestToken: 't' },
    });
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Identifier: 'b-phys',
        Properties: JSON.stringify({ VersioningConfiguration: { Status: 'Enabled' } }),
      },
    });

    const { outcome } = await run();
    expect(outcome.exit).toBe(0);
    // the write WAS issued (the stable state let it through)
    expect(cc.commandCalls(UpdateResourceCommand)).toHaveLength(1);
    cc.restore();
  });

  it('FAILS OPEN on a DescribeStacks re-read error — a legitimate revert is not blocked by a transient re-read failure', async () => {
    cfnMock = mockClient(CloudFormationClient);
    cfnMock.on(DescribeStacksCommand).rejects(new Error('ThrottlingException'));
    const cc = mockClient(CloudControlClient);
    cc.on(UpdateResourceCommand).resolves({
      ProgressEvent: { OperationStatus: 'SUCCESS', RequestToken: 't' },
    });
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: {
        Identifier: 'b-phys',
        Properties: JSON.stringify({ VersioningConfiguration: { Status: 'Enabled' } }),
      },
    });

    const { outcome } = await run();
    // not refused: the gather already succeeded, so a transient re-read failure must not block
    expect(outcome.exit).toBe(0);
    expect(cc.commandCalls(UpdateResourceCommand)).toHaveLength(1);
    cc.restore();
  });
});

describe('warnStackStatus (#786 — record / ignore / revert surface the mid-operation warning like check)', () => {
  const capture = (fn: () => void): string => {
    const errs: string[] = [];
    const orig = console.error;
    console.error = (s: unknown) => errs.push(String(s));
    try {
      fn();
    } finally {
      console.error = orig;
    }
    return errs.join('\n');
  };

  it('prints the warning to stderr, matching check.ts wording, when a warning is present', () => {
    const out = capture(() =>
      warnStackStatus(
        'MyStack',
        'stack is mid-operation (UPDATE_IN_PROGRESS) — live state is in flux'
      )
    );
    expect(out).toBe(
      'warning: MyStack: stack is mid-operation (UPDATE_IN_PROGRESS) — live state is in flux'
    );
  });

  it('is a no-op when the stack is stable (no warning)', () => {
    const out = capture(() => warnStackStatus('MyStack', undefined));
    expect(out).toBe('');
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
      expect(result).toMatchObject({ wrote: true, refused: false });
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

describe('recordStack identity guard (#870 — account mismatch throws before consuming existing)', () => {
  it('throws (does not launder) when the existing baseline was captured in another account', async () => {
    // An existing baseline whose stored accountId differs from the current run's account.
    // Without the guard, recordStack would consume it and re-stamp the CURRENT accountId,
    // silently laundering the mismatch. The stack/region match (guarded on load), so only
    // the account axis diverges here.
    const desired = {
      stackName: 'AcctGuardStack',
      region: 'acct-guard-region',
      accountId: '999988887777',
      resources: [],
      rawTemplate: '{}',
      ctx: {},
    } as unknown as Desired;
    const path = baselinePath(desired.stackName, desired.accountId, desired.region);
    mkdirSync(dirname(path), { recursive: true });
    // File at the CURRENT account's path, but its stored accountId is a DIFFERENT account.
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 2,
        stackName: desired.stackName,
        region: desired.region,
        accountId: '111122223333',
        capturedAt: '',
        templateHash: '',
        recorded: [],
      }),
      'utf8'
    );
    try {
      await expect(
        recordStack({
          stackName: desired.stackName,
          region: desired.region,
          desired,
          findings: [undeclared()],
          yes: true,
          interactive: false,
        })
      ).rejects.toThrow(/account 111122223333.*current account is 999988887777/s);
    } finally {
      if (existsSync(path)) rmSync(path);
    }
  });
});

describe('splitFoldedNested (record mirrors the report R96 fold)', () => {
  const fnd = (logicalId: string, path: string, nested?: boolean): Finding =>
    ({
      tier: 'undeclared',
      logicalId,
      resourceType: 'T',
      path,
      actual: 1,
      ...(nested ? { nested: true } : {}),
    }) as Finding;
  const entry = (logicalId: string, path: string) => ({ logicalId, path });

  it('folds nested undeclared values, itemizes the standouts', () => {
    const changed = [entry('A', 'Top'), entry('A', 'Conf.Sub'), entry('A', 'Conf.Other')];
    const findings = [fnd('A', 'Top'), fnd('A', 'Conf.Sub', true), fnd('A', 'Conf.Other', true)];
    const { standout, folded } = splitFoldedNested(changed, findings, false);
    expect(standout.map((e) => e.path)).toEqual(['Top']);
    expect(folded.map((e) => e.path)).toEqual(['Conf.Sub', 'Conf.Other']);
  });

  it('expandNested itemizes everything (nothing folded) — the --verbose fold-expansion', () => {
    const changed = [entry('A', 'Top'), entry('A', 'Conf.Sub')];
    const findings = [fnd('A', 'Top'), fnd('A', 'Conf.Sub', true)];
    const { standout, folded } = splitFoldedNested(changed, findings, true);
    expect(standout).toHaveLength(2);
    expect(folded).toHaveLength(0);
  });

  it('an added-resource / top-level value is never folded (no nested finding)', () => {
    const changed = [entry('A', '')]; // added-resource entry (empty path)
    const { standout, folded } = splitFoldedNested(changed, [], false);
    expect(standout).toHaveLength(1);
    expect(folded).toHaveLength(0);
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
      expect(result).toMatchObject({ wrote: true, refused: false });
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
    const msg = revertConfirmMessage('s', 'us-east-1', 1, 113);
    expect(msg).toContain('Apply 1 revert op(s) to s (us-east-1)? This WRITES to AWS.');
    expect(msg).toContain('Only the 1 selected op(s) are written');
    expect(msg).toContain('113 NOT-revertable finding(s) are untouched');
  });

  it('without NOT-revertable findings, no scope clause (nothing to disclaim)', () => {
    expect(revertConfirmMessage('s', 'us-west-2', 2, 0)).toBe(
      'Apply 2 revert op(s) to s (us-west-2)? This WRITES to AWS.'
    );
  });

  it('names the region (#947 — the AWS-write confirm must say WHICH region it mutates)', () => {
    expect(revertConfirmMessage('Dup', 'eu-west-1', 1, 0)).toContain('to Dup (eu-west-1)?');
  });

  it('two same-named different-region instances produce DISTINCT confirm strings (#947)', () => {
    expect(revertConfirmMessage('Dup', 'us-east-1', 1, 0)).not.toBe(
      revertConfirmMessage('Dup', 'us-west-2', 1, 0)
    );
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

  it('strips the stack/Stage prefix off the construct path when given the stack name', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'PG',
      constructPath: 'my-app/Rds/Database/ParameterGroup',
      resourceType: 'AWS::RDS::DBClusterParameterGroup',
      path: 'Parameters.autocommit',
    };
    expect(formatSurvivingDrift([f], 'my-app-Rds')[0]).toBe(
      '  - Database/ParameterGroup.Parameters.autocommit (undeclared)'
    );
    // no stackName -> full path (unchanged)
    expect(formatSurvivingDrift([f])[0]).toBe(
      '  - my-app/Rds/Database/ParameterGroup.Parameters.autocommit (undeclared)'
    );
  });
});

describe('ignoreSelectOptions', () => {
  const uf = (over: Partial<Finding>): Finding => ({
    tier: 'undeclared',
    logicalId: 'R',
    resourceType: 'AWS::X::Y',
    path: 'P',
    ...over,
  });

  it('starts every row UNSELECTED (a required decision, R137)', () => {
    expect(ignoreSelectOptions([uf({}), uf({ logicalId: 'S' })]).every((o) => !o.selected)).toBe(
      true
    );
  });

  it('labels with the construct path WITHIN the stack when given the stack name', () => {
    const f = uf({
      constructPath: 'my-app/Rds/Database/ParameterGroup',
      path: 'Parameters.autocommit',
    });
    expect(ignoreSelectOptions([f], 'my-app-Rds')[0]!.label).toBe(
      'Database/ParameterGroup.Parameters.autocommit (undeclared)'
    );
    // no stackName -> full construct path
    expect(ignoreSelectOptions([f])[0]!.label).toBe(
      'my-app/Rds/Database/ParameterGroup.Parameters.autocommit (undeclared)'
    );
  });
});

describe('recordSelectMessage (R49, R116 — bulkMultiselect renders the key hints now)', () => {
  it('is the one-line prompt header only (the space/→/←/enter hints live in bulkMultiselect)', () => {
    const msg = recordSelectMessage('ApiStack', 'us-east-1');
    expect(msg).toContain('ApiStack (us-east-1): select undeclared value(s) to record');
    expect(msg).toContain('unselected stay reported');
    // the hint line moved into bulkMultiselect's render — the header is now single-line
    expect(msg).not.toContain('\n');
    expect(msg).not.toContain('toggle all');
  });

  it('discloses that folded sub-keys are ALWAYS recorded when foldedCount > 0', () => {
    const msg = recordSelectMessage('ApiStack', 'us-east-1', 23);
    expect(msg).toContain('23 folded sub-key(s) ALWAYS recorded');
    expect(msg).toContain('--verbose');
    expect(msg).not.toContain('--show-all'); // --show-all is the separate inventory mode
    expect(msg).not.toContain('\n'); // still a single-line header
  });

  it('no folded disclosure when there is nothing folded', () => {
    expect(recordSelectMessage('ApiStack', 'us-east-1', 0)).not.toContain('folded');
    expect(recordSelectMessage('ApiStack', 'us-east-1')).not.toContain('folded');
  });

  it('names the region so a same-named multi-region record is not misendorsed (#947)', () => {
    expect(recordSelectMessage('Dup', 'us-west-2')).toContain('Dup (us-west-2):');
    // two same-named different-region pickers must present DISTINCT headers
    expect(recordSelectMessage('Dup', 'us-east-1')).not.toBe(
      recordSelectMessage('Dup', 'us-west-2')
    );
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

describe('recordOutcomeMessage (R142 — day-1 init is not a cold "0 recorded")', () => {
  it('FIRST baseline on a clean stack (no prior file, 0 entries) reads as an initialization', () => {
    const m = recordOutcomeMessage('ApiStack', '.cdkrd/baselines/ApiStack.x.json', 0, false, false);
    expect(m).toContain('baseline initialized');
    expect(m).toContain('this stack is now tracked');
    expect(m).not.toContain('0 recorded entry(ies)'); // the cold phrasing is gone
  });

  it('with a PRIOR baseline, 0 entries is the normal "written" line (not an init)', () => {
    const m = recordOutcomeMessage('ApiStack', '.cdkrd/baselines/ApiStack.x.json', 0, false, true);
    expect(m).toContain('baseline written');
    expect(m).not.toContain('initialized');
  });

  it('N recorded entries → the normal written line', () => {
    expect(recordOutcomeMessage('ApiStack', 'p', 3, false, false)).toBe(
      'baseline written: p (3 recorded entry(ies))'
    );
  });

  it('refreshedOnly → the refreshed line regardless of prior baseline', () => {
    expect(recordOutcomeMessage('ApiStack', 'p', 5, true, true)).toContain('baseline refreshed');
  });
});

describe('ignoreSelectMessage', () => {
  it('is a one-line header naming the stack + that it writes ignore.yaml', () => {
    const msg = ignoreSelectMessage('ApiStack', 'us-east-1');
    expect(msg).toContain('ApiStack (us-east-1)');
    expect(msg).toContain('ignore.yaml');
    expect(msg).not.toContain('\n');
  });

  it('names the region so a same-named multi-region ignore is not misapplied (#947)', () => {
    expect(ignoreSelectMessage('Dup', 'us-east-1')).not.toBe(
      ignoreSelectMessage('Dup', 'us-west-2')
    );
  });
});

describe('revertSelectMessage (#947 — name the region in the op picker)', () => {
  it('is a one-line header naming the stack + region', () => {
    const msg = revertSelectMessage('ApiStack', 'us-east-1');
    expect(msg).toContain('ApiStack (us-east-1): select the op(s) to revert');
    expect(msg).not.toContain('\n');
  });

  it('two same-named different-region pickers produce DISTINCT headers', () => {
    expect(revertSelectMessage('Dup', 'us-east-1')).not.toBe(
      revertSelectMessage('Dup', 'us-west-2')
    );
  });
});

describe('stackLabel (#947 — the report-matching `Name (region)` decision label)', () => {
  it('matches the report header format', () => {
    expect(stackLabel('Dup', 'us-west-2')).toBe('Dup (us-west-2)');
  });

  it('two same-named different-region labels differ', () => {
    expect(stackLabel('Dup', 'us-east-1')).not.toBe(stackLabel('Dup', 'us-west-2'));
  });
});

describe('ignoreStack (PR-B — write ignore.yaml ignore rules; declared + undeclared)', () => {
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
    expect(existsSync('.cdkrd/ignore.yaml')).toBe(false);
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
    expect(existsSync('.cdkrd/ignore.yaml')).toBe(false);
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
    // append-only writes in finding order (declared first, then undeclared) — not sorted.
    // Each rule is stamped with the stack scope (issue #757); no accountId/region were
    // passed here, so those axes stay omitted (match-any).
    expect((await loadConfig()).ignore).toEqual([
      { path: 'B.VersioningConfiguration', stack: 'S' },
      { path: 'B.AccelerateConfiguration', stack: 'S' },
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

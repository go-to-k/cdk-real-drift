import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import type { BaselineFile } from '../src/baseline/baseline-file.js';
import type { GatherResult } from '../src/commands/gather.js';
import { revertStack } from '../src/commands/stack-actions.js';
import type { Finding, SchemaInfo } from '../src/types.js';

// #756: check's "Decide per finding" flow assigns `revert` to a SUBSET of findings. The
// interactive path calls revertStack with the UNFILTERED findings PLUS `selectedFindingKeys`
// (the chosen subset). revertStack's applyBaseline reconciliation must therefore see the
// FULL live reality — so a recorded entry whose live value is HEALTHY and UNCHANGED (but
// which the user did NOT pick / explicitly skipped) does NOT look "removed since record" and
// synthesize a phantom restore op. The plan must contain ONLY ops for the selected findings.
//
// Before the fix the caller passed the FILTERED findings to revertStack, so applyBaseline's
// `currentPaths` was starved: every unpicked recorded entry synthesized a
// `baseline value removed since record` finding -> an `add` "restore baseline value" op ->
// a same-value / skipped AWS write the user never chose.

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

// The finding-identity key the per-finding action picker builds (interactive-resolve.ts
// keyOf): logicalId::path (+ [attributeKey] when present).
const keyOf = (f: Finding): string => `${f.logicalId}::${f.path}`;

// A recorded undeclared value whose live value CHANGED out of band reads as tier
// `undeclared` (the applyBaseline "recorded value CHANGED -> drift" branch) — a REAL,
// revertable drift. In the per-finding picker the user can `skip` it (leave it unpicked).
const changedRecorded = (logicalId: string, path: string, liveValue: unknown): Finding => ({
  tier: 'undeclared',
  logicalId,
  resourceType: 'AWS::IAM::Role',
  path,
  physicalId: `${logicalId}-phys`,
  actual: liveValue,
});

// A declared drift the user WILL pick for revert.
const declaredDriftD = (): Finding => ({
  tier: 'declared',
  logicalId: 'Rd',
  resourceType: 'AWS::IAM::Role',
  path: 'MaxSessionDuration',
  physicalId: 'Rd-phys',
  desired: 3600,
  actual: 7200,
});

const baseline = (): BaselineFile => ({
  schemaVersion: 2,
  stackName: 's',
  region: 'r',
  accountId: '111122223333',
  capturedAt: '2020-01-01T00:00:00Z',
  templateHash: 'h',
  // Ra + Rb are recorded undeclared values whose live value CHANGED out of band — both are
  // real, revertable drift. In the picker the user leaves them unpicked (skip).
  recorded: [
    { logicalId: 'Ra', resourceType: 'AWS::IAM::Role', path: 'Description', value: 'a-recorded' },
    { logicalId: 'Rb', resourceType: 'AWS::IAM::Role', path: 'Description', value: 'b-recorded' },
  ],
  completeResources: ['Ra', 'Rb', 'Rd'],
});

const gathered = (): GatherResult =>
  ({
    desired: {
      stackName: 's',
      region: 'r',
      accountId: '111122223333',
      resources: [
        { logicalId: 'Ra', resourceType: 'AWS::IAM::Role', physicalId: 'Ra-phys', declared: {} },
        { logicalId: 'Rb', resourceType: 'AWS::IAM::Role', physicalId: 'Rb-phys', declared: {} },
        {
          logicalId: 'Rd',
          resourceType: 'AWS::IAM::Role',
          physicalId: 'Rd-phys',
          declared: { MaxSessionDuration: 3600 },
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
    // The FULL finding set: the two out-of-band-changed recorded values (real drift the user
    // will SKIP) + the declared drift D (the user will REVERT).
    findings: [
      changedRecorded('Ra', 'Description', 'a-live-changed'),
      changedRecorded('Rb', 'Description', 'b-live-changed'),
      declaredDriftD(),
    ],
    schemas: new Map([['AWS::IAM::Role', EMPTY_SCHEMA]]),
    liveByLogical: new Map(),
  }) as GatherResult;

// Run a dry-run revert (no AWS write) and capture the printed plan + returned counts.
const run = async (selectedFindingKeys?: Set<string>) => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (s: unknown) => logs.push(String(s));
  try {
    const outcome = await revertStack({
      stackName: 's',
      region: 'r',
      gathered: gathered(),
      baseline: baseline(),
      config: { ignore: [] },
      dryRun: true, // preview only — no AWS write, but the plan is built + printed
      yes: true,
      removeUnrecorded: true, // so a restore/removal op is NOT gated out for an unrelated reason
      verbose: false,
      interactive: false,
      selectedFindingKeys,
    });
    return { outcome, logs: logs.join('\n') };
  } finally {
    console.log = orig;
  }
};

describe('revertStack #756 — per-finding revert of a SUBSET touches only the selected findings', () => {
  let cfnMock: ReturnType<typeof mockClient>;
  beforeEach(() => {
    cfnMock = mockClient(CloudFormationClient);
    cfnMock
      .on(DescribeStacksCommand)
      .resolves({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' } as never] });
  });
  afterEach(() => cfnMock.restore());

  it('selecting only the declared drift plans ONE op — the SKIPPED recorded drifts (Ra/Rb) are NOT written', async () => {
    // The user picked ONLY the declared drift D; the two out-of-band-changed recorded values
    // Ra and Rb were left unpicked (skip). selectedFindingKeys restricts the plan to D alone.
    const { outcome, logs } = await run(new Set([keyOf(declaredDriftD())]));

    // Exactly one resource / one op — D's revert. WITHOUT the fix (no selectedFindingKeys
    // restriction on the plan), all THREE real drifts reconcile as revertable, so the plan
    // would be 3 resources / 3 ops — writing Ra and Rb the user explicitly SKIPPED.
    expect(outcome.plannedResources).toBe(1);
    expect(outcome.plannedOps).toBe(1);

    // The plan must name D (Rd) and NOTHING about the skipped recorded entries Ra / Rb.
    expect(logs).toContain('MaxSessionDuration');
    expect(logs).not.toContain('Ra');
    expect(logs).not.toContain('Rb');
  });

  it('control: WITHOUT selectedFindingKeys (standalone revert) every reconciled drift is planned', async () => {
    // No subset restriction: standalone `revert` plans EVERY revertable drift — the full
    // reconciled set here is D + Ra + Rb = 3 ops. This anchors that the one-op result above is
    // the selectedFindingKeys restriction at work, not an artifact of the fixture.
    const { outcome } = await run(undefined);
    expect(outcome.plannedResources).toBe(3);
    expect(outcome.plannedOps).toBe(3);
  });
});

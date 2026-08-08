// #1737: an added resource created AFTER `record` surfaced only as potential drift —
// `check --fail` exited 0 on an OOB-created child (live-hit 2026-08-09 enumrev2-hunt: an
// OOB register-task-with-maintenance-window and create-configuration-template both read
// "no confirmed drift · 2 potential drift"), so the added tier could NEVER fail CI. The
// fix records a per-parent child-scan-complete marker (`enumeratedParents`) at record
// time; applyBaseline then CONFIRMS an entry-less added child under a marked parent as
// "appeared since record" drift. Old baselines / unmarked parents keep the safe
// potential-only behavior, and the destructive delete gate (revert) is unchanged.
import { describe, expect, it } from 'vite-plus/test';
import {
  applyBaseline,
  buildEnumeratedParents,
  type BaselineFile,
} from '../src/baseline/baseline-file.js';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

const PARENT_TYPE = 'AWS::SSM::MaintenanceWindow';
const CHILD_TYPE = 'AWS::SSM::MaintenanceWindowTask';

function baseline(overrides: Partial<BaselineFile> = {}): BaselineFile {
  return {
    schemaVersion: 2,
    stackName: 's',
    region: 'r',
    accountId: '111122223333',
    capturedAt: '',
    templateHash: '',
    recorded: [],
    completeResources: ['Window'],
    enumeratedParents: [{ logicalId: 'Window', resourceType: PARENT_TYPE }],
    ...overrides,
  };
}

function addedChild(overrides: Partial<Finding> = {}): Finding {
  return {
    tier: 'added',
    logicalId: 'Window/mw-1|task-1',
    physicalId: 'mw-1|task-1',
    resourceType: CHILD_TYPE,
    parentLogicalId: 'Window',
    parentResourceType: PARENT_TYPE,
    path: '',
    actual: { WindowId: 'mw-1', WindowTaskId: 'task-1', TaskArn: 'AWS-RunShellScript' },
    note: 'created out of band — not in your CloudFormation template',
    ...overrides,
  };
}

describe('#1737 applyBaseline: appeared-since-record confirmation for added children', () => {
  it('confirms an entry-less added child under a marked parent (fails --fail)', () => {
    const out = applyBaseline([addedChild()], baseline(), {});
    expect(out).toHaveLength(1);
    expect(out[0]!.unrecorded).toBeUndefined();
    expect(out[0]!.note).toContain('appeared since record');
  });

  it('keeps potential-only behavior for an UNMARKED parent', () => {
    const out = applyBaseline([addedChild()], baseline({ enumeratedParents: [] }), {});
    expect(out[0]!.unrecorded).toBe(true);
    expect(out[0]!.note).not.toContain('appeared since record');
  });

  it('keeps potential-only behavior for a pre-#1737 baseline (no section)', () => {
    const out = applyBaseline([addedChild()], baseline({ enumeratedParents: undefined }), {});
    expect(out[0]!.unrecorded).toBe(true);
  });

  it('never confirms on a parent-TYPE mismatch (#793 twin)', () => {
    const out = applyBaseline(
      [addedChild({ parentResourceType: 'AWS::CodeDeploy::Application' })],
      baseline(),
      {}
    );
    expect(out[0]!.unrecorded).toBe(true);
  });

  it('never confirms a degraded (modelReadFailed) child', () => {
    const out = applyBaseline([addedChild({ modelReadFailed: true })], baseline(), {});
    expect(out[0]!.unrecorded).toBe(true);
    expect(out[0]!.note).not.toContain('appeared since record');
  });

  it('a recorded, unchanged added child stays suppressed', () => {
    const f = addedChild();
    const out = applyBaseline(
      [f],
      baseline({
        recorded: [{ logicalId: f.logicalId, resourceType: CHILD_TYPE, path: '', value: f.actual }],
      }),
      {}
    );
    expect(out).toHaveLength(0);
  });
});

describe('#1737 buildEnumeratedParents (record-time capture + #790-mirror demotion)', () => {
  const candidates = [
    { logicalId: 'Window', resourceType: PARENT_TYPE },
    { logicalId: 'EbApp', resourceType: 'AWS::ElasticBeanstalk::Application' },
  ];

  it('keeps a parent whose present added children were all endorsed', () => {
    const f = addedChild();
    const out = buildEnumeratedParents(
      candidates,
      [f],
      [{ logicalId: f.logicalId, resourceType: CHILD_TYPE, path: '', value: f.actual }]
    );
    expect(out.enumeratedParents).toEqual([
      { logicalId: 'EbApp', resourceType: 'AWS::ElasticBeanstalk::Application' },
      { logicalId: 'Window', resourceType: PARENT_TYPE },
    ]);
  });

  it('DEMOTES a parent with a present-but-unendorsed added child', () => {
    const out = buildEnumeratedParents(candidates, [addedChild()], []);
    expect(out.enumeratedParents).toEqual([
      { logicalId: 'EbApp', resourceType: 'AWS::ElasticBeanstalk::Application' },
    ]);
  });

  it('DEMOTES a parent whose added child was model-read-degraded (buildRecorded skips it)', () => {
    // a modelReadFailed child never enters `recorded`, so the demotion falls out of the
    // same entry-less test — asserted explicitly so the invariant is pinned.
    const out = buildEnumeratedParents(candidates, [addedChild({ modelReadFailed: true })], []);
    expect(out.enumeratedParents).toEqual([
      { logicalId: 'EbApp', resourceType: 'AWS::ElasticBeanstalk::Application' },
    ]);
  });

  it('spreads to nothing when no candidates', () => {
    expect(buildEnumeratedParents(undefined, [], [])).toEqual({});
    expect(buildEnumeratedParents([], [], [])).toEqual({});
  });
});

describe('#1737 revert: a confirmed appeared-since-record added is drift, so it deletes flaglessly', () => {
  // The --remove-unrecorded gates protect UNDECIDED inventory (unrecorded) and
  // previously-ENDORSED resources (#764 recorded-changed). A confirmed appeared child is
  // neither — it is drift against the recorded contract, so it flows into the plain
  // delete-kind plan exactly like the long-pinned bare-added contract in revert-plan.test.ts.
  it('plans the delete without --remove-unrecorded', () => {
    const confirmed = applyBaseline([addedChild()], baseline(), {})[0]!;
    const plan = buildRevertPlan([confirmed], undefined);
    expect(plan.notRevertable).toHaveLength(0);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.kind).toBe('delete');
    expect(plan.items[0]!.physicalId).toBe('mw-1|task-1');
  });

  it('an UNRECORDED added (unmarked parent) still refuses without --remove-unrecorded', () => {
    const potential = applyBaseline([addedChild()], baseline({ enumeratedParents: [] }), {})[0]!;
    const plan = buildRevertPlan([potential], undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable.some((n) => n.reason.includes('unrecorded'))).toBe(true);
  });
});

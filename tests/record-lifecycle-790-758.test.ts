// #790 + #758: re-record must not SILENTLY accept drift on recorded values.
//
// #790: a baseline entry with NO current undeclared finding (its recorded value reverted to
//       the AWS default, or was removed out of band) must NOT be silently pruned by the
//       full-replace write — it surfaces as an explicit "drop?" row (default UNSELECTED) and,
//       if not dropped, stays in the written baseline.
// #758: a recorded value CHANGED out of band gets a picker row that is default UNSELECTED and
//       shows `recorded → live`, and applyBaseline threads the recorded value onto the finding.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  applyBaseline,
  type BaselineFile,
  baselineOnlyEntries,
  baselinePath,
  buildRecorded,
  recordedValueForChanged,
} from '../src/baseline/baseline-file.js';
import {
  changedRecordLabel,
  dropRecordLabel,
  previewValue,
  recordDropMessage,
  recordStack,
} from '../src/commands/stack-actions.js';
import type { Desired } from '../src/desired/template-adapter.js';
import type { RecordedEntry } from '../src/baseline/baseline-file.js';
import type { Finding } from '../src/types.js';

const baseline = (recorded: RecordedEntry[], complete: string[] = []): BaselineFile => ({
  schemaVersion: 2,
  stackName: 's',
  region: 'r',
  accountId: '111122223333',
  capturedAt: '',
  templateHash: '',
  recorded,
  completeResources: complete,
});

// -------------------------------------------------------------------------------------------
// #790 — baselineOnlyEntries (the drop-candidate set)
// -------------------------------------------------------------------------------------------
describe('baselineOnlyEntries (#790 — recorded value reverted-to-default / removed since record)', () => {
  const entry: RecordedEntry = {
    logicalId: 'A',
    resourceType: 'AWS::IAM::Role',
    path: 'MaxSessionDuration',
    value: 7200,
  };
  const b = baseline([entry]);

  it('surfaces a recorded entry whose resource read CLEAN but has no current undeclared finding', () => {
    // MaxSessionDuration=7200 reset out of band to the 3600 default → classify tags it
    // `atDefault`, so buildRecorded emits NOTHING for it. The resource was read cleanly (an
    // atDefault finding present, no skip/gap), so its recorded value genuinely reverted.
    const findings: Finding[] = [
      {
        tier: 'atDefault',
        logicalId: 'A',
        resourceType: 'AWS::IAM::Role',
        path: 'MaxSessionDuration',
        actual: 3600,
      },
    ];
    const recorded = buildRecorded(findings); // = [] (atDefault is excluded)
    const out = baselineOnlyEntries(recorded, b, findings, { allLogicalIds: ['A'] });
    expect(out).toEqual([entry]);
  });

  it('surfaces a recorded property REMOVED out of band (no finding of any tier for the path)', () => {
    // The resource is still present (read cleanly, other findings) but the recorded path is gone.
    const findings: Finding[] = [];
    const out = baselineOnlyEntries([], b, findings, { allLogicalIds: ['A'] });
    expect(out).toEqual([entry]);
  });

  it('EXCLUDES an entry still recorded this run (unchanged/changed — has a live finding)', () => {
    const findings: Finding[] = [
      {
        tier: 'undeclared',
        logicalId: 'A',
        resourceType: 'AWS::IAM::Role',
        path: 'MaxSessionDuration',
        actual: 7200,
      },
    ];
    const recorded = buildRecorded(findings);
    expect(baselineOnlyEntries(recorded, b, findings, { allLogicalIds: ['A'] })).toEqual([]);
  });

  it('EXCLUDES a skipped/model-read-failed resource (unread ≠ gone — carried forward elsewhere)', () => {
    const skipped: Finding[] = [
      { tier: 'skipped', logicalId: 'A', resourceType: 'AWS::IAM::Role', path: '' },
    ];
    expect(baselineOnlyEntries([], b, skipped, { allLogicalIds: ['A'] })).toEqual([]);
  });

  it('EXCLUDES a deleted resource (#675 story, subsumed by the deleted finding)', () => {
    const deleted: Finding[] = [
      { tier: 'deleted', logicalId: 'A', resourceType: 'AWS::IAM::Role', path: '' },
    ];
    expect(baselineOnlyEntries([], b, deleted, { allLogicalIds: ['A'] })).toEqual([]);
  });

  it('EXCLUDES a resource no longer in the template (allLogicalIds gate, #675)', () => {
    expect(baselineOnlyEntries([], b, [], { allLogicalIds: [] })).toEqual([]);
  });

  it('EXCLUDES a path since PROMOTED into the template (declared — the clean-up nudge)', () => {
    const declaredByLogical = new Map([['A', { MaxSessionDuration: 3600 }]]);
    expect(baselineOnlyEntries([], b, [], { allLogicalIds: ['A'], declaredByLogical })).toEqual([]);
  });

  it('EXCLUDES an `added`-resource snapshot (empty path — reconciled resource-wise)', () => {
    const addedEntry = baseline([
      { logicalId: 'Child', resourceType: 'AWS::ApiGateway::Stage', path: '', value: { x: 1 } },
    ]);
    expect(baselineOnlyEntries([], addedEntry, [], { allLogicalIds: ['Child'] })).toEqual([]);
  });

  it('returns [] when there is no baseline', () => {
    expect(baselineOnlyEntries([], undefined, [], {})).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// #758 — recordedValueForChanged + labels + applyBaseline threading
// -------------------------------------------------------------------------------------------
describe('recordedValueForChanged (#758 — old recorded value for a changed row)', () => {
  const b = baseline([{ logicalId: 'A', resourceType: 'AWS::IAM::Role', path: 'P', value: 'OLD' }]);
  it('returns the recorded value for a matching baseline entry', () => {
    const e: RecordedEntry = {
      logicalId: 'A',
      resourceType: 'AWS::IAM::Role',
      path: 'P',
      value: 'NEW',
    };
    expect(recordedValueForChanged(e, b)).toEqual({ hasRecorded: true, recordedValue: 'OLD' });
  });
  it('hasRecorded=false for a genuinely NEW path', () => {
    const e: RecordedEntry = {
      logicalId: 'A',
      resourceType: 'AWS::IAM::Role',
      path: 'Q',
      value: 1,
    };
    expect(recordedValueForChanged(e, b)).toEqual({ hasRecorded: false, recordedValue: undefined });
  });
  it('hasRecorded=false with no baseline', () => {
    const e: RecordedEntry = {
      logicalId: 'A',
      resourceType: 'AWS::IAM::Role',
      path: 'P',
      value: 1,
    };
    expect(recordedValueForChanged(e, undefined)).toEqual({
      hasRecorded: false,
      recordedValue: undefined,
    });
  });
});

describe('record labels (#758 / #790)', () => {
  it('previewValue truncates a long value to one line', () => {
    // #1302: previewValue now takes (resourceType, path, value, max) — a non-secret path
    // renders unchanged (redactValue is a no-op off the curated table).
    expect(previewValue('AWS::S3::Bucket', 'P', 'short')).toBe('short');
    expect(previewValue('AWS::S3::Bucket', 'P', 'x'.repeat(60), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(previewValue('AWS::S3::Bucket', 'P', { a: 1 })).toBe('{"a":1}');
  });
  it('changedRecordLabel shows recorded → live for a CHANGED entry', () => {
    const label = changedRecordLabel(
      { logicalId: 'A', path: 'P', value: 'NEW', resourceType: 'AWS::S3::Bucket' },
      { hasRecorded: true, recordedValue: 'OLD' }
    );
    expect(label).toBe('A.P (changed since record: OLD → NEW)');
  });
  it('changedRecordLabel is a plain row for a NEW path (no recorded value)', () => {
    const label = changedRecordLabel(
      { logicalId: 'A', path: 'P', value: 'NEW', resourceType: 'AWS::S3::Bucket' },
      { hasRecorded: false, recordedValue: undefined }
    );
    expect(label).toBe('A.P');
  });
  it('dropRecordLabel names the reverted/removed entry', () => {
    expect(dropRecordLabel({ logicalId: 'A', path: 'MaxSessionDuration' })).toContain(
      'A.MaxSessionDuration'
    );
    expect(dropRecordLabel({ logicalId: 'A', path: 'MaxSessionDuration' })).toContain(
      'drop from baseline?'
    );
  });
  it('recordDropMessage states unselected stay watched', () => {
    expect(recordDropMessage('s', 'r')).toContain('unselected stay watched');
  });
});

describe('applyBaseline threads the recorded value onto a CHANGED undeclared finding (#758)', () => {
  it('a recorded value reset to the AWS default carries the recorded value on `desired`', () => {
    const b = baseline([
      { logicalId: 'A', resourceType: 'AWS::IAM::Role', path: 'MaxSessionDuration', value: 7200 },
    ]);
    const out = applyBaseline(
      [
        {
          tier: 'atDefault',
          logicalId: 'A',
          resourceType: 'AWS::IAM::Role',
          path: 'MaxSessionDuration',
          actual: 3600,
        },
      ],
      b
    );
    expect(out).toHaveLength(1);
    // #758: the recorded (7200) → live (3600) diff is now available on the finding, not just live.
    expect(out[0]).toMatchObject({ tier: 'undeclared', desired: 7200, actual: 3600 });
  });
});

// -------------------------------------------------------------------------------------------
// #790 + #758 — recordStack integration (writes a real baseline file to disk)
// -------------------------------------------------------------------------------------------
describe('recordStack lifecycle (#790 preserve reverted/removed watches; #758 --yes summary)', () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths.splice(0)) if (existsSync(p)) rmSync(p);
  });

  function makeDesired(overrides: Partial<Desired> = {}): Desired {
    return {
      stackName: 'Lifecycle790',
      region: 'lc-790-region',
      accountId: '999988887777',
      resources: [{ logicalId: 'A', resourceType: 'AWS::IAM::Role', declared: {} }],
      rawTemplate: '{}',
      ctx: {},
      ...overrides,
    } as unknown as Desired;
  }

  function seedBaseline(desired: Desired, recorded: RecordedEntry[]): string {
    const p = baselinePath(desired.stackName, desired.accountId, desired.region);
    mkdirSync(dirname(p), { recursive: true });
    // Stamp the file's identity (stack/region/account) to match its path so loadBaseline's
    // identity guard accepts it.
    const b: BaselineFile = {
      ...baseline(recorded, ['A']),
      stackName: desired.stackName,
      region: desired.region,
      accountId: desired.accountId,
    };
    writeFileSync(p, JSON.stringify(b), 'utf8');
    paths.push(p);
    return p;
  }

  it('#790: a recorded value reverted-to-default is PRESERVED under --yes (not silently dropped)', async () => {
    const desired = makeDesired();
    const p = seedBaseline(desired, [
      { logicalId: 'A', resourceType: 'AWS::IAM::Role', path: 'MaxSessionDuration', value: 7200 },
    ]);
    const errs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
      errs.push(String(m));
    });
    try {
      // classify now reports MaxSessionDuration at the 3600 default (atDefault) → NO undeclared
      // finding. A naive full-replace would drop the recorded 7200 entry with zero output.
      const findings: Finding[] = [
        {
          tier: 'atDefault',
          logicalId: 'A',
          resourceType: 'AWS::IAM::Role',
          path: 'MaxSessionDuration',
          actual: 3600,
        },
      ];
      const result = await recordStack({
        stackName: desired.stackName,
        region: desired.region,
        desired,
        findings,
        yes: true,
        interactive: false,
      });
      expect(result.wrote).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const written = JSON.parse(readFileSync(p, 'utf8')) as BaselineFile;
    // the recorded watch is PRESERVED, not pruned
    expect(written.recorded).toEqual([
      { logicalId: 'A', resourceType: 'AWS::IAM::Role', path: 'MaxSessionDuration', value: 7200 },
    ]);
    // and --yes is NOT silent about it
    expect(errs.join('\n')).toContain('PRESERVED 1 recorded watch');
  });

  it('#790: a recorded property REMOVED out of band is PRESERVED under --yes', async () => {
    const desired = makeDesired();
    const p = seedBaseline(desired, [
      { logicalId: 'A', resourceType: 'AWS::IAM::Role', path: 'Description', value: 'my-role' },
    ]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await recordStack({
        stackName: desired.stackName,
        region: desired.region,
        desired,
        findings: [], // resource read clean, path gone
        yes: true,
        interactive: false,
      });
      expect(result.wrote).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const written = JSON.parse(readFileSync(p, 'utf8')) as BaselineFile;
    expect(written.recorded).toEqual([
      { logicalId: 'A', resourceType: 'AWS::IAM::Role', path: 'Description', value: 'my-role' },
    ]);
  });

  it('#758: --yes echoes a summary when a recorded value CHANGED out of band', async () => {
    const desired = makeDesired();
    seedBaseline(desired, [
      { logicalId: 'A', resourceType: 'AWS::IAM::Role', path: 'MaxSessionDuration', value: 7200 },
    ]);
    const errs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
      errs.push(String(m));
    });
    try {
      // the recorded value 7200 was CHANGED to 43200 out of band (still an undeclared finding)
      const findings: Finding[] = [
        {
          tier: 'undeclared',
          logicalId: 'A',
          resourceType: 'AWS::IAM::Role',
          path: 'MaxSessionDuration',
          actual: 43200,
        },
      ];
      await recordStack({
        stackName: desired.stackName,
        region: desired.region,
        desired,
        findings,
        yes: true,
        interactive: false,
      });
    } finally {
      spy.mockRestore();
    }
    expect(errs.join('\n')).toContain('--yes accepted 1 recorded value(s) CHANGED out of band');
    expect(errs.join('\n')).toContain('A.MaxSessionDuration');
  });

  it('regression: a normal NEW-undeclared record under --yes still records the value', async () => {
    const desired = makeDesired();
    const p = baselinePath(desired.stackName, desired.accountId, desired.region);
    if (existsSync(p)) rmSync(p);
    paths.push(p);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const findings: Finding[] = [
        {
          tier: 'undeclared',
          logicalId: 'A',
          resourceType: 'AWS::IAM::Role',
          path: 'MaxSessionDuration',
          actual: 7200,
        },
      ];
      const result = await recordStack({
        stackName: desired.stackName,
        region: desired.region,
        desired,
        findings,
        yes: true,
        interactive: false,
      });
      expect(result.wrote).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const written = JSON.parse(readFileSync(p, 'utf8')) as BaselineFile;
    expect(written.recorded).toEqual([
      { logicalId: 'A', resourceType: 'AWS::IAM::Role', path: 'MaxSessionDuration', value: 7200 },
    ]);
  });
});

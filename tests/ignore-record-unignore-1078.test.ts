// #1078: the ignore -> record -> un-ignore lifecycle trap.
//
// The documented way to RESUME watching an ignored path is to delete its rule from
// .cdkrd/ignore.yaml. But if ANY `record` ran while the rule was live, un-ignoring
// used to surface the (untouched) value as CONFIRMED "appeared since record" drift —
// because `record` DROPPED the ignore-suppressed value from the snapshot yet still
// stamped its resource snapshot-complete, treating an `ignored` value as "known-absent".
//
// This is fixed by TWO cooperating changes (both exercised here):
//   (A) carryForwardIgnored — a prior recorded entry for a currently-ignored path is
//       carried into the new baseline, so an endorsed value survives an ignore-era record.
//   (B) computeCompleteResources — an ignored-and-UNRECORDED path blocks (and demotes)
//       its resource's completeness, so un-ignoring a never-recorded value returns it to
//       `unrecorded` (`[Potential Drift]`), not confirmed "appeared since record".
//
// Both variants (prior-entry + no-prior-entry) are driven end to end through the real
// `recordStack` (writes a baseline to a temp path) and then read back with applyBaseline
// simulating the ignore rule DELETED (un-ignore) — the finding re-tags to `undeclared`.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  applyBaseline,
  type BaselineFile,
  baselinePath,
  carryForwardIgnored,
  computeCompleteResources,
  type RecordedEntry,
} from '../src/baseline/baseline-file.js';
import { recordStack } from '../src/commands/stack-actions.js';
import type { Desired } from '../src/desired/template-adapter.js';
import type { Finding } from '../src/types.js';

const RES = { logicalId: 'Res', resourceType: 'AWS::S3::Bucket', path: 'OwnershipControls' };

// An `undeclared` finding: the live value cdkrd sees for the churning path.
const undeclaredFinding = (actual: unknown): Finding => ({ tier: 'undeclared', ...RES, actual });
// The SAME finding after `applyIgnores` re-tags it (record.ts / interactive-resolve.ts
// run applyIgnores BEFORE recordStack): tier `ignored`, `unrecorded` cleared, a note.
const ignoredFinding = (actual: unknown): Finding => ({
  tier: 'ignored',
  ...RES,
  actual,
  note: 'ignored by config rule "Res.OwnershipControls"',
});

// -------------------------------------------------------------------------------------------
// (A) carryForwardIgnored — unit
// -------------------------------------------------------------------------------------------
describe('carryForwardIgnored (#1078 — preserve an endorsed entry across an ignore-era record)', () => {
  const priorEntry: RecordedEntry = { ...RES, value: 'V' };
  const b = (recorded: RecordedEntry[]): BaselineFile => ({
    schemaVersion: 2,
    stackName: 's',
    region: 'r',
    accountId: '111122223333',
    capturedAt: '',
    templateHash: '',
    recorded,
    completeResources: ['Res'],
  });

  it('carries a prior recorded entry forward when its path is ignored this run', () => {
    // buildRecorded([ignored]) === [] (ignored tier is excluded), so without the carry the
    // full-replace write would prune the endorsed entry.
    const out = carryForwardIgnored([], b([priorEntry]), [ignoredFinding('V')]);
    expect(out).toEqual([priorEntry]);
  });

  it('does NOT duplicate an entry already present in the recorded set', () => {
    const out = carryForwardIgnored([priorEntry], b([priorEntry]), [ignoredFinding('V')]);
    expect(out).toEqual([priorEntry]);
  });

  it('carries NOTHING when the ignored path has no prior entry (nothing to preserve)', () => {
    // The no-prior-entry variant: completeness demotion (test below) handles it instead.
    expect(carryForwardIgnored([], b([]), [ignoredFinding('V')])).toEqual([]);
  });

  it('is a no-op when nothing is ignored this run', () => {
    const other: Finding = { tier: 'undeclared', ...RES, actual: 'V' };
    expect(carryForwardIgnored([], b([priorEntry]), [other])).toEqual([]);
  });

  it('is a no-op with no existing baseline', () => {
    expect(carryForwardIgnored([], undefined, [ignoredFinding('V')])).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// (B) computeCompleteResources — unit
// -------------------------------------------------------------------------------------------
describe('computeCompleteResources (#1078 — an ignored-and-unrecorded path blocks/demotes completeness)', () => {
  it('does NOT mark a resource complete when an ignored value is absent from the recorded set', () => {
    const complete = computeCompleteResources(['Res'], [ignoredFinding('V')], []);
    expect(complete).toEqual([]);
  });

  it('DEMOTES a previously-complete resource for an ignored-and-unrecorded path (overrides monotonicity)', () => {
    // Res was complete before; the ignore rule now suppresses its only value from the
    // snapshot. It must NOT stay complete, else un-ignoring lands false "appeared".
    const complete = computeCompleteResources(['Res'], [ignoredFinding('V')], [], ['Res']);
    expect(complete).toEqual([]);
  });

  it('KEEPS a resource complete when the ignored path IS in the recorded set (carried forward)', () => {
    // With (A), an endorsed value is carried into `recorded`, so its path is present and the
    // resource legitimately stays complete — ignored values do not block completeness for
    // values that ARE recorded (the intended pre-#1078 behavior, preserved).
    const recorded: RecordedEntry[] = [{ ...RES, value: 'V' }];
    const complete = computeCompleteResources(['Res'], [ignoredFinding('V')], recorded, ['Res']);
    expect(complete).toEqual(['Res']);
  });

  it('still marks a clean resource complete when nothing is ignored', () => {
    expect(computeCompleteResources(['Res'], [], [])).toEqual(['Res']);
  });
});

// -------------------------------------------------------------------------------------------
// Full lifecycle through recordStack (writes a real baseline file), both variants
// -------------------------------------------------------------------------------------------
describe('ignore -> record -> un-ignore lifecycle (#1078 — untouched value must NOT become confirmed drift)', () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths.splice(0)) if (existsSync(p)) rmSync(p);
  });

  function makeDesired(): Desired {
    return {
      stackName: 'Unignore1078',
      region: 'ui-1078-region',
      accountId: '999988887777',
      resources: [{ logicalId: 'Res', resourceType: 'AWS::S3::Bucket', declared: {} }],
      rawTemplate: '{}',
      ctx: {},
    } as unknown as Desired;
  }

  function seedBaseline(desired: Desired, recorded: RecordedEntry[], complete: string[]): string {
    const p = baselinePath(desired.stackName, desired.accountId, desired.region);
    mkdirSync(dirname(p), { recursive: true });
    const b: BaselineFile = {
      schemaVersion: 2,
      stackName: desired.stackName,
      region: desired.region,
      accountId: desired.accountId,
      capturedAt: '',
      templateHash: '',
      recorded,
      completeResources: complete,
    };
    writeFileSync(p, JSON.stringify(b), 'utf8');
    paths.push(p);
    return p;
  }

  async function recordWithIgnored(desired: Desired): Promise<BaselineFile> {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // record.ts / interactive-resolve.ts applyIgnores the findings BEFORE recordStack, so
      // the churning path arrives tier `ignored`.
      const res = await recordStack({
        stackName: desired.stackName,
        region: desired.region,
        desired,
        findings: [ignoredFinding('V')],
        yes: true,
        interactive: false,
      });
      expect(res.wrote).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const p = baselinePath(desired.stackName, desired.accountId, desired.region);
    return JSON.parse(readFileSync(p, 'utf8')) as BaselineFile;
  }

  it('variant 1 (prior entry): the endorsed entry SURVIVES the ignore-era record and un-ignore suppresses it (unchanged)', async () => {
    const desired = makeDesired();
    // Step 1-2: recorded { Res.OwnershipControls: V }, resource complete; then ignored.
    seedBaseline(desired, [{ ...RES, value: 'V' }], ['Res']);

    // Step 3: a `record` runs while the rule is live.
    const written = await recordWithIgnored(desired);

    // (A) the endorsed entry is NOT pruned — it is carried forward.
    expect(written.recorded).toEqual([{ ...RES, value: 'V' }]);

    // Step 4-5: the user deletes the ignore rule; the live value is UNCHANGED. The finding is
    // now plain `undeclared` again (no ignore re-tag). applyBaseline must SUPPRESS it (matches
    // the carried entry), never surface it as confirmed "appeared since record" drift.
    const out = applyBaseline([undeclaredFinding('V')], written, { allLogicalIds: ['Res'] });
    expect(out).toHaveLength(0);
  });

  it('variant 2 (no prior entry): un-ignore returns the untouched value to `unrecorded`, not confirmed "appeared since record"', async () => {
    const desired = makeDesired();
    // Step 2 (no prior record): the value was ignored before ever being recorded. Seed a
    // baseline that exists but has NO entry for Res and does NOT list Res complete.
    seedBaseline(desired, [], []);

    // Step 3: a `record` runs while the rule is live.
    const written = await recordWithIgnored(desired);

    // (B) the resource is NOT stamped complete over the ignored-and-unrecorded path.
    expect(written.completeResources ?? []).not.toContain('Res');
    expect(written.recorded).toEqual([]);

    // Step 4-5: delete the rule; the live value is unchanged. With Res incomplete, an
    // entry-less undeclared value is `unrecorded` (`[Potential Drift]`), NOT confirmed drift.
    const out = applyBaseline([undeclaredFinding('V')], written, { allLogicalIds: ['Res'] });
    expect(out).toHaveLength(1);
    expect(out[0]?.tier).toBe('undeclared');
    expect(out[0]?.unrecorded).toBe(true);
    expect(out[0]?.note ?? '').not.toContain('appeared since record');
  });

  it('regression: after un-ignore, a GENUINE later change to a carried (variant-1) value still surfaces as drift', async () => {
    const desired = makeDesired();
    seedBaseline(desired, [{ ...RES, value: 'V' }], ['Res']);
    const written = await recordWithIgnored(desired);
    // rule deleted, and the value CHANGED out of band from V to V2 → real drift.
    const out = applyBaseline([undeclaredFinding('V2')], written, { allLogicalIds: ['Res'] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tier: 'undeclared', desired: 'V', actual: 'V2' });
  });
});

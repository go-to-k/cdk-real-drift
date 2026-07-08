// #792: `recordedPhysicalIds` must cover a `complete` resource EVEN when it has ZERO
// undeclared entries (nothing in `recorded`). Before the fix, `writeBaseline` /
// `writeBaselineFile` pruned physical ids to entry-bearing logicalIds only, so a resource
// recorded as complete but with no recorded entry lost its physical id — and #674's
// replacement void could not fire for it. Then an out-of-band REPLACEMENT (new physical id,
// fresh AWS defaults on a complete resource) surfaced as false "appeared since record" drift.
//
// The fix persists the physical id for every recorded-OR-complete resource with a known
// physical id (a resource with no known physical id stays absent — today's behavior).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  applyBaseline,
  type BaselineFile,
  loadBaseline,
  writeBaseline,
} from '../src/baseline/baseline-file.js';
import type { Finding } from '../src/types.js';

// A resource read CLEAN this run: no undeclared/atDefault finding for it at all, so it is
// snapshot-`complete` (zero entries) yet carries a physical id in `physicalIdByLogical`.
// `atDefault` finding — an initial/default AWS assigned undeclared (folds, not recorded).
const atDef = (logicalId: string, path: string, value: unknown): Finding => ({
  tier: 'atDefault',
  logicalId,
  resourceType: 'AWS::SQS::Queue',
  path,
  actual: value,
});

async function inTmp<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'cdkrd-792-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
}

describe('#792 — zero-entry complete resource keeps its physical id so #674 void fires', () => {
  // Record: resource "Q" is complete (in allLogicalIds) with ZERO undeclared entries, and
  // its live physical id is known. Nothing is `recorded`, so the pre-fix prune dropped Q's id.
  const recordZeroEntryComplete = async (): Promise<BaselineFile> =>
    inTmp(async () => {
      await writeBaseline(
        's',
        'r',
        '111122223333',
        [], // no undeclared/atDefault findings this run -> Q recorded clean = complete, zero entries
        '{"Resources":{}}',
        undefined, // default recorded = buildRecorded([]) = []
        {
          allLogicalIds: ['Q'], // Q is a template resource, read clean -> snapshot-complete
          physicalIdByLogical: new Map([['Q', 'phys-old']]),
        }
      );
      const b = await loadBaseline('s', '111122223333', 'r');
      if (!b) throw new Error('baseline should have been written');
      return b;
    });

  it('persists the physical id for a zero-entry complete resource', async () => {
    const b = await recordZeroEntryComplete();
    // Pre-fix: recordedPhysicalIds pruned to entry-bearing ids -> {} (field absent). Fixed:
    // Q is complete with a known id -> persisted.
    expect(b.recordedPhysicalIds?.Q).toBe('phys-old');
    expect(b.completeResources).toContain('Q');
    expect(b.recorded).toEqual([]);
  });

  it('voids the fresh AWS default of a REPLACED zero-entry complete resource (no false "appeared since record")', async () => {
    const b = await recordZeroEntryComplete();
    // Deploy REPLACES Q (new physical id). The new queue reads a fresh undeclared default
    // that is a genuine non-default value (so it does NOT fold to atDefault) -> arrives as
    // `undeclared`. Because Q is `complete`, without the void it would be flagged
    // "appeared since record" drift. With the physical id persisted (#792), #674 detects the
    // replacement and the value folds to unrecorded (never surfaced), plus a folded nudge.
    const warnings: string[] = [];
    const out = applyBaseline(
      [
        {
          tier: 'undeclared',
          logicalId: 'Q',
          resourceType: 'AWS::SQS::Queue',
          path: 'VisibilityTimeout',
          actual: 999,
        },
      ],
      b,
      {
        physicalIdByLogical: new Map([['Q', 'phys-new']]), // DIFFERS -> replaced
        warn: (m) => warnings.push(m),
      }
    );
    // Not surfaced as drift, and not tagged "appeared since record".
    const q = out.find((f) => f.logicalId === 'Q' && f.path === 'VisibilityTimeout');
    expect(q?.note).not.toBe('appeared since record');
    expect(q?.unrecorded).toBe(true); // folded to inventory, never drift
    expect(warnings.some((w) => w.includes('since REPLACED by a deploy'))).toBe(false);
    // (no recorded entry existed for Q, so there is nothing to list in the replaced-stale note;
    // the point is the undeclared value did NOT surface as drift.)
  });

  it('a MATCHING physical id keeps normal behavior: a new undeclared value on a complete resource DOES surface', async () => {
    const b = await recordZeroEntryComplete();
    // Same physical id -> NOT replaced. A genuine non-default undeclared value on a
    // snapshot-complete resource appeared since record -> real drift (must still be caught).
    const out = applyBaseline(
      [
        {
          tier: 'undeclared',
          logicalId: 'Q',
          resourceType: 'AWS::SQS::Queue',
          path: 'VisibilityTimeout',
          actual: 999,
        },
      ],
      b,
      { physicalIdByLogical: new Map([['Q', 'phys-old']]) } // same id -> not replaced
    );
    const q = out.find((f) => f.logicalId === 'Q' && f.path === 'VisibilityTimeout');
    expect(q?.note).toBe('appeared since record');
    expect(q?.unrecorded).toBeUndefined();
  });

  it('an atDefault value on a same-id complete resource still folds (control: replacement not needed to fold a real default)', async () => {
    const b = await recordZeroEntryComplete();
    const out = applyBaseline([atDef('Q', 'VisibilityTimeout', 30)], b, {
      physicalIdByLogical: new Map([['Q', 'phys-old']]),
    });
    // atDefault folds through untouched (not drift, not unrecorded) whether or not replaced.
    expect(out.some((f) => f.tier === 'undeclared')).toBe(false);
  });
});

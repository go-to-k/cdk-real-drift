// #1637: an atDefault-folded undeclared value DELETED out of band (the whole property
// VANISHES from the Cloud Control read — live-proven: `aws s3api delete-public-access-block`
// on a fresh bucket left `check --fail` at exit 0) was structurally invisible: every
// detection mechanism keys on a live VALUE being present. The fix persists the curated
// OBSERVED_DEFAULT_TRACKED_PATHS observations into the baseline (`observedDefaults`) at
// record time, and applyBaseline synthesizes an undeclared "observed default deleted since
// record" finding when an observed path yields NO finding on a positively-READ resource.
// The restore value is the KNOWN_DEFAULTS pin, riding revert's existing
// actual-undefined + desired branch.
import { describe, expect, it } from 'vite-plus/test';
import {
  applyBaseline,
  buildObservedDefaults,
  type BaselineFile,
} from '../src/baseline/baseline-file.js';
import { KNOWN_DEFAULTS } from '../src/normalize/noise.js';
import type { Finding } from '../src/types.js';

const S3 = 'AWS::S3::Bucket';
const PAB = 'PublicAccessBlockConfiguration';
const PAB_DEFAULT = KNOWN_DEFAULTS[S3]![PAB];

function baseline(overrides: Partial<BaselineFile> = {}): BaselineFile {
  return {
    schemaVersion: 2,
    stackName: 's',
    region: 'r',
    accountId: '111122223333',
    capturedAt: '',
    templateHash: '',
    recorded: [],
    completeResources: ['Bucket'],
    observedDefaults: [{ logicalId: 'Bucket', resourceType: S3, path: PAB }],
    ...overrides,
  };
}

const finding = (tier: Finding['tier'], path: string, actual?: unknown): Finding => ({
  tier,
  logicalId: 'Bucket',
  resourceType: S3,
  path,
  actual,
});

describe('#1637 buildObservedDefaults (record-time capture)', () => {
  it('captures an atDefault finding on a tracked path', () => {
    const out = buildObservedDefaults([finding('atDefault', PAB, PAB_DEFAULT)], undefined);
    expect(out.observedDefaults).toEqual([{ logicalId: 'Bucket', resourceType: S3, path: PAB }]);
  });

  it('ignores untracked paths and non-atDefault tiers', () => {
    const out = buildObservedDefaults(
      [
        finding('atDefault', 'VersioningConfiguration', { Status: 'Suspended' }),
        finding('undeclared', PAB, { BlockPublicAcls: false }),
      ],
      undefined
    );
    expect(out).toEqual({});
  });

  it('carries a prior observation forward for a resource SKIPPED this run', () => {
    const prev = baseline();
    const out = buildObservedDefaults([finding('skipped', '')], prev);
    expect(out.observedDefaults).toEqual([{ logicalId: 'Bucket', resourceType: S3, path: PAB }]);
  });

  it('drops a prior observation for a resource READ this run with the value ABSENT (re-record accepts)', () => {
    const prev = baseline();
    const out = buildObservedDefaults([finding('atDefault', 'OwnershipControls', {})], prev);
    expect(out).toEqual({});
  });
});

describe('#1637 applyBaseline vanish pass', () => {
  it('surfaces an observed default whose value vanished from the read (the live-proven FN)', () => {
    // The resource was positively read (an unrelated atDefault finding) but the tracked
    // path yields NO finding at all — the delete-public-access-block shape.
    const out = applyBaseline([finding('atDefault', 'OwnershipControls', {})], baseline(), {
      physicalIdByLogical: new Map([['Bucket', 'my-bucket']]),
    });
    const vanished = out.find((f) => f.path === PAB);
    expect(vanished).toBeDefined();
    expect(vanished!.tier).toBe('undeclared');
    expect(vanished!.actual).toBeUndefined();
    expect(vanished!.desired).toEqual(PAB_DEFAULT); // the restore value for revert
    expect(vanished!.physicalId).toBe('my-bucket');
    expect(vanished!.note).toContain('deleted since record');
  });

  it('stays silent while the value is still present (any undeclared-side tier)', () => {
    for (const tier of ['atDefault', 'undeclared'] as const) {
      const out = applyBaseline([finding(tier, PAB, { BlockPublicAcls: true })], baseline(), {});
      expect(out.filter((f) => f.path === PAB && f.actual === undefined)).toEqual([]);
    }
  });

  it('stays silent on an unread (skipped) resource', () => {
    const out = applyBaseline([finding('skipped', '')], baseline(), {});
    expect(out.filter((f) => f.path === PAB)).toEqual([]);
  });

  it('stays silent on a deleted resource (the deleted finding subsumes it)', () => {
    const out = applyBaseline([finding('deleted', '')], baseline(), {});
    expect(out.filter((f) => f.path === PAB)).toEqual([]);
  });

  it('stays silent with no positive read proof at all (empty findings)', () => {
    const out = applyBaseline([], baseline(), {});
    expect(out.filter((f) => f.path === PAB)).toEqual([]);
  });

  it('stays silent when part of the live model was unreadable (readGap)', () => {
    const out = applyBaseline(
      [finding('atDefault', 'OwnershipControls', {}), finding('readGap', 'SomeProp')],
      baseline(),
      {}
    );
    expect(out.filter((f) => f.path === PAB && f.actual === undefined)).toEqual([]);
  });

  it('stays silent when the user has since DECLARED the path (declared tier owns it)', () => {
    const out = applyBaseline([finding('atDefault', 'OwnershipControls', {})], baseline(), {
      declaredByLogical: new Map([
        ['Bucket', { [PAB]: { BlockPublicAcls: true } } as Record<string, unknown>],
      ]),
    });
    expect(out.filter((f) => f.path === PAB)).toEqual([]);
  });

  it('stays silent on a REPLACED resource (fresh physical id, fresh defaults)', () => {
    const out = applyBaseline(
      [finding('atDefault', 'OwnershipControls', {})],
      {
        ...baseline(),
        recordedPhysicalIds: { Bucket: 'old-bucket' },
      },
      {
        physicalIdByLogical: new Map([['Bucket', 'new-bucket']]),
      }
    );
    expect(out.filter((f) => f.path === PAB)).toEqual([]);
  });

  it('stays silent when the logicalId now hosts a DIFFERENT type', () => {
    const out = applyBaseline(
      [
        {
          tier: 'atDefault',
          logicalId: 'Bucket',
          resourceType: 'AWS::SNS::Topic',
          path: 'FifoTopic',
          actual: false,
        },
      ],
      baseline(),
      {}
    );
    expect(out.filter((f) => f.path === PAB)).toEqual([]);
  });

  it('defers to a recorded entry for the same path (removed-since-record owns it)', () => {
    const out = applyBaseline(
      [finding('atDefault', 'OwnershipControls', {})],
      baseline({
        recorded: [
          { logicalId: 'Bucket', resourceType: S3, path: PAB, value: { BlockPublicAcls: false } },
        ],
      }),
      {}
    );
    // exactly ONE synthetic for the path — the recorded-entry removal, not a duplicate vanish
    const synthetic = out.filter((f) => f.path === PAB && f.actual === undefined);
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]!.note).toBe('baseline value removed since record');
  });

  it('stays silent when the resource was removed from the template', () => {
    const out = applyBaseline([finding('atDefault', 'OwnershipControls', {})], baseline(), {
      allLogicalIds: ['SomethingElse'],
    });
    expect(out.filter((f) => f.path === PAB)).toEqual([]);
  });
});

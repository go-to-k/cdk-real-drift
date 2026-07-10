import { describe, expect, it } from 'vite-plus/test';
import {
  applyBaseline,
  type BaselineFile,
  buildRecorded,
  carryForwardUnreadable,
} from '../src/baseline/baseline-file.js';
import type { Finding } from '../src/types.js';

// #791: two lifecycle gaps for RECORDED out-of-band `added` resources (baseline entries
// with `path === ''`), which together break "record KEEPS watching" for the added tier.
//   Gap 1 — a recorded added resource DELETED out of band (parent WAS read this run) must
//           surface as drift (a detect-only "recorded added resource removed since record"
//           finding), not read as CLEAN.
//   Gap 2 — carryForwardUnreadable must NOT drop a recorded added child when the PARENT's
//           child-enumeration was throttled (a `skipped` finding is keyed on the parent, the
//           recorded entry on the synthesized child id) — else a transient throttle silently
//           shrinks the committed baseline.
//   Interaction — a child under a THROTTLED parent is CARRIED FORWARD (Gap 2), NOT reported
//           deleted (Gap 1): Gap 1 fires only on POSITIVE proof the parent was read.

const PARENT = 'Api';
const CHILD = `${PARENT}/m1`; // gather.ts synthesizes `${parent.logicalId}/${identifier}`
const METHOD_TYPE = 'AWS::ApiGateway::Method';

function baseline(recorded: BaselineFile['recorded']): BaselineFile {
  return {
    schemaVersion: 2,
    stackName: 's',
    region: 'r',
    accountId: '111122223333',
    capturedAt: '',
    templateHash: '',
    recorded,
    completeResources: [],
  };
}

// A recorded `added` entry: whole-resource value, empty path, synthesized child id.
const recordedAdded = (value: unknown): BaselineFile['recorded'][number] => ({
  logicalId: CHILD,
  resourceType: METHOD_TYPE,
  path: '',
  value,
});

// An `added` finding as gather.ts would emit for a live out-of-band child.
const added = (value: unknown, extra: Partial<Finding> = {}): Finding => ({
  tier: 'added',
  logicalId: CHILD,
  resourceType: METHOD_TYPE,
  path: '',
  physicalId: 'RestApiId|ResourceId|GET',
  actual: value,
  note: 'created out of band — not in your CloudFormation template',
  ...extra,
});

// A finding proving the PARENT resource was READ this run (any non-skipped/deleted tier).
const parentReadSignal = (): Finding => ({
  tier: 'undeclared',
  logicalId: PARENT,
  resourceType: 'AWS::ApiGateway::RestApi',
  path: 'ApiKeySourceType',
  actual: 'HEADER',
});

// The parent's `skipped` finding (enumeration throttled) — keyed on the PARENT logicalId.
const parentSkipped = (): Finding => ({
  tier: 'skipped',
  logicalId: PARENT,
  resourceType: 'AWS::ApiGateway::RestApi',
  path: '',
  note: 'added-resource scan: ThrottlingException',
});

describe('#791 added-resource lifecycle (record KEEPS watching)', () => {
  describe('Gap 1 — a recorded added resource DELETED out of band surfaces as drift', () => {
    it('parent WAS read but the child is no longer enumerated -> detect-only "removed since record" finding', () => {
      const b = baseline([recordedAdded({ AuthorizationType: 'NONE' })]);
      // The parent was read (positive signal), yet NO `added` finding for the child: it was
      // deleted out of band. Deleting an ENDORSED resource IS a change -> must surface.
      const out = applyBaseline([parentReadSignal()], b, {
        constructPathByLogical: new Map([[CHILD, 'MyStack/Api ▸ GET /']]),
      });
      const removed = out.find(
        (f) => f.logicalId === CHILD && f.note === 'recorded added resource removed since record'
      );
      expect(removed).toBeDefined();
      // Rides the `deleted` tier so it COUNTS as drift (--fail catches it) ...
      expect(removed!.tier).toBe('deleted');
      // ... yet carries NO revert target: no desired value + no physical id, so revert can
      // never build a (malformed) restore op — an added resource cannot be "restored".
      expect(removed!.desired).toBeUndefined();
      expect(removed!.actual).toBeUndefined();
      expect(removed!.physicalId).toBeUndefined();
      // The construct path is restored for a readable report label.
      expect(removed!.constructPath).toBe('MyStack/Api ▸ GET /');
    });

    it('counts as drift (the parent-read parentReadSignal is itself the only OTHER finding)', () => {
      const b = baseline([recordedAdded({ AuthorizationType: 'NONE' })]);
      const out = applyBaseline([parentReadSignal()], b);
      // Exactly one detect-only `deleted` finding for the vanished endorsed child.
      expect(out.filter((f) => f.tier === 'deleted' && f.logicalId === CHILD)).toHaveLength(1);
    });
  });

  describe('regression — a recorded added resource STILL present fires neither gap', () => {
    it('unchanged live child is suppressed (still recorded, no false "removed")', () => {
      const b = baseline([recordedAdded({ AuthorizationType: 'NONE' })]);
      const out = applyBaseline([parentReadSignal(), added({ AuthorizationType: 'NONE' })], b);
      // No `deleted` "removed since record" finding: the child is present + unchanged.
      expect(out.find((f) => f.tier === 'deleted')).toBeUndefined();
      expect(out.find((f) => f.logicalId === CHILD)).toBeUndefined(); // suppressed
    });

    it('carryForwardUnreadable KEEPS it (nothing unread) without duplicating', () => {
      const b = baseline([recordedAdded({ AuthorizationType: 'NONE' })]);
      const findings = [parentReadSignal(), added({ AuthorizationType: 'NONE' })];
      const out = carryForwardUnreadable(buildRecorded(findings), b, findings);
      expect(out.filter((e) => e.logicalId === CHILD && e.path === '')).toHaveLength(1);
    });
  });

  describe('Gap 2 — a throttled parent carries the recorded added child forward', () => {
    it('carryForwardUnreadable preserves the child entry when the PARENT is `skipped`', () => {
      const b = baseline([recordedAdded({ AuthorizationType: 'NONE' })]);
      // Enumeration threw -> a `skipped` finding on the PARENT; buildRecorded produces NO
      // entry for the child this run (it was never enumerated).
      const findings = [parentSkipped()];
      expect(buildRecorded(findings)).toHaveLength(0);
      const out = carryForwardUnreadable(buildRecorded(findings), b, findings);
      // The child is carried forward (prefix-match: child id starts with `${parent}/`).
      expect(out).toContainEqual(recordedAdded({ AuthorizationType: 'NONE' }));
    });

    it('a throttled parent is NOT reported deleted by Gap 1 (interaction)', () => {
      const b = baseline([recordedAdded({ AuthorizationType: 'NONE' })]);
      // Parent `skipped` -> no positive read-proof -> Gap 1 must stay silent.
      const out = applyBaseline([parentSkipped()], b);
      expect(out.find((f) => f.tier === 'deleted' && f.logicalId === CHILD)).toBeUndefined();
      // The only finding is the parent's own skipped coverage-gap signal.
      expect(out).toEqual([parentSkipped()]);
    });
  });

  describe('a degenerate empty-findings input never false-reports a deletion', () => {
    it('no signal at all for the parent -> child folds to unread, not "removed"', () => {
      const b = baseline([recordedAdded({ AuthorizationType: 'NONE' })]);
      expect(applyBaseline([], b)).toHaveLength(0);
    });
  });
});

// #793: baseline entries store `resourceType` but the match ignored it. A logicalId reused
// for a DIFFERENT type (delete + re-add / refactor recycling the id) must not match the
// old-type entries. Worst case: the synthetic "baseline value removed since record" finding
// would pair the entry's OLD resourceType with the new resource's LIVE physical id → a
// revert would issue an op with the wrong TypeName. Guard: an entry whose resourceType
// disagrees with the live finding's type is VOID.

import { describe, expect, it } from 'vite-plus/test';
import { applyBaseline, type BaselineFile } from '../src/baseline/baseline-file.js';
import type { Finding } from '../src/types.js';

const OLD_TYPE = 'AWS::SQS::Queue';
const NEW_TYPE = 'AWS::SNS::Topic';

function baseline(recorded: BaselineFile['recorded']): BaselineFile {
  return {
    schemaVersion: 2,
    stackName: 's',
    region: 'r',
    accountId: '111122223333',
    capturedAt: '',
    templateHash: '',
    recorded,
    completeResources: recorded.map((e) => e.logicalId),
  };
}

const undeclared = (
  logicalId: string,
  resourceType: string,
  path: string,
  actual: unknown
): Finding => ({
  tier: 'undeclared',
  logicalId,
  resourceType,
  path,
  actual,
});

describe('#793 resourceType-mismatch void guard', () => {
  it('a same-logicalId same-value entry of a DIFFERENT type does not suppress the live value', () => {
    // Old baseline: logicalId "R" was an SQS::Queue with VisibilityTimeout=30.
    // The template now hosts an SNS::Topic under "R", live value also 30 (coincidence).
    // Without the type guard the entry would MATCH+suppress; with it, the SNS value is
    // reconciled as unrecorded (no entry for the NEW type), not silently suppressed.
    const b = baseline([{ logicalId: 'R', resourceType: OLD_TYPE, path: 'X', value: 30 }]);
    const live = [undeclared('R', NEW_TYPE, 'X', 30)];
    const out = applyBaseline(live, b, {});
    // completeResources says R is complete → an entry-less value "appeared since record",
    // NOT suppressed as a matching baseline value. Either way it must NOT be dropped.
    expect(out).toHaveLength(1);
    expect(out[0]?.resourceType).toBe(NEW_TYPE);
    // it did not silently vanish as a suppressed match
    expect(out[0]?.note).toMatch(/appeared since record/);
  });

  it('no synthetic "removed since record" finding pairs the OLD type with the new resource', () => {
    // Old entry for a path the NEW type does not have. Without the guard this becomes a
    // synthetic "baseline value removed since record" finding carrying resourceType=OLD_TYPE
    // and (via physicalIdByLogical) the NEW resource's physical id — a revert landmine.
    const b = baseline([
      { logicalId: 'R', resourceType: OLD_TYPE, path: 'OldOnlyProp', value: 'v' },
    ]);
    const live = [undeclared('R', NEW_TYPE, 'DifferentProp', 'w')];
    const out = applyBaseline(live, b, {
      physicalIdByLogical: new Map([['R', 'arn:new-topic']]),
    });
    // No finding should carry the OLD type paired with the NEW physical id.
    const stale = out.find(
      (f) => f.resourceType === OLD_TYPE && f.note === 'baseline value removed since record'
    );
    expect(stale).toBeUndefined();
    // Nothing at all should reference OldOnlyProp for the mismatched-type resource.
    expect(out.some((f) => f.path === 'OldOnlyProp')).toBe(false);
  });

  it('a SAME-type entry still matches and suppresses (guard does not over-void)', () => {
    const b = baseline([{ logicalId: 'R', resourceType: OLD_TYPE, path: 'X', value: 30 }]);
    const live = [undeclared('R', OLD_TYPE, 'X', 30)];
    const out = applyBaseline(live, b, {});
    // matching same-type entry with equal value is suppressed
    expect(out).toHaveLength(0);
  });

  it('a SAME-type entry whose value changed still surfaces as drift', () => {
    const b = baseline([{ logicalId: 'R', resourceType: OLD_TYPE, path: 'X', value: 30 }]);
    const live = [undeclared('R', OLD_TYPE, 'X', 999)];
    const out = applyBaseline(live, b, {});
    expect(out).toHaveLength(1);
    expect(out[0]?.tier).toBe('undeclared');
    expect(out[0]?.actual).toBe(999); // the changed live value surfaces as drift
  });

  it("an entry for a logicalId with NO live finding (unread) keeps today's behavior", () => {
    // No live finding for R at all → live type unknown → not type-void → the removed-since-
    // record path applies as before (surfaces as a removal finding of the recorded type).
    const b = baseline([{ logicalId: 'R', resourceType: OLD_TYPE, path: 'X', value: 30 }]);
    const out = applyBaseline([], b, {});
    const removal = out.find((f) => f.note === 'baseline value removed since record');
    expect(removal?.resourceType).toBe(OLD_TYPE);
  });
});

// #1314 — an AWS::Events::EventBusPolicy's OWN read carries a live-only `Statement[n].Sid`
// that the service STAMPS from the declared top-level `StatementId` (the registry
// propertyTransform `Statement: $merge([{"Sid": StatementId}, Statement])`). That transform
// gate (#881) only runs in the DECLARED findings loop; when the template declares a `Statement`
// WITHOUT an inline `Sid`, the stamped value is live-only and lands in the nested-undeclared
// inventory as `Statement[0].Sid` — a first-run [Potential Drift] on EVERY EventBusPolicy,
// violating the zero-first-run-drift invariant. Tier-2 DERIVED fold: the live Sid folds
// atDefault when it equals the declared StatementId; a Sid that DIFFERS (a real out-of-band
// statement swap) still surfaces as undeclared (detection preserved).
//
// This is the policy resource's OWN read — the sibling-EventBus reflection (#699) is a
// separate, already-handled path and is not exercised here.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// The real registry schema shape for AWS::Events::EventBusPolicy (from the corpus fixture):
// Action/Condition/Principal are writeOnly, EventBusName/StatementId createOnly.
const schema: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(['Action', 'Condition', 'Principal']),
  createOnly: new Set(['EventBusName', 'StatementId']),
  readOnlyPaths: [],
  writeOnlyPaths: ['Action', 'Condition', 'Principal'],
  createOnlyPaths: ['EventBusName', 'StatementId'],
  defaults: {},
  defaultPaths: {},
};

const stmt = {
  Effect: 'Allow',
  Principal: { AWS: 'arn:aws:iam::111111111111:root' },
  Action: 'events:PutEvents',
  Resource: 'arn:aws:events:us-east-1:111111111111:event-bus/mybus',
};

// A declared model that DECLARES a top-level StatementId but NO inline Sid on Statement.
const res: DesiredResource = {
  logicalId: 'BusPolicy',
  resourceType: 'AWS::Events::EventBusPolicy',
  physicalId: 'mybus|AllowPartner',
  declared: {
    EventBusName: 'mybus',
    StatementId: 'AllowPartner',
    Statement: stmt,
  },
};

const sidFindings = (fs: Finding[]) => fs.filter((f) => f.path === 'Statement[0].Sid');

describe('#1314 EventBusPolicy live Statement Sid == declared StatementId', () => {
  it('folds Statement[n].Sid to atDefault when it equals the declared StatementId', () => {
    // The service stamped StatementId into the stored statement as Sid — live-only.
    const live = {
      EventBusName: 'mybus',
      StatementId: 'AllowPartner',
      Statement: { ...stmt, Sid: 'AllowPartner' },
    };
    const f = classifyResource(res, live, schema);
    const sid = sidFindings(f);
    expect(sid).toHaveLength(1);
    expect(sid[0]?.tier).toBe('atDefault');
    // Zero first-run potential drift: nothing on this policy surfaces as undeclared.
    expect(f.filter((x) => x.tier === 'undeclared')).toHaveLength(0);
  });

  it('surfaces Statement[n].Sid as undeclared when it DIFFERS from the declared StatementId (detection preserved)', () => {
    // A real out-of-band statement swap: the live Sid no longer matches the declared StatementId.
    const live = {
      EventBusName: 'mybus',
      StatementId: 'AllowPartner',
      Statement: { ...stmt, Sid: 'OutOfBandSwap' },
    };
    const f = classifyResource(res, live, schema);
    const sid = sidFindings(f);
    expect(sid).toHaveLength(1);
    expect(sid[0]?.tier).toBe('undeclared');
    expect(sid[0]?.actual).toBe('OutOfBandSwap');
  });
});

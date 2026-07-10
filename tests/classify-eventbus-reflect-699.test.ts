import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// #699: AWS::Events::EventBus reflects its resource policy — set by declared sibling
// AWS::Events::EventBusPolicy resources — as an undeclared `Policy` property on the bus's
// live model, producing a first-run [Potential Drift] FP on every custom bus with a policy
// (the standard cross-account eventing setup), AND double-reporting each statement (the
// sibling EventBusPolicy already covers it). classify subtracts the sibling-owned statements
// (opts.siblingEventBusPolicies, built by gather.buildSiblingEventBusPolicies) STATEMENT by
// STATEMENT, so an out-of-band statement (matching no sibling) still surfaces, unless the
// template pins `Policy` inline.

const busSchema: SchemaInfo = {
  readOnly: new Set(['Arn']),
  writeOnly: new Set(['EventSourceName']),
  createOnly: new Set(['Name']),
  readOnlyPaths: ['Arn'],
  writeOnlyPaths: ['EventSourceName'],
  createOnlyPaths: ['Name'],
  defaults: {},
  defaultPaths: {},
};

const busResource: DesiredResource = {
  logicalId: 'BusEA82B648',
  resourceType: 'AWS::Events::EventBus',
  physicalId: 'CdkrdIntegBusABC',
  // A custom bus declares only its Name; it never declares a `Policy` — the policy is
  // owned by the sibling AWS::Events::EventBusPolicy resource(s).
  declared: {
    Name: 'CdkrdIntegBusABC',
  },
};

// The IAM-policy-document shape AWS reflects onto the bus, aggregated from its sibling
// EventBusPolicy statement(s). Each statement carries a `Sid` == the sibling StatementId.
const siblingStatement = {
  Sid: 'AllowSelfPutEvents',
  Effect: 'Allow',
  Principal: { AWS: ['111111111111'] },
  Action: ['events:PutEvents'],
  Resource: ['arn:aws:events:us-east-1:111111111111:event-bus/CdkrdIntegBusABC'],
};
const outOfBandStatement = {
  Sid: 'RogueCrossAccount',
  Effect: 'Allow',
  Principal: { AWS: ['999999999999'] },
  Action: ['events:PutEvents'],
  Resource: ['arn:aws:events:us-east-1:111111111111:event-bus/CdkrdIntegBusABC'],
};

const policyPaths = (findings: Finding[], tier: string) =>
  findings.filter((f) => f.tier === tier && f.path.startsWith('Policy'));

// The sibling-statement map built by gather.buildSiblingEventBusPolicies, keyed by the bus's
// identifier (== its physical id / Name): the statement the sibling AWS::Events::EventBusPolicy
// declares. classify subtracts these from the bus's reflected live Policy.Statement[].
const siblingEventBusPolicies: Record<string, unknown[]> = {
  CdkrdIntegBusABC: [siblingStatement],
};

describe('#699 EventBus reflects sibling EventBusPolicy resource policy', () => {
  it('(1) a bus whose live Policy holds ONLY sibling-owned statements → folds (no drift)', () => {
    const live: Record<string, unknown> = {
      Name: 'CdkrdIntegBusABC',
      Arn: 'arn:aws:events:us-east-1:111111111111:event-bus/CdkrdIntegBusABC',
      Policy: { Version: '2012-10-17', Statement: [siblingStatement] },
    };
    const findings = classifyResource(busResource, live, busSchema, { siblingEventBusPolicies });
    // The regression assertion: the reflected Policy must NOT surface anywhere.
    expect(findings.some((f) => f.path.startsWith('Policy'))).toBe(false);
    expect(policyPaths(findings, 'undeclared')).toEqual([]);
    expect(policyPaths(findings, 'declared')).toEqual([]);
  });

  it('(2) an inline-declared Policy is still compared (fail-open, not dropped)', () => {
    // A raw bus that pins the whole policy inline (not the standard CDK shape) must
    // compare normally — the reflected fold is skipped when Policy is declared inline.
    const declaredInline: DesiredResource = {
      ...busResource,
      declared: {
        Name: 'CdkrdIntegBusABC',
        Policy: { Version: '2012-10-17', Statement: [siblingStatement] },
      },
    };
    const live: Record<string, unknown> = {
      Name: 'CdkrdIntegBusABC',
      Arn: 'arn:aws:events:us-east-1:111111111111:event-bus/CdkrdIntegBusABC',
      // live has an EXTRA statement the inline declaration does not → a real declared drift.
      Policy: {
        Version: '2012-10-17',
        Statement: [siblingStatement, outOfBandStatement],
      },
    };
    const findings = classifyResource(declaredInline, live, busSchema);
    // Because it is declared inline, the divergence surfaces as a declared drift on Policy.
    const drift = findings.filter(
      (f) => (f.tier === 'declared' || f.tier === 'undeclared') && f.path.startsWith('Policy')
    );
    expect(drift.length).toBeGreaterThan(0);
  });

  // Statement-level subtraction (this change) removes only the sibling-OWNED statements from
  // the bus's reflected Policy.Statement[], so a purely out-of-band statement (owned by NO
  // sibling EventBusPolicy) is LEFT to surface — the core-invariant win vs a whole-prop drop.
  it('(3) an out-of-band statement (no matching sibling) still surfaces', () => {
    const live: Record<string, unknown> = {
      Name: 'CdkrdIntegBusABC',
      Arn: 'arn:aws:events:us-east-1:111111111111:event-bus/CdkrdIntegBusABC',
      Policy: { Version: '2012-10-17', Statement: [outOfBandStatement] },
    };
    const findings = classifyResource(busResource, live, busSchema, { siblingEventBusPolicies });
    expect(findings.some((f) => f.path.startsWith('Policy'))).toBe(true);
  });

  it('(4) sibling-owned + out-of-band → only the out-of-band surfaces', () => {
    const live: Record<string, unknown> = {
      Name: 'CdkrdIntegBusABC',
      Arn: 'arn:aws:events:us-east-1:111111111111:event-bus/CdkrdIntegBusABC',
      Policy: { Version: '2012-10-17', Statement: [siblingStatement, outOfBandStatement] },
    };
    const findings = classifyResource(busResource, live, busSchema, { siblingEventBusPolicies });
    const surfaced = findings.filter(
      (f) => (f.tier === 'undeclared' || f.tier === 'declared') && f.path.startsWith('Policy')
    );
    expect(surfaced.length).toBeGreaterThan(0);
    // The surfaced value must be the ROGUE statement only — the sibling-owned one was
    // subtracted, so no finding path/value references the sibling's Sid.
    expect(surfaced.some((f) => JSON.stringify(f).includes('RogueCrossAccount'))).toBe(true);
    expect(surfaced.some((f) => JSON.stringify(f).includes('AllowSelfPutEvents'))).toBe(false);
  });
});

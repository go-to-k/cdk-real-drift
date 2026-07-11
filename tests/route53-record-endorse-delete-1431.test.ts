// #1431 — the two halves #1312 / PR #1427 left for an out-of-band `added`
// AWS::Route53::RecordSet (NON_PROVISIONABLE — Cloud Control can neither GetResource nor
// DeleteResource it):
//
//   Part 1 (record-endorse, gather.ts): the added scan's CC GetResource is DOOMED for a
//   RecordSet, so the finding was flagged `modelReadFailed` and record/ignore could never
//   snapshot/endorse it — it re-surfaced as `added` on every check. Fix: skip the doomed CC
//   read and use the HostedZone child-enumerator's full `live` snippet as the recordable model.
//
//   Part 2 (real delete, writers.ts + plan.ts): route a `delete`-kind RecordSet item through a
//   type-specific SDK deleter (Route53 ChangeResourceRecordSets Action DELETE) instead of CC
//   DeleteResource, so `revert --remove-unrecorded` can actually remove the record — and exempt
//   a type with an SDK_DELETER from the #1405 notRevertable honest-bar.
import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { CloudFormationClient, DescribeTypeCommand } from '@aws-sdk/client-cloudformation';
import {
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
} from '@aws-sdk/client-route-53';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { addedFinding, readAddedModel } from '../src/commands/gather.js';
import {
  type AddedChild,
  diffRoute53HostedZoneChildren,
  route53RecordSetIdentifier,
} from '../src/read/child-enumerators.js';
import { buildRevertPlan } from '../src/revert/plan.js';
import { SDK_DELETERS } from '../src/revert/writers.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const ZONE = 'Z1234567890ABC';

const EMPTY_SCHEMA: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};

// ── the shared composite-identity helper (enumerator ↔ deleter must agree) ────

describe('route53RecordSetIdentifier — the shared composite identity (#1431)', () => {
  it('joins zone id + RAW name + UPPERCASED type with `_`', () => {
    expect(route53RecordSetIdentifier(ZONE, 'login.example.com.', 'cname')).toBe(
      `${ZONE}_login.example.com._CNAME`
    );
  });

  it('appends SetIdentifier for a routing variant', () => {
    expect(route53RecordSetIdentifier(ZONE, 'api.example.com.', 'A', 'green')).toBe(
      `${ZONE}_api.example.com._A_green`
    );
  });

  it('round-trips the enumerator: reconstructing from the live record equals the added identifier', () => {
    // The name deliberately CONTAINS underscores (`_dmarc`) — the case a split-based parse of
    // the composite could not disambiguate, and exactly why the deleter matches by full
    // reconstruction instead.
    const liveName = '_dmarc.example.com.';
    const added = diffRoute53HostedZoneChildren({
      hostedZoneId: ZONE,
      zoneApex: 'example.com',
      declaredRecords: [],
      liveRecords: [{ name: liveName, type: 'TXT', live: { Name: liveName, Type: 'TXT' } }],
    });
    expect(added[0]!.identifier).toBe(route53RecordSetIdentifier(ZONE, liveName, 'TXT'));
    expect(added[0]!.identifier).toBe(`${ZONE}__dmarc.example.com._TXT`);
  });
});

// ── Part 1: record-endorse — skip the doomed CC GetResource, use the snippet ──

describe('readAddedModel — a NON_PROVISIONABLE RecordSet is record-able off the enumerator snippet (#1431)', () => {
  const cc = mockClient(CloudControlClient);
  const cfn = mockClient(CloudFormationClient);
  beforeEach(() => {
    cc.reset();
    cfn.reset();
  });
  afterEach(() => {
    cc.restore();
    cfn.restore();
  });

  const recordSetChild = (): AddedChild => ({
    resourceType: 'AWS::Route53::RecordSet',
    identifier: `${ZONE}_login.example.com._CNAME`,
    label: 'CNAME login.example.com',
    live: {
      Name: 'login.example.com.',
      Type: 'CNAME',
      TTL: '300',
      ResourceRecords: ['evil.example.net'],
    },
  });

  it('does NOT call the doomed Cloud Control GetResource, and returns ok:true with the snippet model', async () => {
    // GetResource would throw UnsupportedActionException for this type — if it were called the
    // model would come back ok:false. Rig it to reject so a stray call is unmistakable.
    cc.on(GetResourceCommand).rejects(
      Object.assign(new Error('unsupported'), { name: 'UnsupportedActionException' })
    );
    const c = recordSetChild();
    const read = await readAddedModel(
      cc as unknown as CloudControlClient,
      cfn as unknown as CloudFormationClient,
      c,
      new Map([['AWS::Route53::RecordSet', EMPTY_SCHEMA]]),
      {}
    );
    expect(cc.commandCalls(GetResourceCommand).length).toBe(0);
    expect(read.ok).toBe(true);
    expect(read.model).toMatchObject({ Name: 'login.example.com.', Type: 'CNAME', TTL: '300' });
  });

  it('the resulting finding is record-able (no modelReadFailed → the picker offers record)', async () => {
    cc.on(GetResourceCommand).rejects(new Error('unsupported'));
    const c = recordSetChild();
    const read = await readAddedModel(
      cc as unknown as CloudControlClient,
      cfn as unknown as CloudFormationClient,
      c,
      new Map([['AWS::Route53::RecordSet', EMPTY_SCHEMA]]),
      {}
    );
    const parent: DesiredResource = {
      logicalId: 'Zone',
      resourceType: 'AWS::Route53::HostedZone',
      physicalId: ZONE,
      declared: {},
    };
    const f = addedFinding(parent, c, read);
    expect(f.tier).toBe('added');
    expect(f.modelReadFailed).toBeUndefined();
    expect(f.actual).toMatchObject({ Name: 'login.example.com.', Type: 'CNAME' });
  });

  it('a normal (CC-readable) added child still reads via Cloud Control GetResource (unchanged)', async () => {
    cc.on(GetResourceCommand).resolves({
      ResourceDescription: { Identifier: 'x|y', Properties: JSON.stringify({ Foo: 'bar' }) },
    });
    const c: AddedChild = {
      resourceType: 'AWS::ApiGateway::Method',
      identifier: 'api|res|ANY',
      label: 'ANY /',
      live: { HttpMethod: 'ANY' },
    };
    const read = await readAddedModel(
      cc as unknown as CloudControlClient,
      cfn as unknown as CloudFormationClient,
      c,
      new Map([['AWS::ApiGateway::Method', EMPTY_SCHEMA]]),
      {}
    );
    expect(cc.commandCalls(GetResourceCommand).length).toBe(1);
    expect(read.ok).toBe(true);
    expect(read.model).toMatchObject({ Foo: 'bar' });
  });

  it('does not need a DescribeType round-trip when the schema is already cached', async () => {
    cc.on(GetResourceCommand).rejects(new Error('unsupported'));
    await readAddedModel(
      cc as unknown as CloudControlClient,
      cfn as unknown as CloudFormationClient,
      recordSetChild(),
      new Map([['AWS::Route53::RecordSet', EMPTY_SCHEMA]]),
      {}
    );
    expect(cfn.commandCalls(DescribeTypeCommand).length).toBe(0);
  });
});

// ── Part 2a: the SDK deleter — read-then-DELETE the exact live record ─────────

describe('SDK_DELETERS[AWS::Route53::RecordSet] — ChangeResourceRecordSets DELETE (#1431)', () => {
  const r53 = mockClient(Route53Client);
  beforeEach(() => r53.reset());
  afterEach(() => r53.restore());

  const deleter = SDK_DELETERS['AWS::Route53::RecordSet']!;

  it('is registered (the routing table knows the type)', () => {
    expect(deleter).toBeDefined();
  });

  it('reads the zone, matches by reconstructed identity, and DELETEs the EXACT live record', async () => {
    // A rogue TXT whose name contains `_` — the deleter matches it by full reconstruction, not
    // a split, and passes the WHOLE live ResourceRecordSet to DELETE (Route53 requires exact).
    const target = {
      Name: '_dmarc.example.com.',
      Type: 'TXT' as const,
      TTL: 300,
      ResourceRecords: [{ Value: '"v=DMARC1; p=none"' }],
    };
    r53.on(ListResourceRecordSetsCommand).resolves({
      IsTruncated: false,
      ResourceRecordSets: [
        { Name: 'example.com.', Type: 'SOA', TTL: 900, ResourceRecords: [{ Value: 'ns.aws.' }] },
        target,
      ],
    });
    r53.on(ChangeResourceRecordSetsCommand).resolves({});

    await deleter({
      physicalId: `${ZONE}__dmarc.example.com._TXT`,
      parentPhysicalId: ZONE,
      region: 'us-east-1',
    });

    const calls = r53.commandCalls(ChangeResourceRecordSetsCommand);
    expect(calls.length).toBe(1);
    expect(calls[0]!.args[0].input).toEqual({
      HostedZoneId: ZONE,
      ChangeBatch: { Changes: [{ Action: 'DELETE', ResourceRecordSet: target }] },
    });
  });

  it('throws (an honest FAILED) when the parent HostedZone id is unresolvable', async () => {
    await expect(deleter({ physicalId: `${ZONE}_x_A`, region: 'us-east-1' })).rejects.toThrow(
      /HostedZone/
    );
    expect(r53.commandCalls(ChangeResourceRecordSetsCommand).length).toBe(0);
  });

  it('is a no-op when the record is already gone (no matching live record → converged)', async () => {
    r53.on(ListResourceRecordSetsCommand).resolves({
      IsTruncated: false,
      ResourceRecordSets: [
        { Name: 'example.com.', Type: 'SOA', TTL: 900, ResourceRecords: [{ Value: 'ns.aws.' }] },
      ],
    });
    await deleter({
      physicalId: `${ZONE}_gone.example.com._A`,
      parentPhysicalId: ZONE,
      region: 'us-east-1',
    });
    expect(r53.commandCalls(ChangeResourceRecordSetsCommand).length).toBe(0);
  });
});

// ── Part 2b: plan routing — a type with an SDK deleter is no longer barred ────

describe('buildRevertPlan — an added RecordSet builds a delete item (SDK-deleter exempt from #1405 bar) (#1431)', () => {
  const addedFindingOf = (resourceType: string, identifier: string): Finding => ({
    tier: 'added',
    logicalId: `Zone/${identifier}`,
    resourceType,
    path: '',
    physicalId: identifier,
    unrecorded: true, // + removeUnrecorded → a delete-kind plan item
    actual: { Name: 'x' },
  });

  it('Route53::RecordSet → a delete-kind item, NOT notRevertable', () => {
    const plan = buildRevertPlan(
      [addedFindingOf('AWS::Route53::RecordSet', `${ZONE}_login.example.com._CNAME`)],
      undefined,
      { removeUnrecorded: true }
    );
    expect(plan.notRevertable).toEqual([]);
    expect(plan.items.length).toBe(1);
    expect(plan.items[0]).toMatchObject({
      resourceType: 'AWS::Route53::RecordSet',
      kind: 'delete',
      physicalId: `${ZONE}_login.example.com._CNAME`,
    });
  });

  it('regression: EC2::NetworkAclEntry (no SDK deleter) is STILL barred as notRevertable', () => {
    const plan = buildRevertPlan(
      [addedFindingOf('AWS::EC2::NetworkAclEntry', 'acl-1|100|false|-1')],
      undefined,
      { removeUnrecorded: true }
    );
    expect(plan.items).toEqual([]);
    expect(plan.notRevertable.length).toBe(1);
    expect(plan.notRevertable[0]!.resourceType).toBe('AWS::EC2::NetworkAclEntry');
    expect(plan.notRevertable[0]!.reason).toMatch(/Cloud Control cannot delete/);
  });
});

// #1743: AWS::Route53::RecordSetGroup — no Cloud Control handlers, so the group was
// wholly `skipped` and its members' DECLARED drift was invisible. These pin the new
// SDK reader projection, the classify behavior on the projected model, and the
// per-member ChangeResourceRecordSets writer.
import {
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
} from '@aws-sdk/client-route-53';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { SDK_OVERRIDES } from '../src/read/overrides.js';
import { SDK_WRITERS } from '../src/revert/writers.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const emptySchema: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};

const r53 = mockClient(Route53Client);
beforeEach(() => r53.reset());

const ZONE = 'Z0AAAAEXAMPLE';
const DECLARED_GROUP = {
  HostedZoneId: ZONE,
  RecordSets: [
    {
      // mixed case + no trailing dot — Route53 stores lowercased + dotted
      Name: 'MiXeD-Case.cdkrd-test.com',
      Type: 'A',
      TTL: '300',
      ResourceRecords: ['192.0.2.1'],
    },
    {
      Name: 'txt.cdkrd-test.com.',
      Type: 'TXT',
      TTL: '300',
      // declared non-sorted; Route53 echoes its canonical order
      ResourceRecords: ['"zulu"', '"alpha"', '"mike"'],
    },
  ],
};
const LIVE_LISTING = {
  ResourceRecordSets: [
    {
      Name: 'mixed-case.cdkrd-test.com.',
      Type: 'A',
      TTL: 300,
      ResourceRecords: [{ Value: '192.0.2.1' }],
    },
    {
      Name: 'txt.cdkrd-test.com.',
      Type: 'TXT',
      TTL: 300,
      ResourceRecords: [{ Value: '"alpha"' }, { Value: '"mike"' }, { Value: '"zulu"' }],
    },
    // zone plumbing + a record that is NOT a group member — never projected
    { Name: 'cdkrd-test.com.', Type: 'NS', TTL: 172800, ResourceRecords: [{ Value: 'ns1.' }] },
    { Name: 'cdkrd-test.com.', Type: 'SOA', TTL: 900, ResourceRecords: [{ Value: 'soa' }] },
    {
      Name: 'other.cdkrd-test.com.',
      Type: 'A',
      TTL: 60,
      ResourceRecords: [{ Value: '192.0.2.9' }],
    },
  ],
  IsTruncated: false,
};

const groupResource = (): DesiredResource => ({
  logicalId: 'Records',
  resourceType: 'AWS::Route53::RecordSetGroup',
  physicalId: 'Records-abc',
  declared: structuredClone(DECLARED_GROUP),
});

const read = () =>
  SDK_OVERRIDES['AWS::Route53::RecordSetGroup']({
    physicalId: 'Records-abc',
    declared: structuredClone(DECLARED_GROUP) as Record<string, unknown>,
    region: 'us-east-1',
  } as never);

describe('#1743 RecordSetGroup reader projection', () => {
  it('projects each declared member in declared order, dot-aligned, live values', async () => {
    r53.on(ListResourceRecordSetsCommand).resolves(LIVE_LISTING as never);
    const m = (await read()) as Record<string, unknown>;
    expect(m.HostedZoneId).toBe(ZONE);
    const sets = m.RecordSets as Record<string, unknown>[];
    expect(sets).toHaveLength(2);
    // dot ALIGNED to the declared form (no trailing dot); case is the STORED lowercase —
    // folded by the CASE_INSENSITIVE_PATHS member entry, exactly like a standalone record
    expect(sets[0]).toEqual({
      Name: 'mixed-case.cdkrd-test.com',
      Type: 'A',
      TTL: '300',
      ResourceRecords: ['192.0.2.1'],
    });
    expect(sets[1]!.ResourceRecords).toEqual(['"alpha"', '"mike"', '"zulu"']);
    // the non-member live record is never projected
    expect(JSON.stringify(m)).not.toContain('other.cdkrd-test');
  });

  it('omits a member deleted out of band (the array diff surfaces it)', async () => {
    const listing = structuredClone(LIVE_LISTING);
    listing.ResourceRecordSets = listing.ResourceRecordSets.filter(
      (r) => r.Type !== 'TXT'
    ) as never;
    r53.on(ListResourceRecordSetsCommand).resolves(listing as never);
    const m = (await read()) as Record<string, unknown>;
    expect(m.RecordSets as unknown[]).toHaveLength(1);
  });
});

describe('#1743 classify on the projected group model', () => {
  const classified = (live: Record<string, unknown>): Finding[] =>
    classifyResource(groupResource(), live, emptySchema);
  const cleanLive = () => ({
    HostedZoneId: ZONE,
    RecordSets: [
      {
        Name: 'mixed-case.cdkrd-test.com',
        Type: 'A',
        TTL: '300',
        ResourceRecords: ['192.0.2.1'],
      },
      {
        Name: 'txt.cdkrd-test.com.',
        Type: 'TXT',
        TTL: '300',
        ResourceRecords: ['"alpha"', '"mike"', '"zulu"'],
      },
    ],
  });

  it('a clean deploy classifies with ZERO findings (case + reorder fold at member paths)', () => {
    expect(classified(cleanLive())).toEqual([]);
  });

  it('an out-of-band member TTL change surfaces as declared drift', () => {
    const live = cleanLive();
    (live.RecordSets[0] as Record<string, unknown>).TTL = '60';
    const declaredFindings = classified(live).filter((f) => f.tier === 'declared');
    expect(declaredFindings.length).toBeGreaterThan(0);
    expect(JSON.stringify(declaredFindings)).toContain('60');
  });

  it('an out-of-band VALUE change surfaces (multiset gate, not blanket-unordered)', () => {
    const live = cleanLive();
    (live.RecordSets[1] as Record<string, unknown>).ResourceRecords = [
      '"alpha"',
      '"mike"',
      '"rogue"',
    ];
    expect(classified(live).filter((f) => f.tier === 'declared').length).toBeGreaterThan(0);
  });

  it('a member deleted out of band surfaces as declared drift', () => {
    const live = cleanLive();
    live.RecordSets = [live.RecordSets[0]] as never;
    expect(classified(live).filter((f) => f.tier === 'declared').length).toBeGreaterThan(0);
  });
});

describe('#1743 RecordSetGroup writer', () => {
  it('UPSERTs only the touched member via one ChangeBatch', async () => {
    r53.on(ListResourceRecordSetsCommand).resolves(LIVE_LISTING as never);
    r53.on(ChangeResourceRecordSetsCommand).resolves({} as never);
    await SDK_WRITERS['AWS::Route53::RecordSetGroup'](
      {
        physicalId: 'Records-abc',
        declared: structuredClone(DECLARED_GROUP) as Record<string, unknown>,
        region: 'us-east-1',
        accountId: '123456789012',
      } as never,
      [
        {
          op: 'add',
          path: '/RecordSets/0/TTL',
          value: '300',
          human: 'RecordSets.0.TTL -> deployed-template value',
        },
      ]
    );
    const calls = r53.commandCalls(ChangeResourceRecordSetsCommand);
    expect(calls).toHaveLength(1);
    const batch = calls[0]!.args[0].input as {
      HostedZoneId?: string;
      ChangeBatch?: {
        Changes?: { Action?: string; ResourceRecordSet?: Record<string, unknown> }[];
      };
    };
    expect(batch.HostedZoneId).toBe(ZONE);
    const changes = batch.ChangeBatch!.Changes!;
    expect(changes).toHaveLength(1);
    expect(changes[0]!.Action).toBe('UPSERT');
    expect(changes[0]!.ResourceRecordSet!.Name).toBe('mixed-case.cdkrd-test.com');
    expect(changes[0]!.ResourceRecordSet!.TTL).toBe(300);
    expect(changes[0]!.ResourceRecordSet!.ResourceRecords).toEqual([{ Value: '192.0.2.1' }]);
  });

  it('a whole-array op UPSERTs every member (restores a deleted member)', async () => {
    r53.on(ListResourceRecordSetsCommand).resolves(LIVE_LISTING as never);
    r53.on(ChangeResourceRecordSetsCommand).resolves({} as never);
    await SDK_WRITERS['AWS::Route53::RecordSetGroup'](
      {
        physicalId: 'Records-abc',
        declared: structuredClone(DECLARED_GROUP) as Record<string, unknown>,
        region: 'us-east-1',
        accountId: '123456789012',
      } as never,
      [
        {
          op: 'add',
          path: '/RecordSets',
          value: DECLARED_GROUP.RecordSets,
          human: 'RecordSets -> deployed-template value',
        },
      ]
    );
    const changes = (
      r53.commandCalls(ChangeResourceRecordSetsCommand)[0]!.args[0].input as {
        ChangeBatch?: { Changes?: unknown[] };
      }
    ).ChangeBatch!.Changes!;
    expect(changes).toHaveLength(2);
  });
});

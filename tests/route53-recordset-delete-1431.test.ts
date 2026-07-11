// #1431 — the two halves #1312 (PR #1427) left for an out-of-band `added`
// AWS::Route53::RecordSet (NON_PROVISIONABLE — Cloud Control can neither read nor delete it):
//   1. record-endorse (read/gather): a CC GetResource fails every run → `modelReadFailed` →
//      buildRecorded drops the finding, so `record`/`ignore` could never endorse the record.
//      readAddedModel now uses the HostedZone enumerator's own `live` snippet (via
//      CC_READ_UNSUPPORTED_ADDED_TYPES) instead of the doomed CC read → ok:true, recordable.
//   2. real delete (revert): SDK_DELETERS routes the `delete`-kind item to a Route53
//      ChangeResourceRecordSets DELETE (the sibling of the declared-drift UPSERT writer), the
//      exact live RRSet matched by its enumerator-form composite id.
import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import {
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
} from '@aws-sdk/client-route-53';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { readAddedModel } from '../src/commands/gather.js';
import type { AddedChild } from '../src/read/child-enumerators.js';
import { SDK_DELETERS } from '../src/revert/writers.js';
import type { SchemaInfo } from '../src/types.js';

const ZONE = 'Z1234567890ABC';

// ── the SDK deleter: ChangeResourceRecordSets DELETE of the exact matched RRSet ──────────────

describe('SDK_DELETERS[AWS::Route53::RecordSet] — ChangeResourceRecordSets DELETE (#1431)', () => {
  const r53 = mockClient(Route53Client);
  beforeEach(() => r53.reset());
  afterEach(() => r53.restore());

  const deleter = SDK_DELETERS['AWS::Route53::RecordSet']!;

  it('is registered (the routing table knows the type)', () => {
    expect(deleter).toBeDefined();
  });

  it('DELETEs the live RRSet whose enumerator-form id matches, leaving the sibling untouched', async () => {
    const foo = {
      Name: 'foo.example.mytld.',
      Type: 'A',
      TTL: 300,
      ResourceRecords: [{ Value: '1.2.3.4' }],
    };
    const bar = {
      Name: 'bar.example.mytld.',
      Type: 'A',
      TTL: 300,
      ResourceRecords: [{ Value: '5.6.7.8' }],
    };
    r53
      .on(ListResourceRecordSetsCommand)
      .resolves({ ResourceRecordSets: [foo, bar], IsTruncated: false });
    r53.on(ChangeResourceRecordSetsCommand).resolves({});

    await deleter({
      physicalId: `${ZONE}_foo.example.mytld._A`,
      parentPhysicalId: ZONE,
      region: 'us-east-1',
    });

    const calls = r53.commandCalls(ChangeResourceRecordSetsCommand);
    expect(calls.length).toBe(1);
    const input = calls[0]!.args[0].input as {
      HostedZoneId?: string;
      ChangeBatch?: { Changes?: { Action?: string; ResourceRecordSet?: unknown }[] };
    };
    expect(input.HostedZoneId).toBe(ZONE);
    expect(input.ChangeBatch?.Changes?.[0]?.Action).toBe('DELETE');
    // The DELETE carries the EXACT live RRSet (Route53 rejects a partial match).
    expect(input.ChangeBatch?.Changes?.[0]?.ResourceRecordSet).toEqual(foo);
  });

  it('matches robustly when the DNS name itself contains "_" (e.g. _dmarc TXT)', async () => {
    const dmarc = {
      Name: '_dmarc.example.mytld.',
      Type: 'TXT',
      TTL: 300,
      ResourceRecords: [{ Value: '"v=DMARC1; p=none"' }],
    };
    r53
      .on(ListResourceRecordSetsCommand)
      .resolves({ ResourceRecordSets: [dmarc], IsTruncated: false });
    r53.on(ChangeResourceRecordSetsCommand).resolves({});

    await deleter({
      physicalId: `${ZONE}__dmarc.example.mytld._TXT`,
      parentPhysicalId: ZONE,
      region: 'us-east-1',
    });

    const calls = r53.commandCalls(ChangeResourceRecordSetsCommand);
    expect(calls.length).toBe(1);
    expect(
      (calls[0]!.args[0].input as { ChangeBatch?: { Changes?: { ResourceRecordSet?: unknown }[] } })
        .ChangeBatch?.Changes?.[0]?.ResourceRecordSet
    ).toEqual(dmarc);
  });

  it('disambiguates weighted siblings by SetIdentifier — deletes only the targeted one', async () => {
    const primary = {
      Name: 'api.example.mytld.',
      Type: 'A',
      SetIdentifier: 'primary',
      Weight: 100,
      TTL: 60,
      ResourceRecords: [{ Value: '1.1.1.1' }],
    };
    const secondary = {
      Name: 'api.example.mytld.',
      Type: 'A',
      SetIdentifier: 'secondary',
      Weight: 0,
      TTL: 60,
      ResourceRecords: [{ Value: '2.2.2.2' }],
    };
    r53
      .on(ListResourceRecordSetsCommand)
      .resolves({ ResourceRecordSets: [primary, secondary], IsTruncated: false });
    r53.on(ChangeResourceRecordSetsCommand).resolves({});

    await deleter({
      physicalId: `${ZONE}_api.example.mytld._A_secondary`,
      parentPhysicalId: ZONE,
      region: 'us-east-1',
    });

    const calls = r53.commandCalls(ChangeResourceRecordSetsCommand);
    expect(calls.length).toBe(1);
    expect(
      (calls[0]!.args[0].input as { ChangeBatch?: { Changes?: { ResourceRecordSet?: unknown }[] } })
        .ChangeBatch?.Changes?.[0]?.ResourceRecordSet
    ).toEqual(secondary);
  });

  it('follows pagination to find a match on a later page', async () => {
    const match = {
      Name: 'zzz.example.mytld.',
      Type: 'A',
      TTL: 300,
      ResourceRecords: [{ Value: '9.9.9.9' }],
    };
    r53
      .on(ListResourceRecordSetsCommand)
      .resolvesOnce({
        ResourceRecordSets: [
          {
            Name: 'aaa.example.mytld.',
            Type: 'A',
            TTL: 300,
            ResourceRecords: [{ Value: '1.1.1.1' }],
          },
        ],
        IsTruncated: true,
        NextRecordName: 'zzz.example.mytld.',
        NextRecordType: 'A',
      })
      .resolves({ ResourceRecordSets: [match], IsTruncated: false });
    r53.on(ChangeResourceRecordSetsCommand).resolves({});

    await deleter({
      physicalId: `${ZONE}_zzz.example.mytld._A`,
      parentPhysicalId: ZONE,
      region: 'us-east-1',
    });

    expect(r53.commandCalls(ListResourceRecordSetsCommand).length).toBe(2);
    expect(r53.commandCalls(ChangeResourceRecordSetsCommand).length).toBe(1);
  });

  it('a record already gone (no live match) is the goal state — no change, no throw', async () => {
    r53.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: [], IsTruncated: false });
    await deleter({
      physicalId: `${ZONE}_ghost.example.mytld._A`,
      parentPhysicalId: ZONE,
      region: 'us-east-1',
    });
    expect(r53.commandCalls(ChangeResourceRecordSetsCommand).length).toBe(0);
  });

  it('resolves the zone from the identifier prefix when the parent physical id is absent', async () => {
    const rec = {
      Name: 'foo.example.mytld.',
      Type: 'A',
      TTL: 300,
      ResourceRecords: [{ Value: '1.2.3.4' }],
    };
    r53
      .on(ListResourceRecordSetsCommand)
      .resolves({ ResourceRecordSets: [rec], IsTruncated: false });
    r53.on(ChangeResourceRecordSetsCommand).resolves({});

    await deleter({ physicalId: `${ZONE}_foo.example.mytld._A`, region: 'us-east-1' });

    expect(
      (
        r53.commandCalls(ListResourceRecordSetsCommand)[0]!.args[0].input as {
          HostedZoneId?: string;
        }
      ).HostedZoneId
    ).toBe(ZONE);
    expect(r53.commandCalls(ChangeResourceRecordSetsCommand).length).toBe(1);
  });
});

// ── the record-endorse half: readAddedModel uses the enumerator snippet, skips the CC read ───

const EMPTY_SCHEMA = {
  readOnly: new Set<string>(),
  writeOnly: new Set<string>(),
  createOnly: new Set<string>(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
} as SchemaInfo;

const recordSetChild: AddedChild = {
  resourceType: 'AWS::Route53::RecordSet',
  identifier: `${ZONE}_foo.example.mytld._A`,
  label: 'A foo.example.mytld',
  live: { Name: 'foo.example.mytld.', Type: 'A', TTL: '300', ResourceRecords: ['1.2.3.4'] },
};

describe('readAddedModel — #1431 NON_PROVISIONABLE added type records the enumerator snippet', () => {
  let cc: ReturnType<typeof mockClient>;
  let cfn: ReturnType<typeof mockClient>;
  beforeEach(() => {
    cc = mockClient(CloudControlClient);
    // A CC GetResource for a NON_PROVISIONABLE type throws UnsupportedActionException every run —
    // the pre-fix path would catch this and demote to ok:false (modelReadFailed).
    cc.on(GetResourceCommand).rejects(
      Object.assign(
        new Error('Resource type AWS::Route53::RecordSet does not support READ action'),
        {
          name: 'UnsupportedActionException',
        }
      )
    );
    cfn = mockClient(CloudFormationClient);
  });
  afterEach(() => {
    cc.restore();
    cfn.restore();
  });

  it('returns ok:true from the enumerator live model WITHOUT calling Cloud Control GetResource', async () => {
    const schemas = new Map([['AWS::Route53::RecordSet', EMPTY_SCHEMA]]);
    const res = await readAddedModel(
      cc as unknown as CloudControlClient,
      cfn as unknown as CloudFormationClient,
      recordSetChild,
      schemas,
      {}
    );
    expect(res.ok).toBe(true); // recordable — NOT modelReadFailed
    expect(res.model.Name).toBe('foo.example.mytld.');
    expect(res.model.Type).toBe('A');
    // The doomed CC read is skipped entirely (not attempted-then-caught).
    expect(cc.commandCalls(GetResourceCommand).length).toBe(0);
  });
});

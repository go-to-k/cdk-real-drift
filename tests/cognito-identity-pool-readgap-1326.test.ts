// #1326 — the Cognito IdentityPool reader (SDK_OVERRIDES, not a supplement) was left on the OLD
// #1085 mirror on a GetCognitoEvents failure: it copied the DECLARED CognitoEvents into the live
// model, producing ZERO findings. So the read-gap footer claimed the pool fully verified, a
// `record` during an outage blessed an unverified value, and an out-of-band-added Sync trigger
// (undeclared) behind the denial was fully invisible. The fix routes an override's partial
// read-gap through the SAME ReadResult.readGapPaths channel the SDK_SUPPLEMENTS path uses
// (#849/#1182): readCognitoIdentityPool returns a branded { model, readGapPaths:['CognitoEvents'] }
// on a LOUD failure, the router translates it, and classifyResource emits a counted readGap for
// BOTH the declared and the undeclared case. This drives readLive end to end (CC GetResource
// mocked OK, GetCognitoEvents → AccessDenied) and then classifyResource.
import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { CognitoSyncClient, GetCognitoEventsCommand } from '@aws-sdk/client-cognito-sync';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { readLive } from '../src/read/router.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const cc = mockClient(CloudControlClient);
const sync = mockClient(CognitoSyncClient);

const POOL_ID = 'us-east-1:12345678-1234-1234-1234-123456789012';
const EVENTS = { SyncTrigger: 'arn:aws:lambda:us-east-1:123456789012:function:MyTrigger' };
const REGION = 'us-east-1';
const ACCOUNT = '123456789012';

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

const resource = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'Pool',
  resourceType: 'AWS::Cognito::IdentityPool',
  physicalId: POOL_ID,
  declared,
});

const tierOf = (findings: Finding[], path: string) => findings.find((f) => f.path === path)?.tier;

beforeEach(() => {
  cc.reset();
  sync.reset();
  cc.on(GetResourceCommand).resolves({
    ResourceDescription: {
      Identifier: POOL_ID,
      Properties: JSON.stringify({
        IdentityPoolName: 'mypool',
        AllowUnauthenticatedIdentities: false,
      }),
    },
  });
  sync
    .on(GetCognitoEventsCommand)
    .rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#1326 Cognito IdentityPool GetCognitoEvents denial → counted readGap (not a silent mirror)', () => {
  it('readLive reports CognitoEvents in ReadResult.readGapPaths and leaves it absent from live', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const res = await readLive(
      cc as unknown as CloudControlClient,
      resource({ CognitoEvents: EVENTS }),
      REGION,
      ACCOUNT
    );
    expect(res.readGapPaths).toContain('CognitoEvents');
    // The declared value is NOT mirrored into live (pre-#1326 it was), so it is not read as verified.
    expect(res.live).toBeDefined();
    expect(res.live).not.toHaveProperty('CognitoEvents');
  });

  it('a DECLARED CognitoEvents classifies as readGap (footer + completeness), NOT a false declared removal', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const dr = resource({ CognitoEvents: EVENTS });
    const res = await readLive(cc as unknown as CloudControlClient, dr, REGION, ACCOUNT);
    const findings = classifyResource(dr, res.live ?? {}, emptySchema, {
      supplementReadGapPaths: res.readGapPaths,
    });
    expect(tierOf(findings, 'CognitoEvents')).toBe('readGap');
  });

  it('an UNDECLARED CognitoEvents classifies as readGap — the OOB Sync trigger behind the denial is no longer invisible', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const dr = resource({});
    const res = await readLive(cc as unknown as CloudControlClient, dr, REGION, ACCOUNT);
    expect(res.readGapPaths).toContain('CognitoEvents');
    const findings = classifyResource(dr, res.live ?? {}, emptySchema, {
      supplementReadGapPaths: res.readGapPaths,
    });
    expect(tierOf(findings, 'CognitoEvents')).toBe('readGap');
  });
});

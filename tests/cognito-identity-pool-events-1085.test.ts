import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { CognitoSyncClient, GetCognitoEventsCommand } from '@aws-sdk/client-cognito-sync';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { SDK_OVERRIDES } from '../src/read/overrides.js';

const cc = mockClient(CloudControlClient);
const sync = mockClient(CognitoSyncClient);

const POOL_ID = 'us-east-1:12345678-1234-1234-1234-123456789012';
const DECLARED_EVENTS = { SyncTrigger: 'arn:aws:lambda:us-east-1:123456789012:function:MyTrigger' };

const ctx = (
  physicalId: string,
  declared: Record<string, unknown> = {},
  region = 'us-east-1',
  accountId = '123456789012'
) => ({ physicalId, declared, region, accountId });

const read = (c: ReturnType<typeof ctx>) => SDK_OVERRIDES['AWS::Cognito::IdentityPool'](c);

// The CC base-model GetResource that always succeeds (a live pool). CognitoEvents is a
// writeOnly prop that Cloud Control never echoes, so it is absent from the CC model.
const okBaseModel = () =>
  cc.on(GetResourceCommand).resolves({
    ResourceDescription: {
      Identifier: POOL_ID,
      Properties: JSON.stringify({
        IdentityPoolName: 'mypool',
        AllowUnauthenticatedIdentities: false,
      }),
    },
  });

beforeEach(() => {
  cc.reset();
  sync.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AWS::Cognito::IdentityPool GetCognitoEvents failure handling (#1085)', () => {
  it('projects a NON-EMPTY live CognitoEvents map onto the base model', async () => {
    okBaseModel();
    sync.on(GetCognitoEventsCommand).resolves({ Events: DECLARED_EVENTS });

    const out = await read(ctx(POOL_ID, { CognitoEvents: DECLARED_EVENTS }));
    expect(out).toMatchObject({ CognitoEvents: DECLARED_EVENTS });
  });

  it('keeps a clean pool clean: empty live event map stays absent, no CognitoEvents projected', async () => {
    okBaseModel();
    sync.on(GetCognitoEventsCommand).resolves({ Events: {} });

    const out = await read(ctx(POOL_ID, {}));
    expect(out).not.toHaveProperty('CognitoEvents');
  });

  // The core #1085 regression: an AccessDenied (missing cognito-sync:GetCognitoEvents)
  // must NOT silently drop a DECLARED CognitoEvents. Before the fix, the reader returned a
  // model with CognitoEvents omitted -> the exempted-from-writeOnly-strip prop compared
  // against absent live -> a FALSE declared-tier "removed out of band" finding.
  it('does NOT drop a DECLARED CognitoEvents on AccessDenied — mirrors it to a readGap + warns', async () => {
    okBaseModel();
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    sync
      .on(GetCognitoEventsCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));

    const out = await read(ctx(POOL_ID, { CognitoEvents: DECLARED_EVENTS }));
    // The declared value is mirrored into live (declared == live -> no false drift).
    expect(out).toMatchObject({ CognitoEvents: DECLARED_EVENTS });
    // AND it warns LOUDLY on stderr — a fixable coverage gap, not a silent drop.
    expect(warn).toHaveBeenCalled();
    const msg = warn.mock.calls.map((c) => String(c[0])).join('');
    expect(msg).toContain('cognito-sync:GetCognitoEvents');
    expect(msg).toContain('AccessDeniedException');
  });

  it('does NOT drop a DECLARED CognitoEvents on throttling — mirrors it to a readGap + warns', async () => {
    okBaseModel();
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    sync
      .on(GetCognitoEventsCommand)
      .rejects(Object.assign(new Error('rate exceeded'), { name: 'ThrottlingException' }));

    const out = await read(ctx(POOL_ID, { CognitoEvents: DECLARED_EVENTS }));
    expect(out).toMatchObject({ CognitoEvents: DECLARED_EVENTS });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join('')).toContain('ThrottlingException');
  });

  it('an UNDECLARED CognitoEvents stays absent on AccessDenied (nothing to false-flag) but still warns', async () => {
    okBaseModel();
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    sync
      .on(GetCognitoEventsCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));

    const out = await read(ctx(POOL_ID, {}));
    // No declared CognitoEvents -> nothing to mirror -> stays absent (a clean pool).
    expect(out).not.toHaveProperty('CognitoEvents');
    expect(warn).toHaveBeenCalled();
  });

  it('genuine region-unavailability (UnknownEndpoint) degrades QUIETLY — mirrors declared, no warning', async () => {
    okBaseModel();
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    sync
      .on(GetCognitoEventsCommand)
      .rejects(Object.assign(new Error('endpoint not resolvable'), { name: 'UnknownEndpoint' }));

    const out = await read(ctx(POOL_ID, { CognitoEvents: DECLARED_EVENTS }));
    // Still no false declared-tier drift: the declared value is folded to a readGap.
    expect(out).toMatchObject({ CognitoEvents: DECLARED_EVENTS });
    // But it is SILENT — the deprecated cognito-sync service simply cannot exist there.
    expect(warn).not.toHaveBeenCalled();
  });

  it('region-unavailability via an ENOTFOUND DNS cause is also silent', async () => {
    okBaseModel();
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    sync
      .on(GetCognitoEventsCommand)
      .rejects(Object.assign(new Error('getaddrinfo ENOTFOUND'), { cause: { code: 'ENOTFOUND' } }));

    const out = await read(ctx(POOL_ID, { CognitoEvents: DECLARED_EVENTS }));
    expect(out).toMatchObject({ CognitoEvents: DECLARED_EVENTS });
    expect(warn).not.toHaveBeenCalled();
  });
});

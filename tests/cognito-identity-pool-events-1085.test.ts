import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { CognitoSyncClient, GetCognitoEventsCommand } from '@aws-sdk/client-cognito-sync';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  isOverrideReadResult,
  type OverrideReadResult,
  SDK_OVERRIDES,
} from '../src/read/overrides.js';

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

// Assert-and-cast: the reader's loud-failure return is a branded readGap result. Casting after
// the assertion keeps each expect at the top level (avoids vitest/no-conditional-expect).
const gapOf = (out: Awaited<ReturnType<typeof read>>): OverrideReadResult => {
  expect(isOverrideReadResult(out)).toBe(true);
  return out as unknown as OverrideReadResult;
};

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

  // The core #1085 regression: an AccessDenied (missing cognito-sync:GetCognitoEvents) must NOT
  // silently drop a DECLARED CognitoEvents. #1326 upgrades the #1085 mirror to a real COUNTED
  // readGap: the reader now returns a branded { model, readGapPaths } with CognitoEvents ABSENT
  // from the model, so classify emits a readGap finding (footer + completeness) instead of a
  // silent mirror — and NO false declared-tier "removed out of band" drift.
  it('reports a DECLARED CognitoEvents as a readGap on AccessDenied (no mirror) + warns', async () => {
    okBaseModel();
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    sync
      .on(GetCognitoEventsCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));

    const out = await read(ctx(POOL_ID, { CognitoEvents: DECLARED_EVENTS }));
    // A branded readGap result: CognitoEvents is NOT mirrored into the model (so it is not read
    // as verified), and the path is reported so classify counts it as a readGap.
    const gap = gapOf(out);
    expect(gap.model).not.toHaveProperty('CognitoEvents');
    expect(gap.readGapPaths).toContain('CognitoEvents');
    // AND it warns LOUDLY on stderr — a fixable coverage gap, not a silent drop.
    expect(warn).toHaveBeenCalled();
    const msg = warn.mock.calls.map((c) => String(c[0])).join('');
    expect(msg).toContain('cognito-sync:GetCognitoEvents');
    expect(msg).toContain('AccessDeniedException');
  });

  it('reports a DECLARED CognitoEvents as a readGap on throttling (no mirror) + warns', async () => {
    okBaseModel();
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    sync
      .on(GetCognitoEventsCommand)
      .rejects(Object.assign(new Error('rate exceeded'), { name: 'ThrottlingException' }));

    const out = await read(ctx(POOL_ID, { CognitoEvents: DECLARED_EVENTS }));
    expect(gapOf(out).readGapPaths).toContain('CognitoEvents');
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join('')).toContain('ThrottlingException');
  });

  it('reports an UNDECLARED CognitoEvents as a readGap on AccessDenied (OOB Sync trigger no longer silent) + warns', async () => {
    okBaseModel();
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    sync
      .on(GetCognitoEventsCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));

    const out = await read(ctx(POOL_ID, {}));
    // Pre-#1326 an undeclared CognitoEvents stayed absent + uncounted, so an out-of-band Sync
    // trigger behind the denial was fully invisible. Now the path is reported as a readGap.
    const gap = gapOf(out);
    expect(gap.model).not.toHaveProperty('CognitoEvents');
    expect(gap.readGapPaths).toContain('CognitoEvents');
    expect(warn).toHaveBeenCalled();
  });

  it('genuine region-unavailability (UnknownEndpoint) degrades QUIETLY — mirrors declared, no warning', async () => {
    okBaseModel();
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    sync
      .on(GetCognitoEventsCommand)
      .rejects(Object.assign(new Error('endpoint not resolvable'), { name: 'UnknownEndpoint' }));

    const out = await read(ctx(POOL_ID, { CognitoEvents: DECLARED_EVENTS }));
    // Region-unavailability stays QUIET (not a coverage gap — the service can't exist here), so
    // it keeps the #1085 mirror (declared == live → no false drift), NOT the #1326 loud readGap.
    expect(out).toMatchObject({ CognitoEvents: DECLARED_EVENTS });
    // And it is SILENT — the deprecated cognito-sync service simply cannot exist there.
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

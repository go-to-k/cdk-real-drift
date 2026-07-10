import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { describeTypeFailedWarning, getSchemaInfo } from '../src/schema/schema-strip.js';

// #751: when cloudformation:DescribeType fails (permission denied / throttled), the fetch
// caught the error and returned an EMPTY schema, and getSchemaInfo cached that EMPTY result
// process-wide. Consequences: readOnly live attributes are no longer stripped (first-run
// [Potential Drift] noise) and declared writeOnly props are no longer routed to readGap
// (false declared drift → `--fail` exits 1 on an untouched stack) — and it never recovered
// because the poisoned EMPTY was returned forever. The fix: warn once per type+region, and
// do NOT cache a failure so the next occurrence re-fetches.

// A CloudFormationClient-like fake whose `.config.region()` resolves to `region` and whose
// `.send()` is a vitest mock (so per-call behavior — throw then succeed — is scriptable).
function fakeClient(region: string, send: () => Promise<unknown>): CloudFormationClient {
  return {
    config: { region: () => Promise.resolve(region) },
    send,
  } as unknown as CloudFormationClient;
}

describe('getSchemaInfo DescribeType failure handling (#751)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT cache a DescribeType failure — a later call re-fetches the real schema', async () => {
    const resourceType = 'AWS::Foo::Failure751Bar';
    const region = 'eu-west-1';
    const schema = {
      properties: { Secret: { type: 'string' }, Name: { type: 'string' } },
      writeOnlyProperties: ['/properties/Secret'],
    };
    // First send() throws (denied / throttled); the second succeeds with a real schema.
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('AccessDeniedException'))
      .mockResolvedValue({ Schema: JSON.stringify(schema) });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const client = fakeClient(region, send as unknown as () => Promise<unknown>);

    // First call: DescribeType failed -> EMPTY (degrade, no strip), NOT cached.
    const first = await getSchemaInfo(client, resourceType);
    expect(first.writeOnly.has('Secret')).toBe(false);

    // Second call: because the failure was NOT cached, it re-fetches and now gets the real
    // schema (Secret writeOnly). Before the fix this returned the cached EMPTY forever.
    const second = await getSchemaInfo(client, resourceType);
    expect(second.writeOnly.has('Secret')).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('warns ONCE per type+region across repeated failures (no spam)', async () => {
    const resourceType = 'AWS::Foo::Failure751Warn';
    const region = 'us-west-2';
    const send = vi.fn().mockRejectedValue(new Error('ThrottlingException'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const client = fakeClient(region, send as unknown as () => Promise<unknown>);

    await getSchemaInfo(client, resourceType);
    await getSchemaInfo(client, resourceType);
    await getSchemaInfo(client, resourceType);

    // The warning is emitted exactly once for this type+region despite three failures
    // (mirrors the KMS ListAliases one-per-region warning). Re-fetch still happens each
    // time (failure not cached), but the stderr line is deduped.
    const warnCalls = errSpy.mock.calls.filter((c) =>
      String(c[0]).includes('cloudformation:DescribeType failed')
    );
    expect(warnCalls.length).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('caches a successful schema (no re-fetch on the second call)', async () => {
    const resourceType = 'AWS::Foo::Success751';
    const region = 'ap-southeast-2';
    const schema = { properties: { A: { type: 'string' } }, readOnlyProperties: ['/properties/A'] };
    const send = vi.fn().mockResolvedValue({ Schema: JSON.stringify(schema) });

    const client = fakeClient(region, send as unknown as () => Promise<unknown>);

    const first = await getSchemaInfo(client, resourceType);
    const second = await getSchemaInfo(client, resourceType);
    expect(first.readOnly.has('A')).toBe(true);
    expect(second.readOnly.has('A')).toBe(true);
    // A real schema IS cached, so send() runs only once.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('describeTypeFailedWarning names the type and region', () => {
    const msg = describeTypeFailedWarning('AWS::S3::Bucket', 'us-east-1');
    expect(msg).toContain('us-east-1');
    expect(msg).toContain('AWS::S3::Bucket');
    expect(msg).toContain('cloudformation:DescribeType');
  });
});

// #1311: `AWS::SimSpaceWeaver::Simulation` ships a `propertyTransform` whose KEY has NO
// leading slash — `"properties/MaximumDuration": "$uppercase(MaximumDuration)"`. The
// pointerToDotted helper only stripped a LEADING `/properties/`, so the transform landed
// under the dead dotted key `properties.MaximumDuration` and was never consulted; a
// template declaring `MaximumDuration: 5d` (service echoes `5D`) was a permanent declared
// false positive. The fix tolerates the optional leading slash — exercised here through
// the public getSchemaInfo, which keys propertyTransforms via pointerToDotted, plus the
// readOnly/writeOnly/createOnly strip that shares the same helper.
describe('pointerToDotted tolerates a no-leading-slash properties/ pointer (#1311)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keys a no-leading-slash propertyTransform under the real model path, not `properties.*`', async () => {
    const resourceType = 'AWS::SimSpaceWeaver::Simulation1311';
    const region = 'us-east-1';
    const schema = {
      properties: { MaximumDuration: { type: 'string' } },
      // The typo'd registry key: `properties/MaximumDuration` with NO leading slash.
      propertyTransform: { 'properties/MaximumDuration': '$uppercase(MaximumDuration)' },
    };
    const send = vi.fn().mockResolvedValue({ Schema: JSON.stringify(schema) });
    const client = fakeClient(region, send as unknown as () => Promise<unknown>);

    const info = await getSchemaInfo(client, resourceType);

    // The transform is now reachable under the real dotted key...
    expect(info.propertyTransforms?.['MaximumDuration']).toBe('$uppercase(MaximumDuration)');
    // ...and NOT stranded under the dead `properties.MaximumDuration` key (the pre-fix bug).
    expect(info.propertyTransforms?.['properties.MaximumDuration']).toBeUndefined();
  });

  it('still strips a normal leading-slash `/properties/Foo` readOnly/writeOnly pointer', async () => {
    const resourceType = 'AWS::Foo::Slash1311';
    const region = 'eu-west-1';
    const schema = {
      properties: { Id: { type: 'string' }, Secret: { type: 'string' } },
      readOnlyProperties: ['/properties/Id'],
      writeOnlyProperties: ['/properties/Secret'],
      // A no-leading-slash variant also folds correctly via the shared helper.
      createOnlyProperties: ['properties/Id'],
    };
    const send = vi.fn().mockResolvedValue({ Schema: JSON.stringify(schema) });
    const client = fakeClient(region, send as unknown as () => Promise<unknown>);

    const info = await getSchemaInfo(client, resourceType);

    // Leading-slash pointers keep working (no regression).
    expect(info.readOnly.has('Id')).toBe(true);
    expect(info.writeOnly.has('Secret')).toBe(true);
    // The no-leading-slash createOnly pointer also lands on the real key, not `properties`.
    expect(info.createOnly.has('Id')).toBe(true);
    expect(info.createOnly.has('properties')).toBe(false);
  });
});

// #804 — a whole-type SDK writer that maintains an INTERNAL allowlist of handled top-level
// props must NOT silently drop an op OUTSIDE that allowlist while the run reports `reverted:`.
// The client never sends anything for the dropped prop, yet stack-actions.ts prints
// `reverted:` and the convergence re-read shows "N drift(s) remain" with no explanation.
// The contained fix: the writer THROWS an honest failure naming the dropped prop(s), which the
// revert caller records as `ok:false` (not-reverted) — the same channel every other writer
// failure uses. These tests assert the un-handled op is reported not-reverted (throws), while a
// mixed op set still applies the convergeable (allowlist) prop before reporting the dropped one.
import { OpenSearchClient, UpdateDomainConfigCommand } from '@aws-sdk/client-opensearch';
import { DescribeDomainConfigCommand } from '@aws-sdk/client-opensearch';
import {
  ElasticBeanstalkClient,
  UpdateEnvironmentCommand,
} from '@aws-sdk/client-elastic-beanstalk';
import { ECSClient } from '@aws-sdk/client-ecs';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import type { OverrideCtx } from '../src/read/overrides.js';
import type { PatchOp } from '../src/revert/plan.js';
import { SDK_WRITERS, resolveSdkWriter } from '../src/revert/writers.js';

const opensearch = mockClient(OpenSearchClient);
const eb = mockClient(ElasticBeanstalkClient);
const ecs = mockClient(ECSClient);

const ctx = (over: Partial<OverrideCtx> = {}): OverrideCtx => ({
  physicalId: 'pid',
  declared: {},
  region: 'us-east-1',
  accountId: '123456789012',
  ...over,
});

beforeEach(() => {
  opensearch.reset();
  eb.reset();
  ecs.reset();
});

describe('#804 whole-type writer must report an op outside its allowlist as NOT reverted', () => {
  it('OpenSearch: a Tags op (outside OS_UPDATABLE_OPTIONS) is reported not-reverted, not a silent success', async () => {
    opensearch.on(DescribeDomainConfigCommand).resolves({ DomainConfig: {} } as never);
    opensearch.on(UpdateDomainConfigCommand).resolves({});
    // Tags is a mutable, reader-visible prop the UpdateDomainConfig path drops.
    await expect(
      SDK_WRITERS['AWS::OpenSearchService::Domain'](ctx({ physicalId: 'my-domain' }), [
        { op: 'add', path: '/Tags', value: [{ Key: 'a', Value: 'b' }], human: 'Tags -> value' },
      ])
    ).rejects.toThrow(/Tags/);
  });

  it('OpenSearch: a mixed op set applies the allowlist prop (EBSOptions) THEN reports the dropped one (EngineVersion)', async () => {
    opensearch.on(DescribeDomainConfigCommand).resolves({
      DomainConfig: { EBSOptions: { Options: { VolumeSize: 20 } } },
    } as never);
    opensearch.on(UpdateDomainConfigCommand).resolves({});
    await expect(
      SDK_WRITERS['AWS::OpenSearchService::Domain'](ctx({ physicalId: 'd' }), [
        { op: 'add', path: '/EBSOptions/VolumeSize', value: 10, human: 'x' },
        { op: 'add', path: '/EngineVersion', value: 'OpenSearch_2.11', human: 'x' },
      ])
    ).rejects.toThrow(/EngineVersion/);
    // the convergeable EBSOptions op WAS applied before the not-reverted report.
    const calls = opensearch.commandCalls(UpdateDomainConfigCommand);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.args[0].input as unknown as Record<string, unknown>).EBSOptions).toEqual({
      VolumeSize: 10,
    });
  });

  it('ElasticBeanstalk Environment: a VersionLabel op (the common OOB drift) is reported not-reverted', async () => {
    eb.on(UpdateEnvironmentCommand).resolves({});
    await expect(
      SDK_WRITERS['AWS::ElasticBeanstalk::Environment'](
        ctx({ physicalId: 'env', declared: { EnvironmentName: 'env' } }),
        [{ op: 'add', path: '/VersionLabel', value: 'v2', human: 'VersionLabel -> v2' }]
      )
    ).rejects.toThrow(/VersionLabel/);
    // nothing convergeable → no UpdateEnvironment call was sent.
    expect(eb.commandCalls(UpdateEnvironmentCommand)).toHaveLength(0);
  });

  it('ECS write-only-props writer: an unresolvable target throws instead of a silent success', async () => {
    // A raw-CFn service on the DEFAULT cluster declares no Cluster — the target cannot be
    // resolved. Before #804 the writer `return`ed silently (false `reverted:`); now it throws.
    const ops: PatchOp[] = [{ op: 'remove', path: '/ServiceConnectConfiguration', human: '' }];
    await expect(
      resolveSdkWriter('AWS::ECS::Service', ops)!(ctx({ physicalId: 'svc', declared: {} }), ops)
    ).rejects.toThrow(/ECS cluster\/service/);
  });
});

import {
  type DomainStatus,
  DescribeDomainsCommand,
  ListDomainNamesCommand,
  OpenSearchClient,
} from '@aws-sdk/client-opensearch';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { openSearchDomainTargetsPool } from '../src/read/child-enumerators.js';

// A minimal DomainStatus for the mock — only CognitoOptions is consulted by the function under
// test; the SDK type demands DomainId/DomainName/ARN/ClusterConfig, so cast a partial shape.
function domain(userPoolId: string): DomainStatus {
  return { CognitoOptions: { Enabled: true, UserPoolId: userPoolId } } as unknown as DomainStatus;
}

// #1265 follow-up: the OpenSearch `DescribeDomains` API accepts AT MOST 5 domain names per call.
// With >5 domains the single all-names call threw ValidationException → the fail-safe catch
// returned TRUE and rogue detection silently degraded for the WHOLE account. The fix chunks the
// names into batches of ≤5 and returns TRUE as soon as any batch matches THIS pool.
describe('openSearchDomainTargetsPool DescribeDomains batching (#1265)', () => {
  const os = mockClient(OpenSearchClient);
  const POOL = 'us-east-1_AbCdEf123';

  afterEach(() => os.reset());

  it('batches 6 domains into two DescribeDomains calls (5 + 1) and matches in the 2nd batch', async () => {
    const names = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
    os.on(ListDomainNamesCommand).resolves({
      DomainNames: names.map((n) => ({ DomainName: n })),
    });
    // First batch (d1..d5): no match. Second batch (d6): the target pool.
    os.on(DescribeDomainsCommand, { DomainNames: ['d1', 'd2', 'd3', 'd4', 'd5'] }).resolves({
      DomainStatusList: [domain('other-pool')],
    });
    os.on(DescribeDomainsCommand, { DomainNames: ['d6'] }).resolves({
      DomainStatusList: [domain(POOL)],
    });

    const result = await openSearchDomainTargetsPool('us-east-1', POOL);
    expect(result).toBe(true);
    const describeCalls = os.commandCalls(DescribeDomainsCommand);
    expect(describeCalls).toHaveLength(2);
    expect(describeCalls[0].args[0].input.DomainNames).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
    expect(describeCalls[1].args[0].input.DomainNames).toEqual(['d6']);
  });

  it('returns false only after ALL batches come back with no match', async () => {
    const names = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
    os.on(ListDomainNamesCommand).resolves({
      DomainNames: names.map((n) => ({ DomainName: n })),
    });
    os.on(DescribeDomainsCommand).resolves({
      DomainStatusList: [domain('nope')],
    });
    const result = await openSearchDomainTargetsPool('us-east-1', POOL);
    expect(result).toBe(false);
    // 7 names → ceil(7/5) = 2 batches.
    expect(os.commandCalls(DescribeDomainsCommand)).toHaveLength(2);
  });

  it('fail-safe: any throw returns true (never a false `added`)', async () => {
    os.on(ListDomainNamesCommand).rejects(new Error('AccessDenied'));
    const result = await openSearchDomainTargetsPool('us-east-1', POOL);
    expect(result).toBe(true);
  });

  it('no domains at all returns false without describing', async () => {
    os.on(ListDomainNamesCommand).resolves({ DomainNames: [] });
    const result = await openSearchDomainTargetsPool('us-east-1', POOL);
    expect(result).toBe(false);
    expect(os.commandCalls(DescribeDomainsCommand)).toHaveLength(0);
  });
});

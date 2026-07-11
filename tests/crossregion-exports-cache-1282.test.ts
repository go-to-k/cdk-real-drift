// #1282 — getCrossRegionExports (#1236 crossRegionReferences `/cdk/exports/*` prefetch) caches
// per account:region, but unlike listExports (which returns ALL exports) it fetches only the
// names the CURRENT stack references. The pre-fix code cached that first-stack SUBSET as the
// whole-key value and returned it verbatim to every later call:
//   const cached = crossRegionExportsCache.get(cacheKey); if (cached) return cached;
// so in a multi-stack run the SECOND same-region consumer stack — whose reader references
// DIFFERENT export names — got stack A's map, its own names were absent, and every reader
// GetAtt resolved UNRESOLVED (the out-of-band cert swap #741 catches went invisible again for
// stacks 2..N). The fix keeps the account:region key but MERGES: it fetches only names not yet
// requested for the key and accumulates, with a tombstone so a confirmed-missing name is not
// re-paged by every stack, and commits to the cache only after a fully-successful fetch (the
// throw-before-set poison-free failure contract is preserved).
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { getCrossRegionExports } from '../src/desired/template-adapter.js';

const REGION = 'eu-central-1';
const CERT_A = '/cdk/exports/CertA';
const CERT_B = '/cdk/exports/CertB';
const ARN_A = 'arn:aws:acm:us-east-1:444455556666:certificate/aaaa';
const ARN_B = 'arn:aws:acm:us-east-1:444455556666:certificate/bbbb';

// Each test uses a UNIQUE account id so the process-level module cache (keyed account:region)
// never bleeds one test's accumulation into another.
let acctSeq = 0;
function freshAccount(): string {
  acctSeq += 1;
  return String(100000000000 + acctSeq);
}

// An SSM stub that serves a fixed AVAILABLE map: a requested name present in it resolves; a name
// absent from it comes back as InvalidParameters (dropped from Parameters), the "missing" shape.
// Returns the raw stub (inferred type) so commandCalls(...) stays typed; cast to SSMClient at
// the call site.
function ssmServing(available: Record<string, string>) {
  const stub = mockClient(SSMClient);
  stub.on(GetParametersCommand).callsFake((input: { Names?: string[] }) => {
    const names = input.Names ?? [];
    return {
      Parameters: names
        .filter((n) => n in available)
        .map((n) => ({ Name: n, Value: available[n] })),
      InvalidParameters: names.filter((n) => !(n in available)),
    };
  });
  return stub;
}

describe('getCrossRegionExports — per-name merge across same-region stacks (#1282)', () => {
  beforeEach(() => {
    acctSeq += 1000; // widen the gap between runs so a leaked key never coincides
  });

  it('a second stack’s DISTINCT export name on the same account:region is fetched and merged', async () => {
    const acct = freshAccount();
    const stub = ssmServing({ [CERT_A]: ARN_A, [CERT_B]: ARN_B });
    const ssm = stub as unknown as SSMClient;

    // Stack A references only CertA.
    const a = await getCrossRegionExports(ssm, acct, REGION, [CERT_A]);
    expect(a[CERT_A]).toBe(ARN_A);

    // Stack B references only CertB — pre-fix it received A's cached subset ({CertA}) and CertB
    // was absent → UNRESOLVED. The merge must fetch CertB and return it.
    const b = await getCrossRegionExports(ssm, acct, REGION, [CERT_B]);
    expect(b[CERT_B]).toBe(ARN_B);
    // …and the accumulated map still carries A (a running merge, not a per-stack replace).
    expect(b[CERT_A]).toBe(ARN_A);
    // CertB was actually requested from SSM (pre-fix it never would be).
    const requested = stub
      .commandCalls(GetParametersCommand)
      .flatMap((c) => c.args[0].input.Names ?? []);
    expect(requested).toContain(CERT_B);
  });

  it('does NOT re-request a name already requested for the key (tombstone → cache hit)', async () => {
    const acct = freshAccount();
    const stub = ssmServing({ [CERT_A]: ARN_A });
    const ssm = stub as unknown as SSMClient;

    await getCrossRegionExports(ssm, acct, REGION, [CERT_A]);
    const before = stub.commandCalls(GetParametersCommand).length;
    const again = await getCrossRegionExports(ssm, acct, REGION, [CERT_A]);
    const after = stub.commandCalls(GetParametersCommand).length;

    expect(again[CERT_A]).toBe(ARN_A);
    expect(after).toBe(before); // second call served entirely from cache, no SDK call
  });

  it('a first stack whose parameter is MISSING does not starve a later stack (no {} poison)', async () => {
    const acct = freshAccount();
    // CertA missing (its producer was deleted), CertB live.
    const ssm = ssmServing({ [CERT_B]: ARN_B }) as unknown as SSMClient;

    const a = await getCrossRegionExports(ssm, acct, REGION, [CERT_A]);
    expect(a[CERT_A]).toBeUndefined(); // fail closed → UNRESOLVED downstream

    // Pre-fix the empty {} was cached for the whole key and B got it → B was blinded too.
    const b = await getCrossRegionExports(ssm, acct, REGION, [CERT_B]);
    expect(b[CERT_B]).toBe(ARN_B);
  });

  it('a throw mid-fetch leaves the cache UNTOUCHED — the name is retried, not poisoned', async () => {
    const acct = freshAccount();
    const stub = mockClient(SSMClient);
    let calls = 0;
    stub.on(GetParametersCommand).callsFake((input: { Names?: string[] }) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('AccessDenied'));
      return Promise.resolve({
        Parameters: (input.Names ?? []).map((n) => ({ Name: n, Value: ARN_A })),
        InvalidParameters: [],
      });
    });
    const ssm = stub as unknown as SSMClient;

    await expect(getCrossRegionExports(ssm, acct, REGION, [CERT_A])).rejects.toThrow(
      'AccessDenied'
    );
    // The failed name was NOT tombstoned and no partial map was cached, so a later run retries it
    // and resolves — the caller's warn+UNRESOLVED fallback for THIS run stays as before.
    const retry = await getCrossRegionExports(ssm, acct, REGION, [CERT_A]);
    expect(retry[CERT_A]).toBe(ARN_A);
  });
});

// #1321 — supplementTrustStore (ELBv2 TrustStore CA-bundle content-hash supplement) fetches
// the presigned CA-bundle URL. Before the fix that fetch was a BARE `await fetch(url)` (the
// global undici fetch, no AbortController/signal/timeout) and the body read `await
// resp.text()` was unbounded — the ONLY non-SDK HTTP call on the read path, predating #1066,
// so it bypassed the #1066 timeout contract. undici bounds HEADERS only at 300s, so a
// trickling / never-completing body hung `check` FOREVER. The fix bounds it with
// AbortSignal.timeout(CLIENT_REQUEST_HANDLER.requestTimeout) — the same #1066 request timeout
// the wired SDK clients use — and degrades a timeout/abort to the documented best-effort skip
// (keep the CC model), never a fatal hang.
import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import {
  ElasticLoadBalancingV2Client,
  GetTrustStoreCaCertificatesBundleCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { CLIENT_REQUEST_HANDLER } from '../src/read/client-config.js';
import { readLive } from '../src/read/router.js';
import type { DesiredResource } from '../src/types.js';

const cc = mockClient(CloudControlClient);
const elbv2 = mockClient(ElasticLoadBalancingV2Client);

const arn = 'arn:aws:elasticloadbalancing:us-east-1:111111111111:truststore/cdkrd-ts/abc';
const bundle = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';

const ts = (): DesiredResource => ({
  logicalId: 'L',
  resourceType: 'AWS::ElasticLoadBalancingV2::TrustStore',
  physicalId: arn,
  declared: { Name: 'cdkrd-ts' },
});

beforeEach(() => {
  cc.reset();
  elbv2.reset();
  cc.on(GetResourceCommand).resolves({
    ResourceDescription: { Properties: `{"TrustStoreArn":"${arn}","Name":"cdkrd-ts"}` },
  });
  elbv2
    .on(GetTrustStoreCaCertificatesBundleCommand)
    .resolves({ Location: 'https://s3.example.com/presigned' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('supplementTrustStore CA-bundle fetch honors the #1066 timeout contract (#1321)', () => {
  it('passes an AbortSignal to fetch (the #1066 timeout guard, previously absent)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(bundle) });
    vi.stubGlobal('fetch', fetchMock);

    const r = await readLive(cc as unknown as CloudControlClient, ts(), 'us-east-1', '1');

    // Success still projects the digest (behavior unchanged for the happy path).
    expect(r.live?.CaCertificatesBundleSha256).toMatch(/^[0-9a-f]{64}$/);

    // The fix: the fetch call now carries an abort signal. Before the fix it was
    // `fetch(url)` with NO second argument, so this assertion FAILS without the fix.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('https://s3.example.com/presigned');
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the shared #1066 request timeout as the abort deadline', async () => {
    // AbortSignal.timeout(ms) schedules the abort; assert the timeout VALUE reused is the
    // shared CLIENT_REQUEST_HANDLER.requestTimeout (not a bare hardcoded literal).
    const spy = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(bundle) })
    );

    await readLive(cc as unknown as CloudControlClient, ts(), 'us-east-1', '1');

    expect(spy).toHaveBeenCalledWith(CLIENT_REQUEST_HANDLER.requestTimeout);
    spy.mockRestore();
  });

  it('degrades to the non-fatal skip when the fetch aborts/times out (keeps the CC model, no throw)', async () => {
    // A rejecting fetch models the AbortSignal.timeout firing (undici throws a
    // TimeoutError/AbortError). It must NOT propagate out of the reader as a fatal hang —
    // the CA-bundle digest is best-effort, so the supplement keeps the CC model.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
    );

    const r = await readLive(cc as unknown as CloudControlClient, ts(), 'us-east-1', '1');

    // The read did NOT throw and the CC model is preserved WITHOUT the synthetic digest.
    expect(r.live).toEqual({ TrustStoreArn: arn, Name: 'cdkrd-ts' });
    expect(r.live?.CaCertificatesBundleSha256).toBeUndefined();
    expect(r.skippedReason).toBeUndefined();
  });

  it('degrades when the body read (resp.text) rejects under the same signal', async () => {
    // The single signal also aborts the body read — a text() that rejects (aborted mid-body)
    // must fall into the same best-effort skip, not throw.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      })
    );

    const r = await readLive(cc as unknown as CloudControlClient, ts(), 'us-east-1', '1');

    expect(r.live).toEqual({ TrustStoreArn: arn, Name: 'cdkrd-ts' });
    expect(r.skippedReason).toBeUndefined();
  });
});

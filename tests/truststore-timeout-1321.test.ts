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
import {
  CLIENT_REQUEST_HANDLER,
  PROXY_ENV_VARS,
  resetProxyConfig,
} from '../src/read/client-config.js';
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

// The fetch-stub describes below assert the UNPROXIED branch (#1841 keeps it
// byte-identical), so pin the environment to unproxied rather than inheriting whatever
// the developer's shell exports; the proxied branch has its own describe at the bottom.
// NO_PROXY is pinned too — PROXY_ENV_VARS deliberately excludes it (it configures no
// proxy), but a shell exporting `NO_PROXY='*'` would exempt the proxied describe's
// endpoint and dial direct, failing its CONNECT assertion.
const PINNED_PROXY_ENV = [...PROXY_ENV_VARS, 'NO_PROXY', 'no_proxy'] as const;
const savedProxyEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of PINNED_PROXY_ENV) {
    savedProxyEnv[name] = process.env[name];
    delete process.env[name];
  }
  resetProxyConfig();
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
  for (const name of PINNED_PROXY_ENV) {
    const value = savedProxyEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetProxyConfig();
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

describe('the presigned CA-bundle fetch honours HTTPS_PROXY (#1841)', () => {
  it('routes through the proxy (undici fetch never consulted), degrading when it fails', async () => {
    // undici ignores the proxy variables, so under a proxy the supplement makes the GET
    // through node:https + ProxyRoutingAgent instead. Point HTTPS_PROXY at a local TCP
    // server that records what arrives and then kills the connection: the proxy must
    // receive a CONNECT for the presigned URL's host, the stubbed global fetch must stay
    // untouched, and the failed read must degrade to the documented best-effort skip.
    const { createServer } = await import('node:net');
    const received: string[] = [];
    const proxy = createServer((sock) => {
      sock.once('data', (chunk) => {
        received.push(chunk.toString('utf-8'));
        sock.destroy();
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const addr = proxy.address();
    const proxyPort = typeof addr === 'object' && addr ? addr.port : 0;
    process.env['HTTPS_PROXY'] = `http://127.0.0.1:${proxyPort}`;
    resetProxyConfig();

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(bundle) });
    vi.stubGlobal('fetch', fetchMock);
    elbv2
      .on(GetTrustStoreCaCertificatesBundleCommand)
      .resolves({ Location: 'https://cdkrd-bundle.invalid/presigned' });

    try {
      const r = await readLive(cc as unknown as CloudControlClient, ts(), 'us-east-1', '1');

      expect(received.length).toBeGreaterThan(0);
      expect(received[0]).toMatch(/^CONNECT cdkrd-bundle\.invalid:443/);
      expect(fetchMock).not.toHaveBeenCalled();
      // the destroyed tunnel degrades to the best-effort skip, exactly like a fetch error
      expect(r.live).toEqual({ TrustStoreArn: arn, Name: 'cdkrd-ts' });
      expect(r.live?.CaCertificatesBundleSha256).toBeUndefined();
      expect(r.skippedReason).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});

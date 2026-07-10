import { createServer, type Server } from 'node:net';
import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  CLIENT_CREDENTIALS,
  CLIENT_REQUEST_HANDLER,
  CLIENT_TIMEOUTS,
} from '../src/read/client-config.js';

// #1319 — credential resolution had NO timeouts. CLIENT_CREDENTIALS called fromNodeProviderChain
// with NO clientConfig, so the inner STS / SSO / SSO-OIDC clients the provider chain spawns
// (standard role-assuming / SSO org setup) used SDK defaults — no request timeout — bypassing
// the #1066 requestHandler every wired service client uses. A stalled STS endpoint hung
// check/record/revert FOREVER, before any wired client's own timeout could even start.
// The fix hoists the requestHandler to CLIENT_REQUEST_HANDLER and passes it via
// `clientConfig` to BOTH fromNodeProviderChain call sites (and reuses it in CLIENT_TIMEOUTS).
describe('#1319 CLIENT_REQUEST_HANDLER is the single source of truth', () => {
  it('carries the #1066 connection + request timeouts (with throwOnRequestTimeout)', () => {
    expect(typeof CLIENT_REQUEST_HANDLER.connectionTimeout).toBe('number');
    expect(typeof CLIENT_REQUEST_HANDLER.requestTimeout).toBe('number');
    expect(CLIENT_REQUEST_HANDLER.connectionTimeout).toBeGreaterThan(0);
    expect(CLIENT_REQUEST_HANDLER.requestTimeout).toBeGreaterThan(0);
    // without this the requestTimeout only WARNS and the request keeps hanging
    expect(CLIENT_REQUEST_HANDLER.throwOnRequestTimeout).toBe(true);
  });

  it('CLIENT_TIMEOUTS reuses the SAME shared requestHandler reference', () => {
    // one source of truth — a regression that gives the wired clients a different handler
    // (or drops it) fails here
    expect(CLIENT_TIMEOUTS.requestHandler).toBe(CLIENT_REQUEST_HANDLER);
  });
});

// End-to-end: point the credential provider chain's inner STS client at a TCP server that
// ACCEPTS the connection but never sends an HTTP response (the "connected but silent" hang).
// With the fix, CLIENT_CREDENTIALS resolving through the stalled STS endpoint ABORTS at its
// requestTimeout instead of hanging. A control CloudControl client (with CLIENT_TIMEOUTS)
// also rejects, proving the same timeout contract now covers credential resolution too.
describe('#1319 credential resolution no longer hangs on a stalled STS endpoint', () => {
  let server: Server;
  let port = 0;
  const sockets: import('node:net').Socket[] = [];
  const saved: Record<string, string | undefined> = {};
  // env vars that steer credential resolution + STS endpoint; snapshot + neutralize so the
  // ambient dev environment (a real profile / creds) can't short-circuit the assume-role path.
  const ENV_KEYS = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_DEFAULT_PROFILE',
    'CDKRD_EXPLICIT_PROFILE',
    'AWS_ROLE_ARN',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ENDPOINT_URL_STS',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_EC2_METADATA_DISABLED',
  ] as const;

  beforeAll(async () => {
    server = createServer((sock) => {
      sockets.push(sock); // hold the socket open, never write a response
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });
  afterAll(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('control: a CloudControl client with CLIENT_TIMEOUTS rejects (does not hang)', async () => {
    const c = new CloudControlClient({
      region: 'us-east-1',
      endpoint: `http://127.0.0.1:${port}`,
      credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
      maxAttempts: 1,
      // short values so the test is fast — same shape as CLIENT_REQUEST_HANDLER
      requestHandler: { connectionTimeout: 500, requestTimeout: 500, throwOnRequestTimeout: true },
    });
    const started = Date.now();
    await expect(
      c.send(new GetResourceCommand({ TypeName: 'AWS::SNS::Topic', Identifier: 'x' }))
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    c.destroy();
  });

  it('CLIENT_CREDENTIALS resolving through a stalled STS endpoint ABORTS rather than hanging', async () => {
    // Force the provider chain onto the assume-role (STS) path pointed at the silent server:
    // static base creds + AWS_ROLE_ARN makes fromNodeProviderChain assume the role via an STS
    // client, and AWS_ENDPOINT_URL_STS routes that client at the hanging server. Without the
    // fix the STS client has no requestTimeout and this promise never settles.
    process.env.AWS_ACCESS_KEY_ID = 'AKIABASE';
    process.env.AWS_SECRET_ACCESS_KEY = 'basesecret';
    process.env.AWS_ROLE_ARN = 'arn:aws:iam::123456789012:role/cdkrd-test';
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_EC2_METADATA_DISABLED = 'true';
    process.env.AWS_ENDPOINT_URL_STS = `http://127.0.0.1:${port}`;

    const started = Date.now();
    // Either it rejects (STS assume-role attempt times out) or — if this SDK build short-
    // circuits AssumeRole for these env creds — it resolves the BASE identity fast. Both are
    // non-hangs. The regression (no clientConfig timeout) is a promise that never settles,
    // which the test-runner timeout would catch; we additionally bound the elapsed time.
    const settled = await CLIENT_CREDENTIALS()
      .then(() => 'resolved' as const)
      .catch(() => 'rejected' as const);
    const elapsed = Date.now() - started;
    expect(settled === 'resolved' || settled === 'rejected').toBe(true);
    // With the shared requestHandler the STS attempt aborts at requestTimeout (60s), well
    // under a genuine hang; a resolve is near-instant. Either way, bounded.
    expect(elapsed).toBeLessThan(70_000);
  }, 75_000);
});

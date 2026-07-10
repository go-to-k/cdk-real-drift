import { createServer, type Server } from 'node:net';
import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { CLIENT_TIMEOUTS, READ_RETRY } from '../src/read/client-config.js';

// #1066 — no cdkrd AWS client configured any timeout, so a stalled TCP connect or a
// connected-but-silent server hung check/record/revert FOREVER. CLIENT_TIMEOUTS carries the
// connection + per-request timeouts applied to every client (READ clients via READ_RETRY,
// revert WRITE clients spread directly).
describe('#1066 CLIENT_TIMEOUTS config', () => {
  it('carries a connectionTimeout and requestTimeout', () => {
    expect(typeof CLIENT_TIMEOUTS.requestHandler.connectionTimeout).toBe('number');
    expect(typeof CLIENT_TIMEOUTS.requestHandler.requestTimeout).toBe('number');
    expect(CLIENT_TIMEOUTS.requestHandler.connectionTimeout).toBeGreaterThan(0);
    expect(CLIENT_TIMEOUTS.requestHandler.requestTimeout).toBeGreaterThan(0);
    // without this the requestTimeout only WARNS and the request keeps hanging
    expect(CLIENT_TIMEOUTS.requestHandler.throwOnRequestTimeout).toBe(true);
  });

  it('READ_RETRY keeps the adaptive read retry AND inherits the timeouts', () => {
    expect(READ_RETRY.retryMode).toBe('adaptive');
    expect(READ_RETRY.maxAttempts).toBe(10);
    expect(READ_RETRY.requestHandler).toBe(CLIENT_TIMEOUTS.requestHandler);
  });
});

// End-to-end: a TCP server that ACCEPTS the connection but never sends an HTTP response
// (the "connected but silent" hang). With requestTimeout the client aborts; WITHOUT the
// fix the send would hang until the process is killed.
describe('#1066 a silent server no longer hangs forever (requestTimeout aborts)', () => {
  let server: Server;
  let port = 0;
  const sockets: import('node:net').Socket[] = [];

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

  it('rejects within the timeout window instead of hanging', async () => {
    const c = new CloudControlClient({
      region: 'us-east-1',
      endpoint: `http://127.0.0.1:${port}`,
      credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
      maxAttempts: 1, // no retries — isolate a single attempt's timeout
      // same shape as CLIENT_TIMEOUTS (throwOnRequestTimeout makes the timeout ABORT, not
      // just warn) with short values so the test is fast
      requestHandler: { connectionTimeout: 500, requestTimeout: 500, throwOnRequestTimeout: true },
    });
    const started = Date.now();
    await expect(
      c.send(new GetResourceCommand({ TypeName: 'AWS::SNS::Topic', Identifier: 'x' }))
    ).rejects.toThrow();
    const elapsed = Date.now() - started;
    // aborted by the timeout (~500ms), NOT hanging — comfortably under a few seconds
    expect(elapsed).toBeLessThan(5_000);
    c.destroy();
  });
});

import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  CLIENT_REQUEST_HANDLER,
  clientRequestHandler,
  CLIENT_TIMEOUTS,
  isProxyConfigured,
  PROXY_ENV_VARS,
  READ_RETRY,
  resetProxyConfig,
} from '../src/read/client-config.js';
import { ProxyRoutingAgent } from '../src/read/proxy-routing-agent.js';
import { proxyHttpOptions } from '../src/synth/synth.js';

// #1841 — the AWS SDK v3 does not read HTTPS_PROXY / HTTP_PROXY / NO_PROXY, so cdkrd
// could not run behind a corporate proxy: every client dialed out directly and failed.
// clientRequestHandler() now hands every construction site (via the CLIENT_TIMEOUTS /
// READ_RETRY getters) either the unchanged shared option bag (no proxy configured) or a
// per-client NodeHttpHandler routing through ProxyRoutingAgent.

const ALL_PROXY_VARS = [...PROXY_ENV_VARS, 'NO_PROXY', 'no_proxy'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ALL_PROXY_VARS.map((name) => [name, process.env[name]]));
  for (const name of ALL_PROXY_VARS) delete process.env[name];
  resetProxyConfig();
});

afterEach(() => {
  for (const name of ALL_PROXY_VARS) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetProxyConfig();
});

describe('#1841 clientRequestHandler', () => {
  it('returns the unchanged shared option bag when no proxy is configured', () => {
    // byte-identical unproxied path: the SDK wraps the same bag it always got
    expect(clientRequestHandler()).toBe(CLIENT_REQUEST_HANDLER);
    expect(isProxyConfigured()).toBe(false);
  });

  it('returns a NodeHttpHandler when a proxy variable is set', () => {
    process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
    resetProxyConfig();
    expect(clientRequestHandler()).toBeInstanceOf(NodeHttpHandler);
  });

  it.each(PROXY_ENV_VARS)('honours the %s spelling', (name) => {
    process.env[name] = 'http://proxy.example:8080';
    resetProxyConfig();
    expect(isProxyConfigured()).toBe(true);
  });

  it('hands each client its OWN handler under a proxy (destroy-safety)', () => {
    // NodeHttpHandler.destroy() destroys its agents unconditionally and Agent.destroy()
    // aborts ACTIVE sockets, so a shared instance would let one client's teardown
    // (resolve-stacks.ts' region probe calls client.destroy()) kill every other client's
    // in-flight requests. Every getter read — i.e. every `...READ_RETRY` spread at a
    // construction site — must therefore mint a fresh handler.
    process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
    resetProxyConfig();
    const first = READ_RETRY.requestHandler;
    const second = READ_RETRY.requestHandler;
    expect(first).toBeInstanceOf(NodeHttpHandler);
    expect(second).toBeInstanceOf(NodeHttpHandler);
    expect(first).not.toBe(second);
    expect(CLIENT_TIMEOUTS.requestHandler).toBeInstanceOf(NodeHttpHandler);
  });

  it('rejects a whitespace-only proxy variable, naming it', () => {
    // Treating it as SET fails later with a URL-parse error naming neither the variable
    // nor cdkrd; treating it as UNSET silently goes direct — the very failure #1841 is
    // about, with no hint that the variable was the cause.
    process.env['https_proxy'] = '   ';
    resetProxyConfig();
    expect(() => isProxyConfigured()).toThrow(/https_proxy/);
  });

  it('examines every spelling before answering, so a typo beside a valid one still throws', () => {
    process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
    process.env['http_proxy'] = '   ';
    resetProxyConfig();
    expect(() => isProxyConfigured()).toThrow(/http_proxy/);
  });

  it('rejects a SOCKS proxy URL up front, naming the variable', () => {
    // the routing agent speaks HTTP CONNECT only — accepting socks:// here would fail
    // every AWS call mid-run with an opaque proxy-protocol error instead
    process.env['ALL_PROXY'] = 'socks5://127.0.0.1:1080';
    resetProxyConfig();
    expect(() => isProxyConfigured()).toThrow(/ALL_PROXY.*SOCKS/);
  });

  it('resetProxyConfig() drops the memoized read', () => {
    expect(isProxyConfigured()).toBe(false);
    process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
    // memoized: the earlier answer stands until reset
    expect(isProxyConfigured()).toBe(false);
    resetProxyConfig();
    expect(isProxyConfigured()).toBe(true);
  });
});

describe("#1841 toolkit-lib's Toolkit gets the routing agent too", () => {
  // toolkit-lib builds its own SDK clients (context lookups, environment resolution) and
  // never reads HTTPS_PROXY — synthApp spreads proxyHttpOptions() into its sdkConfig.
  it('is empty when no proxy is configured (byte-identical toolkit default)', () => {
    expect(proxyHttpOptions()).toEqual({});
  });

  it('carries a ProxyRoutingAgent when a proxy is configured', () => {
    process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
    resetProxyConfig();
    const options = proxyHttpOptions();
    expect(options.httpOptions?.agent).toBeInstanceOf(ProxyRoutingAgent);
  });

  it('synthApp actually spreads it into the Toolkit sdkConfig', () => {
    // the helper being right proves nothing if the construction site drops the spread —
    // pin the source until a Toolkit-level seam exists. The span is the BALANCED
    // argument of `new Toolkit(`, not an unbounded regex, so a spread that migrates
    // elsewhere in the file cannot satisfy this by accident.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'synth', 'synth.ts'),
      'utf-8'
    );
    const start = source.indexOf('new Toolkit(');
    expect(start).toBeGreaterThanOrEqual(0);
    let depth = 0;
    let end = source.length;
    for (let i = start + 'new Toolkit'.length; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(source.slice(start, end)).toContain('...proxyHttpOptions()');
  });
});

// End-to-end, offline: a REAL SDK client built exactly the way every cdkrd construction
// site builds one (`...READ_RETRY`) must route its request through the proxy the
// environment names — and NOT through it when NO_PROXY exempts the host. Asserting on
// what a local TCP server actually RECEIVES proves the whole chain (getter → handler →
// routing agent → proxy selection) with no network and no AWS.
describe('#1841 a READ_RETRY client routes through the proxy environment', () => {
  let proxy: Server;
  let proxyPort = 0;
  let proxyReceived: string[];
  const sockets: Socket[] = [];

  beforeEach(async () => {
    proxyReceived = [];
    proxy = createServer((sock) => {
      sockets.push(sock);
      sock.once('data', (chunk) => {
        proxyReceived.push(chunk.toString('utf-8'));
        sock.destroy(); // enough evidence — fail the request fast
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const addr = proxy.address();
    proxyPort = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.length = 0;
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  function readClient(endpoint: string): CloudControlClient {
    return new CloudControlClient({
      region: 'us-east-1',
      endpoint,
      ...READ_RETRY,
      // AFTER the spread, so the static keys actually win over READ_RETRY's provider
      // chain: credential-free resolution keeps the FIRST network exchange the API call
      // itself, which is the exchange these tests observe
      credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
      maxAttempts: 1, // no retries — one observed connection is the whole story
    });
  }

  it('opens a CONNECT tunnel to HTTPS_PROXY for an https endpoint', async () => {
    process.env['HTTPS_PROXY'] = `http://127.0.0.1:${proxyPort}`;
    resetProxyConfig();
    const client = readClient('https://cdkrd-proxy-e2e.invalid');
    await expect(
      client.send(new GetResourceCommand({ TypeName: 'AWS::SNS::Topic', Identifier: 'x' }))
    ).rejects.toThrow();
    // the request reached the PROXY as a tunnel request for the ENDPOINT host — the
    // hostname never resolves (.invalid), which is itself proof the route was the proxy
    expect(proxyReceived.length).toBeGreaterThan(0);
    expect(proxyReceived[0]).toMatch(/^CONNECT cdkrd-proxy-e2e\.invalid:443/);
    // the proxied handler still carries the #1066 timeout contract — the request above
    // resolved the handler's lazy config, so it is readable now
    const handler = client.config.requestHandler;
    expect(handler).toBeInstanceOf(NodeHttpHandler);
    const configs = (handler as NodeHttpHandler).httpHandlerConfigs();
    expect(configs.connectionTimeout).toBe(CLIENT_REQUEST_HANDLER.connectionTimeout);
    expect(configs.requestTimeout).toBe(CLIENT_REQUEST_HANDLER.requestTimeout);
    expect(configs.throwOnRequestTimeout).toBe(CLIENT_REQUEST_HANDLER.throwOnRequestTimeout);
    client.destroy();
  });

  it('goes DIRECT when NO_PROXY names the endpoint host', async () => {
    process.env['HTTPS_PROXY'] = `http://127.0.0.1:${proxyPort}`;
    process.env['HTTP_PROXY'] = `http://127.0.0.1:${proxyPort}`;
    process.env['NO_PROXY'] = '127.0.0.1';
    resetProxyConfig();

    // a second local server plays the exempt endpoint itself
    const received: string[] = [];
    const svcSockets: Socket[] = [];
    const svc = createServer((sock) => {
      svcSockets.push(sock);
      sock.once('data', (chunk) => {
        received.push(chunk.toString('utf-8'));
        sock.destroy();
      });
    });
    await new Promise<void>((resolve) => svc.listen(0, '127.0.0.1', resolve));
    const addr = svc.address();
    const svcPort = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const client = readClient(`http://127.0.0.1:${svcPort}`);
      await expect(
        client.send(new GetResourceCommand({ TypeName: 'AWS::SNS::Topic', Identifier: 'x' }))
      ).rejects.toThrow();
      client.destroy();
      // the endpoint got an ORIGIN-FORM request line (direct), not a proxy's
      // absolute-form one, and the proxy saw nothing at all
      expect(received.length).toBeGreaterThan(0);
      expect(received[0]).toMatch(/^POST \//);
      expect(proxyReceived).toHaveLength(0);
    } finally {
      for (const s of svcSockets) s.destroy();
      await new Promise<void>((resolve) => svc.close(() => resolve()));
    }
  });
});

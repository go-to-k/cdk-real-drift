import { Agent as HttpAgent, createServer, get as httpGet } from 'node:http';
import type { ClientRequest } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { Socket } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { ProxyRoutingAgent } from '../src/read/proxy-routing-agent.js';

const PROXY_VARS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(PROXY_VARS.map((name) => [name, process.env[name]]));
  for (const name of PROXY_VARS) delete process.env[name];
});

afterEach(() => {
  for (const name of PROXY_VARS) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const REQ = {} as ClientRequest;

function route(agent: ProxyRoutingAgent, host: string, secure = true, port?: number): HttpAgent {
  return agent.connect(REQ, {
    host,
    port: port ?? (secure ? 443 : 80),
    secureEndpoint: secure,
  } as never);
}

/**
 * Issue #1841.
 *
 * `NodeHttpHandler` picks an agent by PROTOCOL alone and never looks at the
 * host, and `https-proxy-agent` does not read `NO_PROXY`, so a statically
 * chosen proxy agent cannot express a host exemption. Routing per request is
 * the only place the host is known.
 */
describe('ProxyRoutingAgent', () => {
  describe('routing', () => {
    it('returns a plain agent when nothing is configured', () => {
      const agent = new ProxyRoutingAgent();
      const inner = route(agent, 'sts.us-east-1.amazonaws.com');
      expect(inner).toBeInstanceOf(HttpsAgent);
      expect(inner.constructor.name).toBe('Agent');
      agent.destroy();
    });

    it('routes an https request through HTTPS_PROXY', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      const agent = new ProxyRoutingAgent();
      expect(route(agent, 'sts.us-east-1.amazonaws.com').constructor.name).toBe('HttpsProxyAgent');
      agent.destroy();
    });

    it('falls back to ALL_PROXY when the scheme-specific variables are unset', () => {
      // The one PROXY_ENV_VARS entry no other test exercises at ROUTING time —
      // proxy-from-env's fallback line, not just the presence check.
      process.env['ALL_PROXY'] = 'http://fallback.example:8080';
      const agent = new ProxyRoutingAgent();
      expect(route(agent, 'sts.us-east-1.amazonaws.com').constructor.name).toBe('HttpsProxyAgent');
      agent.destroy();
    });

    it('routes an http request through HTTP_PROXY, not HTTPS_PROXY', () => {
      // The bug a `HTTPS_PROXY || HTTP_PROXY` fallback chain produces: with
      // only HTTPS_PROXY set, plain-http traffic must NOT be sent to it.
      process.env['HTTPS_PROXY'] = 'http://secure-only.example:8080';
      const agent = new ProxyRoutingAgent();
      const inner = route(agent, 'example.internal', false);
      expect(inner).toBeInstanceOf(HttpAgent);
      expect(inner.constructor.name).toBe('Agent');
      agent.destroy();
    });

    it('honours NO_PROXY, which is the whole reason for routing per request', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      process.env['NO_PROXY'] = 'vpce.internal';
      const agent = new ProxyRoutingAgent();
      expect(route(agent, 'vpce.internal').constructor.name).toBe('Agent');
      expect(route(agent, 'sts.us-east-1.amazonaws.com').constructor.name).toBe('HttpsProxyAgent');
      agent.destroy();
    });

    it('matches a NO_PROXY entry EXACTLY unless it starts with `.` or `*`', () => {
      // Documented in README.md, and different from curl. Getting this wrong
      // produces a config that silently proxies what the user believed was
      // exempt.
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      process.env['NO_PROXY'] = 'example.com';
      const agent = new ProxyRoutingAgent();
      expect(route(agent, 'example.com').constructor.name).toBe('Agent');
      expect(route(agent, 'api.example.com').constructor.name).toBe('HttpsProxyAgent');
      agent.destroy();

      process.env['NO_PROXY'] = '.example.com';
      const suffix = new ProxyRoutingAgent();
      expect(route(suffix, 'api.example.com').constructor.name).toBe('Agent');
      // `.example.com` does NOT cover the apex — covering both takes two entries.
      expect(route(suffix, 'example.com').constructor.name).toBe('HttpsProxyAgent');
      suffix.destroy();
    });

    it('silently ignores a CIDR NO_PROXY entry, so IPs must be listed literally', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      process.env['NO_PROXY'] = '10.0.0.0/8';
      const cidr = new ProxyRoutingAgent();
      expect(route(cidr, '10.1.2.3').constructor.name).toBe('HttpsProxyAgent');
      cidr.destroy();

      process.env['NO_PROXY'] = '10.1.2.3';
      const literal = new ProxyRoutingAgent();
      expect(route(literal, '10.1.2.3').constructor.name).toBe('Agent');
      literal.destroy();
    });
  });

  describe('inner agents', () => {
    it('carries keepAlive and maxSockets, which the SDK does not apply to an instance', () => {
      // `NodeHttpHandler` sets those defaults only on a plain option bag and
      // passes an external Agent through untouched, so omitting them here would
      // renegotiate TLS per request on a concurrent `check`.
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      const agent = new ProxyRoutingAgent();
      const inner = route(agent, 'sts.us-east-1.amazonaws.com') as HttpAgent & {
        keepAlive?: boolean;
        maxSockets?: number;
      };
      expect(inner.keepAlive).toBe(true);
      expect(inner.maxSockets).toBe(50);
      agent.destroy();
    });

    it('reuses one inner agent per route, so sockets actually pool', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      const agent = new ProxyRoutingAgent();
      expect(route(agent, 'a.amazonaws.com')).toBe(route(agent, 'b.amazonaws.com'));
      agent.destroy();
    });

    it('keeps separate inner agents per scheme', () => {
      process.env['HTTPS_PROXY'] = 'http://secure.example:8080';
      process.env['HTTP_PROXY'] = 'http://plain.example:8080';
      const agent = new ProxyRoutingAgent();
      expect(route(agent, 'x.amazonaws.com', true)).not.toBe(route(agent, 'x.internal', false));
      agent.destroy();
    });

    it('does NOT share inner agents between instances', () => {
      // The correctness property, not an optimisation: Node's `Agent.destroy()`
      // walks `[freeSockets, sockets]` and the second is the ACTIVE set, and
      // `NodeHttpHandler.destroy()` forwards unconditionally. A module-global
      // cache would let one client's teardown abort another client's in-flight
      // request — and cdkrd calls `client.destroy()` (resolve-stacks.ts).
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      const first = new ProxyRoutingAgent();
      const second = new ProxyRoutingAgent();
      expect(route(first, 'sts.us-east-1.amazonaws.com')).not.toBe(
        route(second, 'sts.us-east-1.amazonaws.com')
      );
      first.destroy();
      second.destroy();
    });

    it('a destroy on one instance leaves another instance usable', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      const first = new ProxyRoutingAgent();
      const second = new ProxyRoutingAgent();
      const survivor = route(second, 'sts.us-east-1.amazonaws.com');
      route(first, 'sts.us-east-1.amazonaws.com');
      first.destroy();
      expect(route(second, 'sts.us-east-1.amazonaws.com')).toBe(survivor);
      second.destroy();
    });

    it('the OUTER agent advertises keepAlive too — ClientRequest consults IT for the Connection header', () => {
      // Node's ClientRequest stamps `Connection: close` when the agent handed to the
      // REQUEST (the outer one) has neither keepAlive nor a finite maxSockets, and the
      // response teardown then destroys the socket before the inner pool ever keeps
      // it. The inner keepAlive alone is NOT enough — measured as one CONNECT tunnel
      // per request until the constructor passed keepAlive up as well.
      const agent = new ProxyRoutingAgent() as ProxyRoutingAgent & { keepAlive?: boolean };
      expect(agent.keepAlive).toBe(true);
      agent.destroy();
    });

    it('reuses ONE proxy connection across sequential requests', async () => {
      // The behavioral half of the assertion above: a local plain-HTTP "proxy" counts
      // its inbound connections; two sequential proxied GETs must share one. Without
      // the outer keepAlive this measures TWO (Connection: close per request).
      const connections: Socket[] = [];
      const server = createServer((_req, res) => {
        res.end('ok');
      });
      server.on('connection', (sock) => connections.push(sock));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      process.env['HTTP_PROXY'] = `http://127.0.0.1:${port}`;

      const agent = new ProxyRoutingAgent();
      const getOnce = (): Promise<void> =>
        new Promise((resolve, reject) => {
          const req = httpGet('http://cdkrd-keepalive.invalid/', { agent }, (res) => {
            res.resume();
            res.on('end', resolve);
            res.on('error', reject);
          });
          req.on('error', reject);
        });
      try {
        await getOnce();
        // one macrotask so the agent's free-socket bookkeeping settles before reuse
        await new Promise((resolve) => setTimeout(resolve, 10));
        await getOnce();
        expect(connections).toHaveLength(1);
      } finally {
        agent.destroy();
        for (const sock of connections) sock.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('forwards destroy() to the inner agents', () => {
      // Without the forwarding, tunneled sockets outlive the client that opened
      // them and keep the process alive.
      process.env['HTTPS_PROXY'] = 'http://proxy.example:8080';
      const agent = new ProxyRoutingAgent();
      const inner = route(agent, 'sts.us-east-1.amazonaws.com');
      let destroyed = false;
      const original = inner.destroy.bind(inner);
      inner.destroy = (): void => {
        destroyed = true;
        original();
      };
      agent.destroy();
      expect(destroyed).toBe(true);
    });
  });
});

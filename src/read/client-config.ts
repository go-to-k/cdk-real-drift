// Shared AWS SDK client retry config for cdkrd's READ path — applied to EVERY
// read-side client: the Cloud Control / CloudFormation clients in gather.ts, all
// SDK-override clients in overrides.ts, AND the KMS client in kms-aliases.ts.
// `check` reads every resource in a stack with bounded concurrency (gather.ts POOL_SIZE), which on a
// large stack (hundreds of resources) drives Cloud Control GetResource /
// CloudFormation describe-type / the SDK-override APIs straight into
// ThrottlingException. The SDK default (`standard` mode, maxAttempts=3) is not
// enough headroom, so a throttled read was being reported as `skipped` — silent
// coverage loss + noise. `adaptive` mode adds a client-side rate limiter (it backs
// off the whole client when it sees throttling) and a higher attempt budget rides
// out transient throttles. Reads are idempotent, so retrying is always safe.
// Connection + per-request timeouts for EVERY cdkrd AWS client (#1066). Without them the
// AWS SDK v3 default handler waits INDEFINITELY: a stalled TCP connect (a blackholed
// endpoint, a security-group/NACL drop, a hung proxy) or a connected-but-silent server
// hangs `check`/`record`/`revert` FOREVER — in CI the job only dies at the runner's global
// timeout. `connectionTimeout` bounds establishing the socket; `requestTimeout` bounds a
// single attempt end to end (generous so a legitimately slow API call is never cut, but a
// silent server can no longer hang a whole attempt). Passed as the NodeHttpHandler options
// object, which every AWS v3 client accepts and wraps. Applied to the READ clients via
// READ_RETRY below and spread directly into the revert WRITE clients (which must NOT inherit
// the read-path adaptive retry — a write is not idempotent).
import {
  createCredentialChain,
  fromEnv,
  fromNodeProviderChain,
} from '@aws-sdk/credential-providers';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { ProxyRoutingAgent } from './proxy-routing-agent.js';

// #954: align the raw SDK clients' credential precedence with toolkit-lib / the AWS CLI.
//
// The split-brain: when BOTH static env credentials (AWS_ACCESS_KEY_ID +
// AWS_SECRET_ACCESS_KEY) AND AWS_PROFILE are set — and no explicit `--profile` — the two
// SDK stacks inside one cdkrd process pick OPPOSITE identities. toolkit-lib (synth /
// discovery / context) prepends `fromEnv()` to its chain (`shouldPrioritizeEnv()` in
// awscli-compatible.ts), so the ENV creds win over AWS_PROFILE. But the raw AWS SDK v3
// default provider does the reverse: when `AWS_PROFILE` is set it SKIPS `fromEnv` and uses
// the PROFILE creds. Result: discovery under account A, every live read / baseline / revert
// write under account B — silent cross-account divergence.
//
// Fix: give every raw client the SAME chain toolkit-lib uses. `shouldPrioritizeEnv()` below
// is a faithful port of toolkit-lib's function (same env vars + AMAZON_* backward-compat
// aliases). When env creds + AWS_PROFILE are both present, the chain is
// `createCredentialChain(fromEnv(), fromNodeProviderChain())` so ENV wins — exactly the
// toolkit-lib branch. Otherwise the chain is a plain `fromNodeProviderChain()`, which is
// the SDK's own default behavior, so single-source (env-only or profile-only) is unchanged.
//
// EXPLICIT `--profile`: toolkit-lib uses `fromIni({ profile })` EXCLUSIVELY (env does NOT
// win). `parseCommonArgs` (cli-args.ts) sets `CDKRD_EXPLICIT_PROFILE=1` when `--profile` is
// present, and the verb entry points export the resolved profile as `process.env.AWS_PROFILE`.
// We honor that marker by NOT prioritizing env in the explicit-profile case, so
// `fromNodeProviderChain` resolves the profile — matching toolkit-lib (both halves pick the
// profile, never env).
//
// The provider is a LAZY function: the SDK calls it at first-request time, AFTER the verb
// entry point has exported AWS_PROFILE / CDKRD_EXPLICIT_PROFILE, so the decision reads the
// final environment (not the module-load snapshot).

/** Port of toolkit-lib awscli-compatible `shouldPrioritizeEnv()` (env creds win over profile). */
export function shouldPrioritizeEnv(): boolean {
  // An explicit `--profile` means `fromIni(profile)` exclusively in toolkit-lib — env must
  // NOT win. The verb entry points mark this so both SDK stacks agree on the profile.
  if (process.env.CDKRD_EXPLICIT_PROFILE) return false;
  const id = process.env.AWS_ACCESS_KEY_ID || process.env.AMAZON_ACCESS_KEY_ID;
  const key = process.env.AWS_SECRET_ACCESS_KEY || process.env.AMAZON_SECRET_ACCESS_KEY;
  return !!id && !!key;
}

// The single #1066 requestHandler config, shared by BOTH the wired service clients (via
// CLIENT_TIMEOUTS below) AND the inner STS / SSO / SSO-OIDC clients the credential provider
// chain spawns (via CLIENT_CREDENTIALS' clientConfig). Declared BEFORE CLIENT_CREDENTIALS so
// that provider can reference it — one source of truth for the connection + request timeouts.
export const CLIENT_REQUEST_HANDLER = {
  connectionTimeout: 6_000, // 6s to establish the TCP connection (aborts the connect attempt)
  requestTimeout: 60_000, // 60s for a single request attempt (retries add their own budget)
  // REQUIRED to make requestTimeout actually ABORT a connected-but-silent server:
  // @smithy/node-http-handler's requestTimeout otherwise only logs a warning and keeps
  // waiting (backward-compat default), so the hang would persist. With this it rejects.
  throwOnRequestTimeout: true,
};

// #1841: honor HTTPS_PROXY / HTTP_PROXY / NO_PROXY. The AWS SDK for JavaScript v3 does NOT
// read the proxy variables the way botocore (the AWS CLI) and Go's net/http do — its guide
// says a proxy is supplied "through a third-party HTTP agent" by whoever constructs the
// client — so on a machine whose only egress is a corporate proxy every cdkrd AWS call
// dialed out directly and failed (typically as a certificate error naming the network's
// TLS interceptor, not the proxy). Node's own NODE_USE_ENV_PROXY=1 is not a way out: it
// rewires the GLOBAL agent, and every SDK client builds its own.
//
// The variables proxy-from-env consults (its getEnv reads the LOWERCASE spelling first;
// the guard below deliberately examines BOTH spellings, so a typo'd value is reported even
// when a valid other-case twin would shadow it at routing time — fail closed, with the
// variable's name, rather than half-working per request). Only their PRESENCE is decided
// here. Which one applies to a given request — and whether NO_PROXY exempts it — is
// getProxyForUrl's job, per request, inside ProxyRoutingAgent. Deciding it here instead
// would collapse HTTP_PROXY and HTTPS_PROXY into one answer and send http:// traffic to
// an HTTPS proxy.
export const PROXY_ENV_VARS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

let proxyConfigured: boolean | undefined;

/** Whether any proxy environment variable is set (memoized parse; see resetProxyConfig). */
export function isProxyConfigured(): boolean {
  // Read lazily and memoize only the PARSE RESULT, so module import order cannot freeze
  // an answer at load time, and so a test can control the environment via resetProxyConfig.
  if (proxyConfigured === undefined) {
    // Every spelling is examined before the answer is decided. A `.some()` here would
    // short-circuit at the first VALID variable, so `HTTPS_PROXY=http://ok` beside a
    // typo'd `http_proxy='   '` would never reach the guard below — and the typo then
    // resurfaces per request as exactly the unnamed URL-parse error the guard pre-empts.
    let configured = false;
    for (const name of PROXY_ENV_VARS) {
      const value = process.env[name];
      if (value === undefined || value === '') continue;
      if (value.trim() === '') {
        // Whitespace-only is a typo, not a configuration. Treating it as SET fails later
        // with a URL-parse error naming neither the variable nor cdkrd; treating it as
        // UNSET is worse still, because the run then goes direct and fails with the
        // certificate error this whole mechanism exists to remove — with no hint that
        // the variable was the cause.
        throw new Error(
          `${name} is set to whitespace only. Set it to a proxy URL ` +
            `(e.g. http://proxy.example:8080) or unset it.`
        );
      }
      if (/^socks/i.test(value.trim())) {
        // SOCKS is not supported: the routing agent speaks HTTP CONNECT only, so a
        // socks:// value would be accepted here and then fail every AWS call mid-run
        // with an opaque proxy-protocol error naming neither the variable nor cdkrd.
        // Same philosophy as the whitespace guard: name the variable, fail up front.
        throw new Error(
          `${name} names a SOCKS proxy, which cdkrd does not support (HTTP(S) proxies ` +
            `only). Use an http:// or https:// proxy URL, or unset ${name}.`
        );
      }
      if (!value.includes('://')) {
        // A scheme-less value (`proxy.example:8080` — curl treats it as http://) is NOT
        // normalized by proxy-from-env: it prepends the REQUEST's scheme, so an https
        // request turns it into `https://proxy.example:8080` and HttpsProxyAgent then
        // opens a TLS handshake to a plaintext proxy port — failing mid-run with a
        // `wrong version number` error naming neither the variable nor cdkrd. Same
        // philosophy as the guards beside it: name the variable, fail up front.
        throw new Error(
          `${name} has no scheme. Set it to a full proxy URL ` +
            `(e.g. http://proxy.example:8080) or unset ${name}.`
        );
      }
      configured = true;
    }
    proxyConfigured = configured;
  }
  return proxyConfigured;
}

/** Drop the memoized proxy-environment read. Test seam. */
export function resetProxyConfig(): void {
  proxyConfigured = undefined;
}

// The requestHandler value every client construction reads (via the CLIENT_TIMEOUTS /
// READ_RETRY getters below and CLIENT_CREDENTIALS' clientConfig).
//
// - No proxy configured: the plain CLIENT_REQUEST_HANDLER option bag, byte-identical to
//   the pre-#1841 path — the SDK wraps it in its own NodeHttpHandler with its own
//   keepAlive agent, so existing users see zero change.
// - Proxy configured: a NodeHttpHandler carrying the SAME #1066 timeout contract plus a
//   ProxyRoutingAgent for both schemes. A FRESH handler + agent per call (i.e. per client
//   construction): NodeHttpHandler.destroy() destroys httpAgent and httpsAgent
//   unconditionally, and Node's Agent.destroy() aborts ACTIVE sockets, so one shared
//   instance would let a single client's teardown (`client.destroy()`, which
//   resolve-stacks.ts' region probe already calls) kill every other client's in-flight
//   requests. See proxy-routing-agent.ts.
export function clientRequestHandler(): typeof CLIENT_REQUEST_HANDLER | NodeHttpHandler {
  if (!isProxyConfigured()) return CLIENT_REQUEST_HANDLER;
  const agent = new ProxyRoutingAgent();
  return new NodeHttpHandler({
    ...CLIENT_REQUEST_HANDLER,
    httpAgent: agent,
    httpsAgent: agent,
  });
}

// The shared credential provider spread into EVERY raw SDK client (via CLIENT_TIMEOUTS /
// READ_RETRY). A single function reference is reused across all clients; it decides env-vs-
// profile precedence lazily on each resolution (see shouldPrioritizeEnv).
//
// #1319: pass CLIENT_REQUEST_HANDLER through `clientConfig` to fromNodeProviderChain. Without
// it the inner STS / SSO / SSO-OIDC clients the provider chain spawns (standard role-assuming
// / SSO org setups) would use SDK DEFAULTS — no request timeout — bypassing the #1066
// contract. A stalled STS endpoint would then hang check/record/revert FOREVER, BEFORE any
// wired client's own timeout could even start (credential resolution runs first). The
// clientConfig propagates the same requestHandler to those inner clients, so they abort too.
//
// #1841: the clientConfig requestHandler is clientRequestHandler(), not the bare bag, so
// under a proxy the inner STS / SSO / SSO-OIDC clients route through it too. That is not
// optional: STS reads the handler off parentClientConfig (it would inherit), but the SSO
// portal client and the SSO-OIDC refresh build from clientConfig ALONE, so an SSO profile
// would otherwise fail at resolveSSOCredentials — before any service call. IMDS and ECS
// container credentials call node:http / build their own handler; they are link-local /
// in-VPC and correctly bypass a proxy, so they need no casing. Evaluated per invocation
// (this is already a lazy provider — see above), so the handler is fresh per resolution.
export const CLIENT_CREDENTIALS = (awsIdentityProperties?: Record<string, unknown>) => {
  const requestHandler = clientRequestHandler();
  return (
    shouldPrioritizeEnv()
      ? createCredentialChain(
          fromEnv(),
          fromNodeProviderChain({ clientConfig: { requestHandler } })
        )
      : fromNodeProviderChain({ clientConfig: { requestHandler } })
  )(awsIdentityProperties);
};

// `requestHandler` is a GETTER on both bags, so every `...CLIENT_TIMEOUTS` /
// `...READ_RETRY` spread at a client construction site re-evaluates
// clientRequestHandler() — unproxied it returns the same shared CLIENT_REQUEST_HANDLER
// bag as before (zero change), proxied it hands each client its OWN handler + routing
// agent (the destroy-safety reason above). READ_RETRY repeats the getter instead of
// spreading CLIENT_TIMEOUTS because a spread HERE would evaluate the getter once at
// module load and freeze a single shared handler into every read client.
export const CLIENT_TIMEOUTS = {
  credentials: CLIENT_CREDENTIALS,
  get requestHandler() {
    return clientRequestHandler();
  },
};

export const READ_RETRY = {
  maxAttempts: 10,
  retryMode: 'adaptive' as const,
  credentials: CLIENT_CREDENTIALS,
  get requestHandler() {
    return clientRequestHandler();
  },
};

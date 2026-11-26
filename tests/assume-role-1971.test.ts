// #1971 — `--assume-role <arn>`: a CI identity whose only permission is sts:AssumeRole
// could not run cdkrd at all, because every client read with the ambient credentials.
//
// These tests pin (1) the flag / $CDKRD_ASSUME_ROLE parse and the ARN-template validation,
// and (2) END TO END against a local HTTP server standing in for STS / CloudFormation /
// KMS, which identity SIGNED each request (the access key id in the SigV4 Authorization
// header): inside a stack's role scope a stock client built from the shared config is
// signed with the ASSUMED key; sts:AssumeRole itself is signed with the AMBIENT key — also
// when it is first called while a PREVIOUS stack's scope is still entered; one AssumeRole
// serves every client of an ARN; a denied role fails closed with the ARN in the message;
// and a cache that outlives a stack does not hand stack 2 stack 1's account.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { AssumeRoleError, isStackNotDeployed } from '../src/aws-errors.js';
import { parseCommonArgs, type Verb } from '../src/cli-args.js';
import { resolveCallerAccount } from '../src/commands/account-gate.js';
import { enterRoleScope, resetAssumeRoleState, stackRoleScope } from '../src/read/assume-role.js';
import { resolveAssumeRoleArn, validateAssumeRoleTemplate } from '../src/read/assume-role-arn.js';
import {
  CLIENT_CREDENTIALS,
  CLIENT_TIMEOUTS,
  credentialScopeKey,
  PROXY_ENV_VARS,
  READ_RETRY,
  resetProxyConfig,
} from '../src/read/client-config.js';
import { fetchManagedAliasTargets } from '../src/read/kms-aliases.js';

const ROLE = 'arn:aws:iam::{account}:role/cdkrd-read-{region}';

describe('#1971 --assume-role parse', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.CDKRD_ASSUME_ROLE;
    delete process.env.CDKRD_ASSUME_ROLE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CDKRD_ASSUME_ROLE;
    else process.env.CDKRD_ASSUME_ROLE = saved;
  });

  it('reads the flag in both spellings, and is accepted by every verb', () => {
    for (const verb of ['check', 'record', 'ignore', 'revert'] as Verb[]) {
      expect(parseCommonArgs(['--assume-role', ROLE], verb).assumeRole).toBe(ROLE);
      expect(parseCommonArgs([`--assume-role=${ROLE}`, 'S'], verb).assumeRole).toBe(ROLE);
    }
    // the value is consumed, never taken as a stack name
    expect(parseCommonArgs(['--assume-role', ROLE, 'S'], 'check').stackNames).toEqual(['S']);
  });

  it('falls back to $CDKRD_ASSUME_ROLE; the flag wins; an EMPTY variable is unset', () => {
    expect(parseCommonArgs([], 'check').assumeRole).toBeUndefined();
    process.env.CDKRD_ASSUME_ROLE = 'arn:aws:iam::123456789012:role/FromEnv';
    expect(parseCommonArgs([], 'check').assumeRole).toBe('arn:aws:iam::123456789012:role/FromEnv');
    expect(parseCommonArgs(['--assume-role', ROLE], 'check').assumeRole).toBe(ROLE);
    process.env.CDKRD_ASSUME_ROLE = '';
    expect(parseCommonArgs([], 'check').assumeRole).toBeUndefined();
  });

  it('rejects a missing value, a non-role ARN, and an unknown placeholder — env value too', () => {
    expect(() => parseCommonArgs(['--assume-role'], 'check')).toThrow(/requires a value/);
    expect(() => parseCommonArgs(['--assume-role='], 'check')).toThrow(/requires a value/);
    expect(() => parseCommonArgs(['--assume-role', 'lookup'], 'check')).toThrow(
      /not an IAM role ARN/
    );
    expect(() =>
      parseCommonArgs(['--assume-role', 'arn:aws:iam::123456789012:user/ci'], 'check')
    ).toThrow(/not an IAM role ARN/);
    expect(() =>
      parseCommonArgs(['--assume-role', 'arn:aws:iam::{Account}:role/R'], 'check')
    ).toThrow(/unknown placeholder "\{Account\}"/);
    process.env.CDKRD_ASSUME_ROLE = 'arn:aws:iam::{acct}:role/R';
    expect(() => parseCommonArgs([], 'check')).toThrow(/unknown placeholder "\{acct\}"/);
  });
});

describe('#1971 ARN template', () => {
  it('fills {account} and {region} (every occurrence) and leaves a literal ARN alone', () => {
    expect(resolveAssumeRoleArn(ROLE, '222222222222', 'eu-west-1')).toBe(
      'arn:aws:iam::222222222222:role/cdkrd-read-eu-west-1'
    );
    expect(
      resolveAssumeRoleArn(
        'arn:aws:iam::{account}:role/cdk-hnb659fds-lookup-role-{account}-{region}',
        '1'.repeat(12),
        'us-east-1'
      )
    ).toBe('arn:aws:iam::111111111111:role/cdk-hnb659fds-lookup-role-111111111111-us-east-1');
    expect(resolveAssumeRoleArn('arn:aws:iam::123456789012:role/R', '9'.repeat(12), 'x')).toBe(
      'arn:aws:iam::123456789012:role/R'
    );
  });

  it('accepts other partitions and role paths', () => {
    expect(() => validateAssumeRoleTemplate('arn:aws-cn:iam::{account}:role/a/b/R')).not.toThrow();
    expect(() =>
      validateAssumeRoleTemplate('arn:aws-us-gov:iam::123456789012:role/R+=,.@-')
    ).not.toThrow();
  });
});

describe('#1971 every client shares the one scoped provider', () => {
  it('READ_RETRY and CLIENT_TIMEOUTS both carry CLIENT_CREDENTIALS', () => {
    // tests/client-proxy-conformance-1841.test.ts proves every client under src/ spreads one
    // of these two bags; this is the other half — the bag's credentials IS the scoped one.
    expect(READ_RETRY.credentials).toBe(CLIENT_CREDENTIALS);
    expect(CLIENT_TIMEOUTS.credentials).toBe(CLIENT_CREDENTIALS);
  });
});

// ---- end to end against a local stand-in for STS / CloudFormation / KMS ----

const AMBIENT_KEY = 'AKIAAMBIENT0000000000';
const AMBIENT_ACCOUNT = '111111111111';
const assumedKey = (account: string): string => `ASIA${account}XXXX`;

interface Seen {
  service: string; // from the SigV4 credential scope
  action: string;
  keyId: string;
  body: string;
}

function keyIdOf(req: IncomingMessage): { keyId: string; service: string } {
  const m = /Credential=([^/]+)\/[^/]+\/[^/]+\/([^/]+)\//.exec(req.headers.authorization ?? '');
  return { keyId: m?.[1] ?? '', service: m?.[2] ?? '' };
}

describe('#1971 end to end: which identity signs each request', () => {
  let server: Server;
  let seen: Seen[] = [];
  const denied = new Set<string>();
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_DEFAULT_PROFILE',
    'CDKRD_EXPLICIT_PROFILE',
    'AWS_ROLE_ARN',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ENDPOINT_URL',
    'AWS_ENDPOINT_URL_STS',
    'AWS_ENDPOINT_URL_CLOUDFORMATION',
    'AWS_ENDPOINT_URL_KMS',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_EC2_METADATA_DISABLED',
    ...PROXY_ENV_VARS,
  ];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const { keyId, service } = keyIdOf(req);
        const target = req.headers['x-amz-target'];
        const action =
          typeof target === 'string'
            ? (target.split('.').pop() ?? '')
            : (new URLSearchParams(body).get('Action') ?? '');
        seen.push({ service, action, keyId, body });
        const params = new URLSearchParams(body);
        if (action === 'AssumeRole') {
          const arn = params.get('RoleArn') ?? '';
          if (denied.has(arn)) {
            res.writeHead(403, { 'content-type': 'text/xml' });
            res.end(
              `<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>User: arn:aws:iam::${AMBIENT_ACCOUNT}:user/ci is not authorized to perform: sts:AssumeRole on resource: ${arn}</Message></Error><RequestId>r</RequestId></ErrorResponse>`
            );
            return;
          }
          const account = /iam::(\d{12}):/.exec(arn)?.[1] ?? '000000000000';
          res.writeHead(200, { 'content-type': 'text/xml' });
          res.end(
            `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>${assumedKey(account)}</AccessKeyId><SecretAccessKey>s</SecretAccessKey><SessionToken>t</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials><AssumedRoleUser><Arn>${arn}</Arn><AssumedRoleId>AROA:x</AssumedRoleId></AssumedRoleUser></AssumeRoleResult><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></AssumeRoleResponse>`
          );
          return;
        }
        if (action === 'GetCallerIdentity') {
          const account = keyId === AMBIENT_KEY ? AMBIENT_ACCOUNT : keyId.slice(4, 16);
          res.writeHead(200, { 'content-type': 'text/xml' });
          res.end(
            `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:sts::${account}:x</Arn><UserId>u</UserId><Account>${account}</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></GetCallerIdentityResponse>`
          );
          return;
        }
        if (action === 'DescribeStacks') {
          res.writeHead(200, { 'content-type': 'text/xml' });
          res.end(
            `<DescribeStacksResponse xmlns="http://cloudformation.amazonaws.com/doc/2010-05-15/"><DescribeStacksResult><Stacks/></DescribeStacksResult><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></DescribeStacksResponse>`
          );
          return;
        }
        if (action === 'ListAliases') {
          res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
          res.end(JSON.stringify({ Aliases: [], Truncated: false }));
          return;
        }
        res.writeHead(400);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}`;
    process.env.AWS_ACCESS_KEY_ID = AMBIENT_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = 'ambient-secret';
    process.env.AWS_ENDPOINT_URL_STS = url;
    process.env.AWS_ENDPOINT_URL_CLOUDFORMATION = url;
    process.env.AWS_ENDPOINT_URL_KMS = url;
    process.env.AWS_EC2_METADATA_DISABLED = 'true';
    resetProxyConfig();
    resetAssumeRoleState();
    seen = [];
    denied.clear();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetProxyConfig();
    resetAssumeRoleState();
  });

  const describeStacks = (region: string) =>
    new CloudFormationClient({ region, ...READ_RETRY }).send(new DescribeStacksCommand({}));

  it('control: without --assume-role, no scope is entered and the ambient key signs', async () => {
    const scope = await stackRoleScope(
      undefined,
      { account: '222222222222', region: 'us-east-1' },
      'check'
    );
    expect(scope).toBeUndefined();
    await (async () => {
      enterRoleScope(scope);
      expect(credentialScopeKey()).toBe('');
      await describeStacks('us-east-1');
    })();
    expect(seen.map((s) => [s.action, s.keyId])).toEqual([['DescribeStacks', AMBIENT_KEY]]);
  });

  it('inside a stack scope a stock client is signed with the ASSUMED key; AssumeRole with the AMBIENT one', async () => {
    await (async () => {
      enterRoleScope(
        await stackRoleScope(ROLE, { account: '222222222222', region: 'eu-west-1' }, 'record')
      );
      expect(credentialScopeKey()).toBe('arn:aws:iam::222222222222:role/cdkrd-read-eu-west-1');
      await describeStacks('eu-west-1');
      // nested async work started inside the scope inherits it
      await Promise.all([describeStacks('eu-west-1'), describeStacks('us-east-1')]);
    })();
    const assume = seen.filter((s) => s.action === 'AssumeRole');
    expect(assume).toHaveLength(1); // ONE AssumeRole for the ARN, not one per client
    expect(assume[0]!.keyId).toBe(AMBIENT_KEY);
    const p = new URLSearchParams(assume[0]!.body);
    expect(p.get('RoleArn')).toBe('arn:aws:iam::222222222222:role/cdkrd-read-eu-west-1');
    expect(p.get('RoleSessionName')).toBe('cdkrd-record');
    const reads = seen.filter((s) => s.action === 'DescribeStacks');
    expect(reads).toHaveLength(3);
    for (const r of reads) expect(r.keyId).toBe(assumedKey('222222222222'));
  });

  it('a stack loop: each stack runs as ITS account; stack 2 assumes with the AMBIENT key, not stack 1 role', async () => {
    const callers: (string | undefined)[] = [];
    await (async () => {
      for (const account of ['222222222222', '333333333333', '222222222222']) {
        try {
          enterRoleScope(await stackRoleScope(ROLE, { account, region: 'us-east-1' }, 'check'));
          await describeStacks('us-east-1');
          callers.push(await resolveCallerAccount('us-east-1'));
        } catch {
          // not reached
        }
      }
    })();
    const assume = seen.filter((s) => s.action === 'AssumeRole');
    // two distinct ARNs → two AssumeRoles (the third stack reuses the first ARN session),
    // BOTH signed by the ambient identity — the second one runs while stack 1's scope is
    // still entered, so a source chain of CLIENT_CREDENTIALS would sign it with stack 1's role.
    expect(assume.map((s) => s.keyId)).toEqual([AMBIENT_KEY, AMBIENT_KEY]);
    expect(seen.filter((s) => s.action === 'DescribeStacks').map((s) => s.keyId)).toEqual([
      assumedKey('222222222222'),
      assumedKey('333333333333'),
      assumedKey('222222222222'),
    ]);
    // the account gate's caller identity is the ROLE's account, per stack
    expect(callers).toEqual(['222222222222', '333333333333', '222222222222']);
  });

  it('{account} on an env-agnostic stack is the AMBIENT account, resolved with the ambient key even inside a prior scope', async () => {
    await (async () => {
      enterRoleScope(
        await stackRoleScope(ROLE, { account: '222222222222', region: 'us-east-1' }, 'check')
      );
      enterRoleScope(
        await stackRoleScope(ROLE, { account: undefined, region: 'us-east-1' }, 'check')
      );
      expect(credentialScopeKey()).toBe(
        `arn:aws:iam::${AMBIENT_ACCOUNT}:role/cdkrd-read-us-east-1`
      );
      await describeStacks('us-east-1');
    })();
    const gci = seen.filter((s) => s.action === 'GetCallerIdentity');
    expect(gci.map((s) => s.keyId)).toEqual([AMBIENT_KEY]);
    expect(seen.at(-1)!.keyId).toBe(assumedKey(AMBIENT_ACCOUNT));
  });

  it('a denied role fails the stack with the ARN in the message, and FAILS CLOSED (never the ambient key)', async () => {
    denied.add('arn:aws:iam::444444444444:role/cdkrd-read-us-east-1');
    let thrown: unknown;
    await (async () => {
      try {
        enterRoleScope(
          await stackRoleScope(ROLE, { account: '444444444444', region: 'us-east-1' }, 'revert')
        );
      } catch (e) {
        thrown = e;
      }
      // anything that still reaches for credentials in this stack gets the same error
      await expect(describeStacks('us-east-1')).rejects.toThrow(/cannot assume role/);
    })();
    expect(thrown).toBeInstanceOf(AssumeRoleError);
    const msg = (thrown as Error).message;
    expect(msg).toContain('cannot assume role arn:aws:iam::444444444444:role/cdkrd-read-us-east-1');
    expect(msg).toContain('--assume-role');
    expect(msg).toContain('trust policy');
    // a verb's catch must not mistake it for "not deployed yet — skipped"
    expect(isStackNotDeployed(thrown)).toBe(false);
    // ...even when the STS text happens to match that classifier's patterns (a role
    // named after a stack, an STS ValidationError)
    expect(
      isStackNotDeployed(
        new AssumeRoleError(
          'cannot assume role arn:aws:iam::1:role/stack-reader (--assume-role): ValidationError: role does not exist'
        )
      )
    ).toBe(false);
    expect(seen.filter((s) => s.action === 'DescribeStacks')).toEqual([]);
  });

  it('a per-region account cache is keyed by scope: two accounts in ONE region each get their own read', async () => {
    await (async () => {
      for (const account of ['222222222222', '333333333333']) {
        enterRoleScope(await stackRoleScope(ROLE, { account, region: 'ap-northeast-1' }, 'check'));
        await fetchManagedAliasTargets('ap-northeast-1');
      }
    })();
    expect(seen.filter((s) => s.action === 'ListAliases').map((s) => s.keyId)).toEqual([
      assumedKey('222222222222'),
      assumedKey('333333333333'),
    ]);
  });
});

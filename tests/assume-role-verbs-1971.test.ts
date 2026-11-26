// #1971 — every verb enters the per-stack `--assume-role` scope BEFORE the stack's first
// AWS call, passes its own verb (the cdkrd-<verb> session name) and the stack's synthesized
// account / region, and resolves the account gate's caller identity PER SCOPE (one role
// per account means one caller per account — a per-run answer would skip stack 2 as a
// cross-account mismatch).
//
// Harness: the check-strict-wholestack-948 / account-gate-1309 shape — synth discovery and
// the gather mocked, the REAL parseCommonArgs / resolveStacks / verb loop. `stackRoleScope`
// is replaced by a deterministic scope (the STS half is covered end to end in
// assume-role-1971.test.ts); `enterRoleScope` and the AsyncLocalStorage are the real ones.

import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { RoleScope } from '../src/read/client-config.js';
import { credentialScopeKey } from '../src/read/client-config.js';

vi.mock('../src/synth/resolve-app.js', () => ({ resolveApp: () => 'app' }));
const discoverStacksMock = vi.fn();
vi.mock('../src/synth/synth.js', () => ({
  discoverStacks: (...args: unknown[]) => discoverStacksMock(...args),
  synthApp: () => Promise.reject(new Error('not used')),
}));
const gatherFindingsMock = vi.fn();
vi.mock('../src/commands/gather.js', () => ({
  gatherFindings: (...args: unknown[]) => gatherFindingsMock(...args),
}));
const stackRoleScopeMock = vi.fn();
vi.mock('../src/read/assume-role.js', async (orig) => ({
  ...(await orig<typeof import('../src/read/assume-role.js')>()),
  stackRoleScope: (...args: unknown[]) => stackRoleScopeMock(...args),
}));

import { runCheck } from '../src/commands/check.js';
import { runIgnore } from '../src/commands/ignore.js';
import { runRecord } from '../src/commands/record.js';
import { runRevert } from '../src/commands/revert.js';

const ROLE = 'arn:aws:iam::{account}:role/Reader';
const STACKS = [
  { stackName: 'Dev', region: 'us-east-1', account: '222222222222', template: {} },
  { stackName: 'Prod', region: 'eu-west-1', account: '333333333333', template: {} },
];
const scopeFor = (account: string): RoleScope => ({
  roleArn: `arn:aws:iam::${account}:role/Reader`,
  provider: () => Promise.reject(new Error('provider not used: STS is mocked')),
});

const sts = mockClient(STSClient);

const VERBS = [
  ['check', runCheck],
  ['record', runRecord],
  ['ignore', runIgnore],
  ['revert', runRevert],
] as const;

describe('#1971 every verb runs each stack inside its own --assume-role scope', () => {
  let gatheredUnder: string[];
  beforeEach(() => {
    gatheredUnder = [];
    discoverStacksMock.mockResolvedValue(STACKS);
    stackRoleScopeMock.mockImplementation(
      (_t: string, s: { account: string }): Promise<RoleScope> =>
        Promise.resolve(scopeFor(s.account))
    );
    // the caller identity of a scope is the account its role lives in
    sts.reset();
    sts.on(GetCallerIdentityCommand).callsFake(() => ({
      Account: /iam::(\d{12}):/.exec(credentialScopeKey())?.[1] ?? '999999999999',
    }));
    // record the scope the gather (the stack's AWS reads) ran under, then end the stack
    gatherFindingsMock.mockImplementation(() => {
      gatheredUnder.push(credentialScopeKey());
      return Promise.reject(new Error('stop after gather'));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    discoverStacksMock.mockReset();
    gatherFindingsMock.mockReset();
    stackRoleScopeMock.mockReset();
  });

  for (const [verb, run] of VERBS) {
    it(`${verb}: scope per stack, its own verb + the stack's account/region, caller resolved per scope`, async () => {
      await run(['--assume-role', ROLE]);
      expect(stackRoleScopeMock.mock.calls).toEqual([
        [ROLE, { account: '222222222222', region: 'us-east-1' }, verb],
        [ROLE, { account: '333333333333', region: 'eu-west-1' }, verb],
      ]);
      // BOTH stacks were read (neither skipped as a cross-account mismatch), each as its role
      expect(gatheredUnder).toEqual([
        'arn:aws:iam::222222222222:role/Reader',
        'arn:aws:iam::333333333333:role/Reader',
      ]);
    });
  }

  for (const [verb, run] of VERBS) {
    it(`${verb}: a role that cannot be assumed fails THAT stack (exit 2) and the next still runs`, async () => {
      const errs: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((s: unknown) => void errs.push(String(s)));
      stackRoleScopeMock.mockImplementationOnce(async () => {
        const { AssumeRoleError } = await import('../src/aws-errors.js');
        const error = new AssumeRoleError(
          'cannot assume role arn:aws:iam::222222222222:role/Reader (--assume-role): denied'
        );
        return { ...scopeFor('222222222222'), error };
      });
      expect(await run(['--assume-role', ROLE])).toBe(2);
      expect(errs.join('\n')).toContain(
        'error: Dev: cannot assume role arn:aws:iam::222222222222:role/Reader (--assume-role)'
      );
      expect(gatheredUnder).toEqual(['arn:aws:iam::333333333333:role/Reader']);
    });
  }

  it('without --assume-role no scope is entered (ambient run unchanged)', async () => {
    stackRoleScopeMock.mockImplementation(() => Promise.resolve(undefined));
    sts.on(GetCallerIdentityCommand).resolves({ Account: '222222222222' });
    await runRecord([]);
    expect(stackRoleScopeMock.mock.calls[0]?.[0]).toBeUndefined();
    expect(gatheredUnder).toEqual(['']); // Prod skipped as a mismatch against the one caller
  });
});

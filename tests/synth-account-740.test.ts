import { describe, expect, it } from 'vite-plus/test';
import { classifyAccountMismatch } from '../src/commands/check.js';
import { CONCRETE_ACCOUNT, concreteAccount } from '../src/synth/synth.js';

// #740: a multi-account CDK app (dev+prod in different accounts — the CDK Pipelines staple)
// must not silently green-pass an other-account stack as "not deployed yet", nor compare
// intent against a same-named stack in the WRONG (reachable) account. The fix threads each
// stack's concrete env.account through discovery and skips a proven cross-account mismatch.

describe('CONCRETE_ACCOUNT (env.account pin recognition, #740)', () => {
  it('accepts a 12-digit AWS account id', () => {
    for (const a of ['123456789012', '000000000000', '999999999999']) {
      expect(CONCRETE_ACCOUNT.test(a)).toBe(true);
    }
  });

  it('rejects toolkit-lib placeholders / non-concrete values', () => {
    for (const a of [
      '',
      'unknown-account', // toolkit-lib's env-agnostic sentinel
      '${Token[AWS.AccountId.42]}', // an unresolved token
      '12345678901', // 11 digits
      '1234567890123', // 13 digits
      '12345678901a', // non-digit
    ]) {
      expect(CONCRETE_ACCOUNT.test(a)).toBe(false);
    }
  });
});

describe('concreteAccount (synth env.account extraction, #740)', () => {
  it('carries a concrete 12-digit account through', () => {
    expect(concreteAccount('123456789012')).toBe('123456789012');
  });

  it('maps an env-agnostic / token account to undefined', () => {
    expect(concreteAccount('unknown-account')).toBeUndefined();
    expect(concreteAccount('${Token[AWS.AccountId.42]}')).toBeUndefined();
    expect(concreteAccount(undefined)).toBeUndefined();
    expect(concreteAccount('')).toBeUndefined();
  });
});

describe('classifyAccountMismatch (#740)', () => {
  it('does NOT skip when both accounts are the same', () => {
    const r = classifyAccountMismatch('123456789012', '123456789012');
    expect(r.skip).toBe(false);
  });

  it('SKIPS (with the pinned/creds message) when the accounts differ', () => {
    const r = classifyAccountMismatch('111111111111', '222222222222');
    expect(r.skip).toBe(true);
    expect(r.message).toContain('111111111111'); // the pinned account
    expect(r.message).toContain('222222222222'); // the active-credentials account
    expect(r.message).toContain('pinned to account');
    expect(r.message).toContain('active credentials');
    // points the user at how to check it (run with the pinned account's creds)
    expect(r.message).toContain('account-111111111111 credentials');
  });

  it('does NOT skip when the declared account is undefined (env-agnostic stack)', () => {
    expect(classifyAccountMismatch(undefined, '222222222222').skip).toBe(false);
  });

  it('does NOT skip when the caller account is undefined (STS unresolved)', () => {
    expect(classifyAccountMismatch('111111111111', undefined).skip).toBe(false);
  });

  it('does NOT skip when both are undefined (cannot prove a mismatch)', () => {
    expect(classifyAccountMismatch(undefined, undefined).skip).toBe(false);
  });
});

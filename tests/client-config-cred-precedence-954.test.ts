// #954: the raw SDK clients' credential precedence must match toolkit-lib / the AWS CLI.
//
// The split-brain the issue reports: when BOTH static env creds (AWS_ACCESS_KEY_ID +
// AWS_SECRET_ACCESS_KEY) AND AWS_PROFILE are set, with no explicit `--profile`, toolkit-lib
// (synth/discovery) prioritizes the ENV creds (`shouldPrioritizeEnv()` returns true), while
// the raw SDK v3 default provider SKIPS fromEnv when AWS_PROFILE is set and uses the PROFILE
// creds. These tests assert cdkrd's shared `shouldPrioritizeEnv` picks the SAME winner as
// toolkit-lib (env), and that `CLIENT_CREDENTIALS` actually resolves the env identity in
// that case — so every raw client (which spreads CLIENT_TIMEOUTS / READ_RETRY) agrees with
// discovery on ONE identity.
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { CLIENT_CREDENTIALS, shouldPrioritizeEnv } from '../src/read/client-config.js';

// The exact env vars toolkit-lib's shouldPrioritizeEnv() + our port read.
const CRED_ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AMAZON_ACCESS_KEY_ID',
  'AMAZON_SECRET_ACCESS_KEY',
  'AMAZON_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'CDKRD_EXPLICIT_PROFILE',
] as const;

describe('#954 raw-client credential precedence (matches toolkit-lib)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    // Snapshot + clear every relevant var so the ambient dev environment (a real AWS_PROFILE
    // / exported creds) never leaks into the assertions.
    saved = {};
    for (const k of CRED_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of CRED_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('prioritizes env when BOTH env creds and AWS_PROFILE are set (no --profile) — toolkit-lib winner', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAENV';
    process.env.AWS_SECRET_ACCESS_KEY = 'secretenv';
    process.env.AWS_PROFILE = 'dev';
    // This is the split-brain case: toolkit-lib returns true here, so the raw clients MUST too.
    expect(shouldPrioritizeEnv()).toBe(true);
  });

  it('resolves the ENV identity (not the profile) in the double-source case', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAENV';
    process.env.AWS_SECRET_ACCESS_KEY = 'secretenv';
    process.env.AWS_SESSION_TOKEN = 'tokenenv';
    process.env.AWS_PROFILE = 'dev'; // a profile that would win under the raw SDK default chain
    const creds = await CLIENT_CREDENTIALS();
    expect(creds.accessKeyId).toBe('AKIAENV');
    expect(creds.secretAccessKey).toBe('secretenv');
    expect(creds.sessionToken).toBe('tokenenv');
  });

  it('does NOT prioritize env when only AWS_PROFILE is set (no env creds) — profile-only, unchanged', () => {
    process.env.AWS_PROFILE = 'dev';
    expect(shouldPrioritizeEnv()).toBe(false);
  });

  it('prioritizes env when only env creds are set (no profile) — same as toolkit-lib; a no-op in practice', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAENV';
    process.env.AWS_SECRET_ACCESS_KEY = 'secretenv';
    // toolkit-lib's shouldPrioritizeEnv() only checks env creds, so it is true here too — our
    // port matches. With no profile this is a no-op in effect (both fromEnv and the default
    // chain resolve the same env identity), so single-source behavior is unchanged.
    expect(shouldPrioritizeEnv()).toBe(true);
  });

  it('does NOT prioritize env when --profile is EXPLICIT (CDKRD_EXPLICIT_PROFILE) — toolkit-lib uses fromIni exclusively', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAENV';
    process.env.AWS_SECRET_ACCESS_KEY = 'secretenv';
    process.env.AWS_PROFILE = 'cliprofile'; // exported by the verb entry from --profile
    process.env.CDKRD_EXPLICIT_PROFILE = '1'; // the "was explicit" marker cli-args sets
    // An explicit --profile means the chosen profile wins in toolkit-lib (fromIni), so env
    // must NOT be prioritized — otherwise we'd RE-INTRODUCE the split-brain in the other
    // direction (toolkit uses profile, raw uses env).
    expect(shouldPrioritizeEnv()).toBe(false);
  });

  it('honors AWS_DEFAULT_PROFILE and the AMAZON_* env aliases like toolkit-lib', () => {
    process.env.AMAZON_ACCESS_KEY_ID = 'AKIAAMZ';
    process.env.AMAZON_SECRET_ACCESS_KEY = 'secretamz';
    process.env.AWS_DEFAULT_PROFILE = 'dev';
    // toolkit-lib's shouldPrioritizeEnv reads the AMAZON_* aliases; AWS_DEFAULT_PROFILE is
    // the sibling profile source (#953). Double-source still prioritizes env.
    expect(shouldPrioritizeEnv()).toBe(true);
  });
});

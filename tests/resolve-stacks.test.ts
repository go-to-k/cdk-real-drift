import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { resolveProfileRegion } from '../src/commands/resolve-stacks.js';

// resolveProfileRegion is the LAST region fallback for an env-agnostic CDK stack:
// when neither the stack's `env` nor --region / $AWS_REGION supply a region, it
// reads the active AWS profile's configured region from ~/.aws/config so the run
// still has a region to query instead of erroring.
describe('resolveProfileRegion', () => {
  let configPath: string;
  let tmp: string;
  const saved: Record<string, string | undefined> = {};
  const ENVS = [
    'AWS_CONFIG_FILE',
    'AWS_PROFILE',
    'AWS_DEFAULT_PROFILE',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_EC2_METADATA_DISABLED',
  ];

  beforeEach(() => {
    for (const k of ENVS) saved[k] = process.env[k];
    // A profile's region must come from the shared config file alone — clear any
    // ambient region/profile env that would otherwise win in the provider chain.
    for (const k of ENVS) delete process.env[k];
    tmp = mkdtempSync(join(tmpdir(), 'cdkrd-region-'));
    configPath = join(tmp, 'config');
    writeFileSync(
      configPath,
      [
        '[profile haszone]',
        'region = eu-west-2',
        '',
        '[profile noregion]',
        'output = json',
        '',
      ].join('\n')
    );
    process.env.AWS_CONFIG_FILE = configPath;
    // The no-region cases fall through to the host's ~/.aws/credentials [default] and to
    // IMDS; point both at nothing so a runner with either one cannot answer 'us-east-1'.
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(tmp, 'no-such-credentials');
    process.env.AWS_EC2_METADATA_DISABLED = 'true';
  });

  afterEach(() => {
    for (const k of ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the named profile's configured region", async () => {
    expect(await resolveProfileRegion('haszone')).toBe('eu-west-2');
  });

  it('returns undefined when the profile sets no region', async () => {
    expect(await resolveProfileRegion('noregion')).toBeUndefined();
  });

  it('returns undefined when the profile does not exist', async () => {
    expect(await resolveProfileRegion('missing')).toBeUndefined();
  });

  it('falls back to $AWS_PROFILE when no profile is passed', async () => {
    process.env.AWS_PROFILE = 'haszone';
    expect(await resolveProfileRegion(undefined)).toBe('eu-west-2');
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { defaultProfileRegionFromIni, regionFromImds } from '../src/commands/resolve-stacks.js';

// #955 — cdkrd's env-agnostic-stack region fallback (`resolveProfileRegion`) queried the
// raw SDK region chain, which reads the SELECTED profile's ini region only. The AWS CLI /
// cdk (toolkit-lib) additionally fall back to the `default` profile's ini region, then
// IMDS. These cover the two missing tiers so `AWS_PROFILE=prod cdkrd check` resolves the
// same region `cdk deploy` would when `[profile prod]` has no region but `[default]` does.
describe('defaultProfileRegionFromIni (#955 default-profile ini fallback)', () => {
  let dir: string;
  const saved = {
    cred: process.env.AWS_SHARED_CREDENTIALS_FILE,
    cfg: process.env.AWS_CONFIG_FILE,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkrd-ini-'));
  });
  afterEach(() => {
    if (saved.cred === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE;
    else process.env.AWS_SHARED_CREDENTIALS_FILE = saved.cred;
    if (saved.cfg === undefined) delete process.env.AWS_CONFIG_FILE;
    else process.env.AWS_CONFIG_FILE = saved.cfg;
    rmSync(dir, { recursive: true, force: true });
  });

  const setFiles = (credText: string | null, cfgText: string | null): void => {
    if (credText !== null) {
      const p = join(dir, 'credentials');
      writeFileSync(p, credText);
      process.env.AWS_SHARED_CREDENTIALS_FILE = p;
    } else {
      process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, 'no-credentials');
    }
    if (cfgText !== null) {
      const p = join(dir, 'config');
      writeFileSync(p, cfgText);
      process.env.AWS_CONFIG_FILE = p;
    } else {
      process.env.AWS_CONFIG_FILE = join(dir, 'no-config');
    }
  };

  it("reads the config file's [default] region (the flagship repro)", () => {
    setFiles('[default]\naws_access_key_id = AKIA\n', '[default]\nregion = ap-northeast-1\n');
    expect(defaultProfileRegionFromIni()).toBe('ap-northeast-1');
  });

  it('prefers the credentials file over config ("credentials before config")', () => {
    setFiles('[default]\nregion = us-west-2\n', '[default]\nregion = eu-central-1\n');
    expect(defaultProfileRegionFromIni()).toBe('us-west-2');
  });

  it('ignores a NAMED profile section — only [default] counts', () => {
    setFiles(null, '[profile prod]\nregion = us-east-2\n[default]\nregion = sa-east-1\n');
    expect(defaultProfileRegionFromIni()).toBe('sa-east-1');
  });

  it('skips comments and blank lines', () => {
    setFiles(null, '# a comment\n\n[default]\n; region = wrong\nregion = ca-central-1\n');
    expect(defaultProfileRegionFromIni()).toBe('ca-central-1');
  });

  it('returns undefined when no [default] region exists anywhere', () => {
    setFiles('[default]\naws_access_key_id = AKIA\n', '[profile prod]\nregion = us-east-1\n');
    expect(defaultProfileRegionFromIni()).toBeUndefined();
  });

  it('returns undefined when neither file exists', () => {
    setFiles(null, null);
    expect(defaultProfileRegionFromIni()).toBeUndefined();
  });
});

describe('regionFromImds (#955 IMDS tier, guarded)', () => {
  const saved = process.env.AWS_EC2_METADATA_DISABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.AWS_EC2_METADATA_DISABLED;
    else process.env.AWS_EC2_METADATA_DISABLED = saved;
  });

  it('returns undefined immediately (no network) when AWS_EC2_METADATA_DISABLED=true', async () => {
    process.env.AWS_EC2_METADATA_DISABLED = 'true';
    expect(await regionFromImds()).toBeUndefined();
  });
});

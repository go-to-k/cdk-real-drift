import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { matchesPathGlob } from '../src/commands/glob-match.js';
import { loadConfig } from '../src/config/config-file.js';

// Issue #777 — two "rule silently never matches" traps.

describe('matchesPathGlob — bracket-aware `*` / `?` (#777 part 1)', () => {
  // cdkrd's own canonical ELB attribute paths carry DOTTED bracket keys; a `*` inside a
  // `[...]` bracket is unbounded within that bracket (the `.` between brackets is data,
  // not a segment boundary), so these must match.
  const albKey = 'Alb.LoadBalancerAttributes[routing.http2.enabled]';

  it('`[*]` matches a dotted bracket key', () => {
    expect(matchesPathGlob('Alb.LoadBalancerAttributes[*]', albKey)).toBe(true);
    expect(
      matchesPathGlob(
        'Alb.LoadBalancerAttributes[*]',
        'Alb.LoadBalancerAttributes[idle_timeout.timeout_seconds]'
      )
    ).toBe(true);
    expect(
      matchesPathGlob(
        'Alb.LoadBalancerAttributes[*]',
        'Alb.LoadBalancerAttributes[access_logs.s3.enabled]'
      )
    ).toBe(true);
    // simple (no-dot) key still matches, as before
    expect(matchesPathGlob('Tags[*]', 'Tags[env]')).toBe(true);
  });

  it('`[prefix.*]` matches the rest of a dotted bracket key', () => {
    expect(matchesPathGlob('Alb.LoadBalancerAttributes[routing.*]', albKey)).toBe(true);
    expect(matchesPathGlob('Alb.LoadBalancerAttributes[routing.http2.*]', albKey)).toBe(true);
  });

  it('a bracket `*` does NOT cross the closing `]` (still one bracket segment)', () => {
    expect(matchesPathGlob('Alb.LoadBalancerAttributes[*]', `${albKey}.Sub`)).toBe(false);
    expect(matchesPathGlob('Tags[*]', 'Tags[env].Sub')).toBe(false);
  });

  it('a `*` OUTSIDE brackets still does NOT cross a `.` segment boundary', () => {
    expect(matchesPathGlob('*.DesiredCount', 'Svc123.DesiredCount')).toBe(true);
    expect(matchesPathGlob('*.DesiredCount', 'Tbl.Config.DesiredCount')).toBe(false);
    expect(matchesPathGlob('Alb.*', 'Alb.LoadBalancerAttributes')).toBe(true);
    // the segment star must not swallow the dotted tail outside brackets
    expect(matchesPathGlob('Alb.*', albKey)).toBe(false);
  });

  it('`?` inside a bracket matches one char but does not cross `]`', () => {
    expect(matchesPathGlob('Tags[en?]', 'Tags[env]')).toBe(true);
    expect(matchesPathGlob('Tags[?]', 'Tags[e]')).toBe(true);
    expect(matchesPathGlob('Tags[?]', 'Tags[env]')).toBe(false); // exactly one char
  });
});

describe('loadConfig — reject present-but-empty scope axes (#777 part 2)', () => {
  let dir: string;
  let prevCwd: string;
  beforeEach(async () => {
    prevCwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'cdkrd-777-'));
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(prevCwd);
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (content: string) => {
    await mkdir('.cdkrd', { recursive: true });
    await writeFile('.cdkrd/ignore.yaml', content, 'utf8');
  };

  it('empty `stack` → throws (would match nothing, a silent no-op rule)', async () => {
    await write('ignore:\n  - path: x\n    stack: ""\n');
    await expect(loadConfig()).rejects.toThrow(/"stack" must not be empty/);
  });

  it('empty `account` → throws', async () => {
    await write('ignore:\n  - path: x\n    account: ""\n');
    await expect(loadConfig()).rejects.toThrow(/"account" must not be empty/);
  });

  it('empty `region` → throws', async () => {
    await write('ignore:\n  - path: x\n    region: ""\n');
    await expect(loadConfig()).rejects.toThrow(/"region" must not be empty/);
  });

  it('a scope axis simply OMITTED is fine (unscoped = match-all)', async () => {
    await write('ignore:\n  - path: x\n');
    expect(await loadConfig()).toEqual({ ignore: [{ path: 'x' }] });
  });
});

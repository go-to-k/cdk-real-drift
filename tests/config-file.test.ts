import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { buildAccepted } from '../src/baseline/baseline-file.js';
import {
  applyIgnores,
  type CdkrdConfig,
  loadConfig,
  parseIgnoreRule,
} from '../src/config/config-file.js';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

const cfg = (ignore: string[]): CdkrdConfig => ({ ignore });

const declared = (logicalId: string, path: string): Finding => ({
  tier: 'declared',
  logicalId,
  resourceType: 'AWS::ECS::Service',
  path,
  physicalId: `${logicalId}-phys`,
  desired: 1,
  actual: 2,
});
const undeclared = (logicalId: string, path: string): Finding => ({
  tier: 'undeclared',
  logicalId,
  resourceType: 'AWS::DynamoDB::Table',
  path,
  actual: { x: 1 },
});

describe('parseIgnoreRule', () => {
  it('no colon → any-stack rule', () => {
    expect(parseIgnoreRule('*.DesiredCount')).toEqual({
      raw: '*.DesiredCount',
      idPathPattern: '*.DesiredCount',
    });
  });
  it('colon → stack-scoped rule (splits on the first colon)', () => {
    expect(parseIgnoreRule('Prod*:*.ReservedConcurrentExecutions')).toEqual({
      raw: 'Prod*:*.ReservedConcurrentExecutions',
      stackGlob: 'Prod*',
      idPathPattern: '*.ReservedConcurrentExecutions',
    });
  });
});

describe('applyIgnores', () => {
  it('empty config is a pass-through (no allocation of new findings needed)', () => {
    const fs = [declared('Svc', 'DesiredCount')];
    expect(applyIgnores(fs, 'AnyStack', cfg([]))).toBe(fs);
  });

  it('exact match re-tags a declared finding to ignored with the rule in the note', () => {
    const [f] = applyIgnores([declared('Svc', 'DesiredCount')], 'S', cfg(['Svc.DesiredCount']));
    expect(f?.tier).toBe('ignored');
    expect(f?.note).toBe('ignored by config rule "Svc.DesiredCount"');
  });

  it('wildcard *.DesiredCount matches any logical id', () => {
    const out = applyIgnores(
      [declared('Service1234ABCD', 'DesiredCount'), declared('Other', 'Cpu')],
      'S',
      cfg(['*.DesiredCount'])
    );
    expect(out.map((f) => f.tier)).toEqual(['ignored', 'declared']);
  });

  it('re-tags undeclared too', () => {
    const [f] = applyIgnores(
      [undeclared('MyTable', 'ProvisionedThroughput')],
      'S',
      cfg(['*.ProvisionedThroughput'])
    );
    expect(f?.tier).toBe('ignored');
  });

  it('parent-segment rule covers child paths', () => {
    const [f] = applyIgnores(
      [undeclared('Role', 'Policies.0.PolicyName')],
      'S',
      cfg(['Role.Policies'])
    );
    expect(f?.tier).toBe('ignored');
  });

  it('matches the friendly constructPath too (CDK stacks; same id cdk-local targets)', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'ApiRole1234ABCD',
      constructPath: 'MyStack/ApiRole',
      resourceType: 'AWS::IAM::Role',
      path: 'Policies',
      actual: [{}],
    };
    // a rule written against the human-friendly path matches via constructPath…
    expect(applyIgnores([f], 'MyStack', cfg(['MyStack/ApiRole.Policies']))[0]?.tier).toBe(
      'ignored'
    );
    expect(applyIgnores([f], 'MyStack', cfg(['*/ApiRole.Policies']))[0]?.tier).toBe('ignored');
    // …and the logicalId still works for the same finding (both targets are tried)
    expect(applyIgnores([f], 'MyStack', cfg(['ApiRole*.Policies']))[0]?.tier).toBe('ignored');
  });

  it('logicalId rule still matches when constructPath is absent (non-CDK stack)', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'ApiRole',
      resourceType: 'AWS::IAM::Role',
      path: 'Policies',
      actual: [{}],
    };
    expect(applyIgnores([f], 'RawCfnStack', cfg(['ApiRole.Policies']))[0]?.tier).toBe('ignored');
  });

  it('stack-scoped rule applies only to matching stack names', () => {
    const rule = cfg(['Prod*:*.DesiredCount']);
    expect(applyIgnores([declared('Svc', 'DesiredCount')], 'ProdApi', rule)[0]?.tier).toBe(
      'ignored'
    );
    expect(applyIgnores([declared('Svc', 'DesiredCount')], 'DevApi', rule)[0]?.tier).toBe(
      'declared'
    );
  });

  it('NEVER ignores deleted (a path rule must not silence a resource deletion)', () => {
    const del: Finding = {
      tier: 'deleted',
      logicalId: 'Svc',
      resourceType: 'AWS::ECS::Service',
      path: '',
    };
    expect(applyIgnores([del], 'S', cfg(['Svc*', '*']))[0]?.tier).toBe('deleted');
  });

  it('leaves already-informational tiers (readGap/skipped/unresolved) untouched', () => {
    const rg: Finding = {
      tier: 'readGap',
      logicalId: 'Svc',
      resourceType: 'AWS::ECS::Service',
      path: 'DesiredCount',
    };
    expect(applyIgnores([rg], 'S', cfg(['*.DesiredCount']))[0]?.tier).toBe('readGap');
  });

  it('ignored declared drops out of the revert plan', () => {
    const ignored = applyIgnores([declared('Svc', 'DesiredCount')], 'S', cfg(['*.DesiredCount']));
    const plan = buildRevertPlan(ignored, undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(0);
  });

  it('ignored undeclared is not offered to accept (buildAccepted excludes it)', () => {
    const ignored = applyIgnores(
      [undeclared('MyTable', 'ProvisionedThroughput')],
      'S',
      cfg(['*.ProvisionedThroughput'])
    );
    expect(buildAccepted(ignored)).toHaveLength(0);
  });
});

describe('loadConfig', () => {
  let dir: string;
  let prevCwd: string;
  beforeEach(async () => {
    prevCwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'cdkrd-cfg-'));
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(prevCwd);
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (content: string) => {
    await mkdir('.cdkrd', { recursive: true });
    await writeFile('.cdkrd/config.json', content, 'utf8');
  };

  it('absent file → empty config (backward compatible, no migration)', async () => {
    expect(await loadConfig()).toEqual({ ignore: [] });
  });

  it('valid config loads the ignore array', async () => {
    await write('{ "ignore": ["*.DesiredCount", "Prod*:*.Cpu"] }');
    expect(await loadConfig()).toEqual({ ignore: ['*.DesiredCount', 'Prod*:*.Cpu'] });
  });

  it('object without ignore → empty ignore', async () => {
    await write('{}');
    expect(await loadConfig()).toEqual({ ignore: [] });
  });

  it('invalid JSON → throws (fail-fast, not silent)', async () => {
    await write('{ not json');
    await expect(loadConfig()).rejects.toThrow(/not valid JSON/);
  });

  it('ignore not an array of strings → throws', async () => {
    await write('{ "ignore": [1, 2] }');
    await expect(loadConfig()).rejects.toThrow(/"ignore" must be an array of strings/);
  });

  it('top-level array → throws (must be an object)', async () => {
    await write('["*.DesiredCount"]');
    await expect(loadConfig()).rejects.toThrow(/must be a JSON object/);
  });
});

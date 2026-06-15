import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { buildRecorded } from '../src/baseline/baseline-file.js';
import {
  addIgnoreRules,
  applyIgnores,
  type CdkrdConfig,
  ignoreRuleFor,
  loadConfig,
  mergeIgnoreRules,
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

  it('ignored undeclared is not offered to record (buildRecorded excludes it)', () => {
    const ignored = applyIgnores(
      [undeclared('MyTable', 'ProvisionedThroughput')],
      'S',
      cfg(['*.ProvisionedThroughput'])
    );
    expect(buildRecorded(ignored)).toHaveLength(0);
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

  it('unknown key → throws (a typo like "ignroe" must not silently disable rules)', async () => {
    await write('{ "ignroe": ["*.DesiredCount"] }');
    await expect(loadConfig()).rejects.toThrow(/unknown key\(s\) "ignroe" — known keys: "ignore"/);
  });

  it('unknown key alongside a valid one → still throws, listing only the unknown', async () => {
    await write('{ "ignore": [], "concurency": 4 }');
    await expect(loadConfig()).rejects.toThrow(/unknown key\(s\) "concurency"/);
  });
});

describe('ignoreRuleFor', () => {
  it('prefers the friendly constructPath when present (naturally stack-scoped)', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'ApiRole1234ABCD',
      constructPath: 'MyStack/ApiRole',
      resourceType: 'AWS::IAM::Role',
      path: 'Policies',
      actual: [{}],
    };
    expect(ignoreRuleFor(f)).toBe('MyStack/ApiRole.Policies');
  });

  it('falls back to logicalId when constructPath is absent (non-CDK stack)', () => {
    expect(ignoreRuleFor(declared('ApiRole', 'Policies'))).toBe('ApiRole.Policies');
  });

  it('omits the trailing dot for a resource-level (empty path) finding', () => {
    const f: Finding = {
      tier: 'declared',
      logicalId: 'Svc',
      resourceType: 'AWS::ECS::Service',
      path: '',
    };
    expect(ignoreRuleFor(f)).toBe('Svc');
  });
});

describe('mergeIgnoreRules', () => {
  it('unions new rules, sorts stably, and reports what was added', () => {
    const r = mergeIgnoreRules(['B.x'], ['A.y', 'C.z']);
    expect(r.merged).toEqual(['A.y', 'B.x', 'C.z']);
    expect(r.added).toEqual(['A.y', 'C.z']);
    expect(r.alreadyPresent).toEqual([]);
  });

  it('drops rules already present (idempotent) and de-dupes the incoming list', () => {
    const r = mergeIgnoreRules(['A.y'], ['A.y', 'B.x', 'B.x']);
    expect(r.merged).toEqual(['A.y', 'B.x']);
    expect(r.added).toEqual(['B.x']);
    expect(r.alreadyPresent).toEqual(['A.y']);
  });

  it('all-already-present → no additions, merged equals existing (sorted)', () => {
    const r = mergeIgnoreRules(['B.x', 'A.y'], ['A.y']);
    expect(r.added).toEqual([]);
    expect(r.alreadyPresent).toEqual(['A.y']);
    expect(r.merged).toEqual(['A.y', 'B.x']);
  });
});

describe('addIgnoreRules', () => {
  let dir: string;
  let prevCwd: string;
  beforeEach(async () => {
    prevCwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'cdkrd-addign-'));
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(prevCwd);
    await rm(dir, { recursive: true, force: true });
  });

  it('creates .cdkrd/config.json (and the dir) when absent', async () => {
    const r = await addIgnoreRules(['Svc.DesiredCount']);
    expect(r.added).toEqual(['Svc.DesiredCount']);
    expect(r.path).toBe('.cdkrd/config.json');
    expect(JSON.parse(await readFile('.cdkrd/config.json', 'utf8'))).toEqual({
      ignore: ['Svc.DesiredCount'],
    });
  });

  it('appends to an existing config, preserving prior rules (sorted union)', async () => {
    await mkdir('.cdkrd', { recursive: true });
    await writeFile('.cdkrd/config.json', '{ "ignore": ["Zeta.x"] }', 'utf8');
    const r = await addIgnoreRules(['Alpha.y']);
    expect(r.added).toEqual(['Alpha.y']);
    expect(JSON.parse(await readFile('.cdkrd/config.json', 'utf8')).ignore).toEqual([
      'Alpha.y',
      'Zeta.x',
    ]);
  });

  it('all-already-present → leaves the file byte-for-byte untouched', async () => {
    await mkdir('.cdkrd', { recursive: true });
    const original = '{"ignore":["A.y"]}';
    await writeFile('.cdkrd/config.json', original, 'utf8');
    const r = await addIgnoreRules(['A.y']);
    expect(r.added).toEqual([]);
    expect(r.alreadyPresent).toEqual(['A.y']);
    // not rewritten — the original (compact) bytes survive
    expect(await readFile('.cdkrd/config.json', 'utf8')).toBe(original);
  });

  it('writes pretty JSON with a trailing newline (reviewable git diff)', async () => {
    await addIgnoreRules(['Svc.DesiredCount']);
    const raw = await readFile('.cdkrd/config.json', 'utf8');
    expect(raw).toBe(`{\n  "ignore": [\n    "Svc.DesiredCount"\n  ]\n}\n`);
  });
});

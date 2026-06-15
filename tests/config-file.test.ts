import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { buildRecorded } from '../src/baseline/baseline-file.js';
import {
  addIgnoreRules,
  applyIgnores,
  type CdkrdConfig,
  type IgnoreEntry,
  ignoreRuleFor,
  loadConfig,
  mergeIgnoreRules,
  parseIgnoreRule,
} from '../src/config/config-file.js';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

const cfg = (ignore: IgnoreEntry[]): CdkrdConfig => ({ ignore });
// region-agnostic wrapper for the many cases that don't exercise region scope (the
// region-scoped tests call applyIgnores directly with an explicit region).
const ign = (findings: Finding[], stackName: string, config: CdkrdConfig): Finding[] =>
  applyIgnores(findings, stackName, 'us-east-1', config);

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
  it('bare string → unscoped rule (any stack, any region)', () => {
    expect(parseIgnoreRule('*.DesiredCount')).toEqual({
      raw: '*.DesiredCount',
      pathPattern: '*.DesiredCount',
    });
  });
  it('object with stack → stack-scoped rule', () => {
    expect(parseIgnoreRule({ path: '*.ReservedConcurrentExecutions', stack: 'Prod*' })).toEqual({
      raw: '*.ReservedConcurrentExecutions (stack:Prod*)',
      pathPattern: '*.ReservedConcurrentExecutions',
      stackGlob: 'Prod*',
      regionGlob: undefined,
    });
  });
  it('object with region → region-scoped rule', () => {
    expect(parseIgnoreRule({ path: '*.DesiredCount', region: 'us-*' })).toEqual({
      raw: '*.DesiredCount (region:us-*)',
      pathPattern: '*.DesiredCount',
      stackGlob: undefined,
      regionGlob: 'us-*',
    });
  });
  it('object with both stack and region → renders both scopes in the note', () => {
    expect(parseIgnoreRule({ path: 'Fn*.x', stack: 'Prod*', region: 'ap-northeast-1' })).toEqual({
      raw: 'Fn*.x (stack:Prod*, region:ap-northeast-1)',
      pathPattern: 'Fn*.x',
      stackGlob: 'Prod*',
      regionGlob: 'ap-northeast-1',
    });
  });
});

describe('applyIgnores', () => {
  it('empty config is a pass-through (no allocation of new findings needed)', () => {
    const fs = [declared('Svc', 'DesiredCount')];
    expect(ign(fs, 'AnyStack', cfg([]))).toBe(fs);
  });

  it('exact match re-tags a declared finding to ignored with the rule in the note', () => {
    const [f] = ign([declared('Svc', 'DesiredCount')], 'S', cfg(['Svc.DesiredCount']));
    expect(f?.tier).toBe('ignored');
    expect(f?.note).toBe('ignored by config rule "Svc.DesiredCount"');
  });

  it('wildcard *.DesiredCount matches any logical id', () => {
    const out = ign(
      [declared('Service1234ABCD', 'DesiredCount'), declared('Other', 'Cpu')],
      'S',
      cfg(['*.DesiredCount'])
    );
    expect(out.map((f) => f.tier)).toEqual(['ignored', 'declared']);
  });

  it('re-tags undeclared too', () => {
    const [f] = ign(
      [undeclared('MyTable', 'ProvisionedThroughput')],
      'S',
      cfg(['*.ProvisionedThroughput'])
    );
    expect(f?.tier).toBe('ignored');
  });

  it('parent-segment rule covers child paths', () => {
    const [f] = ign([undeclared('Role', 'Policies.0.PolicyName')], 'S', cfg(['Role.Policies']));
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
    expect(ign([f], 'MyStack', cfg(['MyStack/ApiRole.Policies']))[0]?.tier).toBe('ignored');
    expect(ign([f], 'MyStack', cfg(['*/ApiRole.Policies']))[0]?.tier).toBe('ignored');
    // …and the logicalId still works for the same finding (both targets are tried)
    expect(ign([f], 'MyStack', cfg(['ApiRole*.Policies']))[0]?.tier).toBe('ignored');
  });

  it('logicalId rule still matches when constructPath is absent (non-CDK stack)', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'ApiRole',
      resourceType: 'AWS::IAM::Role',
      path: 'Policies',
      actual: [{}],
    };
    expect(ign([f], 'RawCfnStack', cfg(['ApiRole.Policies']))[0]?.tier).toBe('ignored');
  });

  it('stack-scoped object rule applies only to matching stack names', () => {
    const rule = cfg([{ path: '*.DesiredCount', stack: 'Prod*' }]);
    expect(ign([declared('Svc', 'DesiredCount')], 'ProdApi', rule)[0]?.tier).toBe('ignored');
    expect(ign([declared('Svc', 'DesiredCount')], 'DevApi', rule)[0]?.tier).toBe('declared');
  });

  it('region-scoped object rule applies only in matching regions', () => {
    const rule = cfg([{ path: '*.DesiredCount', region: 'us-*' }]);
    const f = () => [declared('Svc', 'DesiredCount')];
    expect(applyIgnores(f(), 'S', 'us-east-1', rule)[0]?.tier).toBe('ignored');
    expect(applyIgnores(f(), 'S', 'us-west-2', rule)[0]?.tier).toBe('ignored');
    expect(applyIgnores(f(), 'S', 'ap-northeast-1', rule)[0]?.tier).toBe('declared');
  });

  it('stack AND region scope must BOTH match (independent axes)', () => {
    const rule = cfg([{ path: '*.DesiredCount', stack: 'Prod*', region: 'ap-northeast-1' }]);
    const f = () => [declared('Svc', 'DesiredCount')];
    expect(applyIgnores(f(), 'ProdApi', 'ap-northeast-1', rule)[0]?.tier).toBe('ignored');
    expect(applyIgnores(f(), 'ProdApi', 'us-east-1', rule)[0]?.tier).toBe('declared'); // wrong region
    expect(applyIgnores(f(), 'DevApi', 'ap-northeast-1', rule)[0]?.tier).toBe('declared'); // wrong stack
  });

  it('the scoped rule note names its scope', () => {
    const [f] = applyIgnores(
      [declared('Svc', 'DesiredCount')],
      'S',
      'us-east-1',
      cfg([{ path: '*.DesiredCount', region: 'us-*' }])
    );
    expect(f?.note).toBe('ignored by config rule "*.DesiredCount (region:us-*)"');
  });

  it('NEVER ignores deleted (a path rule must not silence a resource deletion)', () => {
    const del: Finding = {
      tier: 'deleted',
      logicalId: 'Svc',
      resourceType: 'AWS::ECS::Service',
      path: '',
    };
    expect(ign([del], 'S', cfg(['Svc*', '*']))[0]?.tier).toBe('deleted');
  });

  it('leaves already-informational tiers (readGap/skipped/unresolved) untouched', () => {
    const rg: Finding = {
      tier: 'readGap',
      logicalId: 'Svc',
      resourceType: 'AWS::ECS::Service',
      path: 'DesiredCount',
    };
    expect(ign([rg], 'S', cfg(['*.DesiredCount']))[0]?.tier).toBe('readGap');
  });

  it('ignored declared drops out of the revert plan', () => {
    const ignored = ign([declared('Svc', 'DesiredCount')], 'S', cfg(['*.DesiredCount']));
    const plan = buildRevertPlan(ignored, undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(0);
  });

  it('ignored undeclared is not offered to record (buildRecorded excludes it)', () => {
    const ignored = ign(
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

  it('valid config loads bare strings and scoped objects', async () => {
    await write(
      '{ "ignore": ["*.DesiredCount", { "path": "*.Cpu", "stack": "Prod*", "region": "us-*" }] }'
    );
    expect(await loadConfig()).toEqual({
      ignore: ['*.DesiredCount', { path: '*.Cpu', stack: 'Prod*', region: 'us-*' }],
    });
  });

  it('object without ignore → empty ignore', async () => {
    await write('{}');
    expect(await loadConfig()).toEqual({ ignore: [] });
  });

  it('invalid JSON → throws (fail-fast, not silent)', async () => {
    await write('{ not json');
    await expect(loadConfig()).rejects.toThrow(/not valid JSON/);
  });

  it('ignore not an array → throws', async () => {
    await write('{ "ignore": "*.DesiredCount" }');
    await expect(loadConfig()).rejects.toThrow(/"ignore" must be an array/);
  });

  it('a non-string / non-object entry → throws', async () => {
    await write('{ "ignore": [1] }');
    await expect(loadConfig()).rejects.toThrow(/"ignore"\[0\] must be a string or an object/);
  });

  it('an object entry without "path" → throws', async () => {
    await write('{ "ignore": [{ "stack": "Prod*" }] }');
    await expect(loadConfig()).rejects.toThrow(/"path" is required and must be a string/);
  });

  it('an object entry with a non-string scope → throws', async () => {
    await write('{ "ignore": [{ "path": "x", "region": 1 }] }');
    await expect(loadConfig()).rejects.toThrow(/"region" must be a string/);
  });

  it('an unknown key on an object entry → throws (typo guard, e.g. "reigon")', async () => {
    await write('{ "ignore": [{ "path": "x", "reigon": "us-*" }] }');
    await expect(loadConfig()).rejects.toThrow(/"ignore"\[0\]: unknown key\(s\) "reigon"/);
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

  it('preserves existing scoped OBJECT entries (sorted strings lead, objects follow)', () => {
    const obj = { path: '*.Cpu', region: 'us-*' };
    const r = mergeIgnoreRules(['Zeta.x', obj], ['Alpha.y']);
    // a bare string is never deduped against an object, so this is purely additive
    expect(r.added).toEqual(['Alpha.y']);
    expect(r.merged).toEqual(['Alpha.y', 'Zeta.x', obj]);
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

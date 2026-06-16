import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { buildRecorded } from '../src/baseline/baseline-file.js';
import {
  addIgnoreRules,
  applyIgnores,
  type CdkrdConfig,
  type IgnoreRuleObject,
  ignoreRuleFor,
  loadConfig,
  mergeIgnoreRules,
  parseIgnoreRule,
} from '../src/config/config-file.js';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

const cfg = (ignore: IgnoreRuleObject[]): CdkrdConfig => ({ ignore });
// terse unscoped rule: p('*.DesiredCount') === { path: '*.DesiredCount' }
const p = (path: string, extra: Omit<IgnoreRuleObject, 'path'> = {}): IgnoreRuleObject => ({
  path,
  ...extra,
});
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
  it('path only → unscoped rule (any stack, any region)', () => {
    expect(parseIgnoreRule({ path: '*.DesiredCount' })).toEqual({
      raw: '*.DesiredCount',
      pathPattern: '*.DesiredCount',
      stackGlob: undefined,
      regionGlob: undefined,
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
    const [f] = ign([declared('Svc', 'DesiredCount')], 'S', cfg([p('Svc.DesiredCount')]));
    expect(f?.tier).toBe('ignored');
    expect(f?.note).toBe('ignored by config rule "Svc.DesiredCount"');
  });

  it('wildcard *.DesiredCount matches any logical id', () => {
    const out = ign(
      [declared('Service1234ABCD', 'DesiredCount'), declared('Other', 'Cpu')],
      'S',
      cfg([p('*.DesiredCount')])
    );
    expect(out.map((f) => f.tier)).toEqual(['ignored', 'declared']);
  });

  it('wildcard *.X does NOT cross dot segments — a deeper same-named leaf is not over-ignored (WAVE21)', () => {
    // `*.DesiredCount` means "<anyId>.DesiredCount" (the documented intent), NOT "any
    // `.DesiredCount` at any depth". A genuinely-drifted DesiredCount nested deeper (or a
    // free-form-map key literally named DesiredCount) must NOT be silently hidden.
    const out = ign(
      [
        declared('Svc', 'DesiredCount'), // the intended target -> ignored
        declared('Tbl', 'Config.DesiredCount'), // nested deeper -> must stay drift
        undeclared('Tbl', 'SomeMap.DesiredCount'), // free-form leaf -> must stay drift
      ],
      'S',
      cfg([p('*.DesiredCount')])
    );
    expect(out.map((f) => f.tier)).toEqual(['ignored', 'declared', 'undeclared']);
  });

  it('a parent rule still covers a deep same-named leaf via the ancestor walk (no under-match)', () => {
    // segment-bounding `*` must not break subtree coverage: an explicit parent rule
    // (`Tbl.Config`) still ignores everything under it, including `Tbl.Config.DesiredCount`.
    const [f] = ign([declared('Tbl', 'Config.DesiredCount')], 'S', cfg([p('Tbl.Config')]));
    expect(f?.tier).toBe('ignored');
  });

  it('re-tags undeclared too', () => {
    const [f] = ign(
      [undeclared('MyTable', 'ProvisionedThroughput')],
      'S',
      cfg([p('*.ProvisionedThroughput')])
    );
    expect(f?.tier).toBe('ignored');
  });

  it('clears the unrecorded flag when re-tagging to ignored (ignore STOPS watching, WAVE22)', () => {
    // applyBaseline marks a not-yet-recorded undeclared value `unrecorded`; once ignored
    // it is a DECIDED value and must not still surface under [Not Recorded] / "run record".
    const f = { ...undeclared('MyTable', 'ProvisionedThroughput'), unrecorded: true };
    const [out] = ign([f], 'S', cfg([p('*.ProvisionedThroughput')]));
    expect(out?.tier).toBe('ignored');
    expect(out?.unrecorded).toBeUndefined();
  });

  it('parent-segment rule covers child paths', () => {
    const [f] = ign([undeclared('Role', 'Policies.0.PolicyName')], 'S', cfg([p('Role.Policies')]));
    expect(f?.tier).toBe('ignored');
  });

  it('parent rule covers BRACKET-indexed child paths (array / identity-keyed elements)', () => {
    // classify emits bracket paths (`Policies[MyPol].PolicyName`, `Statement[0].Condition`,
    // `Tags[env]`); the dot-only split silently failed to cover them under a parent rule.
    expect(
      ign([undeclared('Role', 'Policies[MyPol].PolicyName')], 'S', cfg([p('Role.Policies')]))[0]
        ?.tier
    ).toBe('ignored');
    expect(
      ign(
        [undeclared('P', 'PolicyDocument.Statement[0].Condition')],
        'S',
        cfg([p('P.PolicyDocument.Statement')])
      )[0]?.tier
    ).toBe('ignored');
    expect(ign([undeclared('R', 'Tags[env]')], 'S', cfg([p('R.Tags')]))[0]?.tier).toBe('ignored');
    // a SIBLING not under the rule's subtree is NOT ignored (no over-suppression)
    expect(
      ign([undeclared('Role', 'Other[MyPol].X')], 'S', cfg([p('Role.Policies')]))[0]?.tier
    ).toBe('undeclared');
  });

  it('re-tags an `added` (whole out-of-band resource, empty path) finding to ignored', () => {
    const addedFinding: Finding = {
      tier: 'added',
      logicalId: 'Api/abc|root|ANY',
      constructPath: 'MyStack/Api ▸ ANY /',
      resourceType: 'AWS::ApiGateway::Method',
      path: '',
    };
    // rule keyed on the construct-path id (no trailing dot — the finding has empty path)
    const [f] = ign([addedFinding], 'S', cfg([p('MyStack/Api ▸ ANY /')]));
    expect(f?.tier).toBe('ignored');
  });

  it('the rule ignoreRuleFor writes for an `added` finding matches that finding (round-trip)', () => {
    const addedFinding: Finding = {
      tier: 'added',
      logicalId: 'Api/abc|root|ANY',
      constructPath: 'MyStack/Api ▸ ANY /',
      resourceType: 'AWS::ApiGateway::Method',
      path: '',
    };
    const [f] = ign([addedFinding], 'S', cfg([ignoreRuleFor(addedFinding)]));
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
    expect(ign([f], 'MyStack', cfg([p('MyStack/ApiRole.Policies')]))[0]?.tier).toBe('ignored');
    expect(ign([f], 'MyStack', cfg([p('*/ApiRole.Policies')]))[0]?.tier).toBe('ignored');
    // …and the logicalId still works for the same finding (both targets are tried)
    expect(ign([f], 'MyStack', cfg([p('ApiRole*.Policies')]))[0]?.tier).toBe('ignored');
  });

  it('logicalId rule still matches when constructPath is absent (non-CDK stack)', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'ApiRole',
      resourceType: 'AWS::IAM::Role',
      path: 'Policies',
      actual: [{}],
    };
    expect(ign([f], 'RawCfnStack', cfg([p('ApiRole.Policies')]))[0]?.tier).toBe('ignored');
  });

  it('stack-scoped object rule applies only to matching stack names', () => {
    const rule = cfg([p('*.DesiredCount', { stack: 'Prod*' })]);
    expect(ign([declared('Svc', 'DesiredCount')], 'ProdApi', rule)[0]?.tier).toBe('ignored');
    expect(ign([declared('Svc', 'DesiredCount')], 'DevApi', rule)[0]?.tier).toBe('declared');
  });

  it('region-scoped object rule applies only in matching regions', () => {
    const rule = cfg([p('*.DesiredCount', { region: 'us-*' })]);
    const f = () => [declared('Svc', 'DesiredCount')];
    expect(applyIgnores(f(), 'S', 'us-east-1', rule)[0]?.tier).toBe('ignored');
    expect(applyIgnores(f(), 'S', 'us-west-2', rule)[0]?.tier).toBe('ignored');
    expect(applyIgnores(f(), 'S', 'ap-northeast-1', rule)[0]?.tier).toBe('declared');
  });

  it('stack AND region scope must BOTH match (independent axes)', () => {
    const rule = cfg([p('*.DesiredCount', { stack: 'Prod*', region: 'ap-northeast-1' })]);
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
      cfg([p('*.DesiredCount', { region: 'us-*' })])
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
    expect(ign([del], 'S', cfg([p('Svc*'), p('*')]))[0]?.tier).toBe('deleted');
  });

  it('leaves already-informational tiers (readGap/skipped/unresolved) untouched', () => {
    const rg: Finding = {
      tier: 'readGap',
      logicalId: 'Svc',
      resourceType: 'AWS::ECS::Service',
      path: 'DesiredCount',
    };
    expect(ign([rg], 'S', cfg([p('*.DesiredCount')]))[0]?.tier).toBe('readGap');
  });

  it('ignored declared drops out of the revert plan', () => {
    const ignored = ign([declared('Svc', 'DesiredCount')], 'S', cfg([p('*.DesiredCount')]));
    const plan = buildRevertPlan(ignored, undefined);
    expect(plan.items).toHaveLength(0);
    expect(plan.notRevertable).toHaveLength(0);
  });

  it('ignored undeclared is not offered to record (buildRecorded excludes it)', () => {
    const ignored = ign(
      [undeclared('MyTable', 'ProvisionedThroughput')],
      'S',
      cfg([p('*.ProvisionedThroughput')])
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

  it('absent file → empty config (no file, nothing to ignore)', async () => {
    expect(await loadConfig()).toEqual({ ignore: [] });
  });

  it('valid config loads object rules (unscoped + scoped)', async () => {
    await write(
      '{ "ignore": [{ "path": "*.DesiredCount" }, { "path": "*.Cpu", "stack": "Prod*", "region": "us-*" }] }'
    );
    expect(await loadConfig()).toEqual({
      ignore: [{ path: '*.DesiredCount' }, { path: '*.Cpu', stack: 'Prod*', region: 'us-*' }],
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
    await write('{ "ignore": { "path": "x" } }');
    await expect(loadConfig()).rejects.toThrow(/"ignore" must be an array/);
  });

  it('a bare string entry → throws (every rule is an object now)', async () => {
    await write('{ "ignore": ["*.DesiredCount"] }');
    await expect(loadConfig()).rejects.toThrow(/"ignore"\[0\] must be an object/);
  });

  it('a non-object entry → throws', async () => {
    await write('{ "ignore": [1] }');
    await expect(loadConfig()).rejects.toThrow(/"ignore"\[0\] must be an object/);
  });

  it('an object entry without "path" → throws', async () => {
    await write('{ "ignore": [{ "stack": "Prod*" }] }');
    await expect(loadConfig()).rejects.toThrow(/"path" is required and must be a string/);
  });

  it('an empty "path" → throws (a silent no-op rule must not masquerade as active, WAVE23)', async () => {
    await write('{ "ignore": [{ "path": "" }] }');
    await expect(loadConfig()).rejects.toThrow(/"path" must not be empty/);
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
    await write('[{ "path": "*.DesiredCount" }]');
    await expect(loadConfig()).rejects.toThrow(/must be a JSON object/);
  });

  it('unknown key → throws (a typo like "ignroe" must not silently disable rules)', async () => {
    await write('{ "ignroe": [{ "path": "*.DesiredCount" }] }');
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
    expect(ignoreRuleFor(f)).toEqual({ path: 'MyStack/ApiRole.Policies' });
  });

  it('falls back to logicalId when constructPath is absent (non-CDK stack)', () => {
    expect(ignoreRuleFor(declared('ApiRole', 'Policies'))).toEqual({ path: 'ApiRole.Policies' });
  });

  it('omits the trailing dot for a resource-level (empty path) finding', () => {
    const f: Finding = {
      tier: 'declared',
      logicalId: 'Svc',
      resourceType: 'AWS::ECS::Service',
      path: '',
    };
    expect(ignoreRuleFor(f)).toEqual({ path: 'Svc' });
  });
});

describe('mergeIgnoreRules', () => {
  it('unions new rules, sorts stably, and reports what was added', () => {
    const r = mergeIgnoreRules([p('B.x')], [p('A.y'), p('C.z')]);
    expect(r.merged).toEqual([p('A.y'), p('B.x'), p('C.z')]);
    expect(r.added).toEqual([p('A.y'), p('C.z')]);
    expect(r.alreadyPresent).toEqual([]);
  });

  it('drops rules already present (idempotent) and de-dupes the incoming list', () => {
    const r = mergeIgnoreRules([p('A.y')], [p('A.y'), p('B.x'), p('B.x')]);
    expect(r.merged).toEqual([p('A.y'), p('B.x')]);
    expect(r.added).toEqual([p('B.x')]);
    expect(r.alreadyPresent).toEqual([p('A.y')]);
  });

  it('all-already-present → no additions, merged equals existing (sorted)', () => {
    const r = mergeIgnoreRules([p('B.x'), p('A.y')], [p('A.y')]);
    expect(r.added).toEqual([]);
    expect(r.alreadyPresent).toEqual([p('A.y')]);
    expect(r.merged).toEqual([p('A.y'), p('B.x')]);
  });

  it('a scoped rule does NOT collide with the unscoped one for the same path', () => {
    const scoped = p('*.Cpu', { region: 'us-*' });
    const r = mergeIgnoreRules([p('*.Cpu')], [scoped]);
    // same path, different scope → a distinct rule, purely additive
    expect(r.added).toEqual([scoped]);
    expect(r.merged).toEqual([p('*.Cpu'), scoped]); // both kept, sorted (path tie → unscoped first)
  });

  it('sorts by path, then stack, then region (deterministic, reviewable diff)', () => {
    const a = p('Z.x');
    const b = p('A.x', { region: 'us-*' }); // no stack → empty stack sorts first
    const c = p('A.x', { stack: 'Prod*' });
    const r = mergeIgnoreRules([], [a, b, c]);
    expect(r.merged).toEqual([b, c, a]); // A.x(no-stack) < A.x(stack:Prod*) < Z.x
  });

  it('sorts byte-stably (uppercase before lowercase), not locale-dependently', () => {
    // config.json is git-committed, so its order must be byte-stable across machines/
    // locales. Byte order puts 'B' (0x42) before 'a' (0x61); localeCompare would group
    // case-insensitively and (in most locales) emit a.x before B.y — locale-dependent
    // churn. Asserting the byte order pins the deterministic, non-locale comparator.
    const r = mergeIgnoreRules([], [p('a.x'), p('B.y')]);
    expect(r.merged).toEqual([p('B.y'), p('a.x')]);
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
    const r = await addIgnoreRules([p('Svc.DesiredCount')]);
    expect(r.added).toEqual([p('Svc.DesiredCount')]);
    expect(r.path).toBe('.cdkrd/config.json');
    expect(JSON.parse(await readFile('.cdkrd/config.json', 'utf8'))).toEqual({
      ignore: [{ path: 'Svc.DesiredCount' }],
    });
  });

  it('appends to an existing config, preserving prior rules (sorted union)', async () => {
    await mkdir('.cdkrd', { recursive: true });
    await writeFile('.cdkrd/config.json', '{ "ignore": [{ "path": "Zeta.x" }] }', 'utf8');
    const r = await addIgnoreRules([p('Alpha.y')]);
    expect(r.added).toEqual([p('Alpha.y')]);
    expect(JSON.parse(await readFile('.cdkrd/config.json', 'utf8')).ignore).toEqual([
      { path: 'Alpha.y' },
      { path: 'Zeta.x' },
    ]);
  });

  it('preserves a hand-authored scoped rule on append', async () => {
    await mkdir('.cdkrd', { recursive: true });
    await writeFile(
      '.cdkrd/config.json',
      '{ "ignore": [{ "path": "*.Cpu", "region": "us-*" }] }',
      'utf8'
    );
    await addIgnoreRules([p('Alpha.y')]);
    expect(JSON.parse(await readFile('.cdkrd/config.json', 'utf8')).ignore).toEqual([
      { path: '*.Cpu', region: 'us-*' },
      { path: 'Alpha.y' },
    ]);
  });

  it('all-already-present → leaves the file byte-for-byte untouched', async () => {
    await mkdir('.cdkrd', { recursive: true });
    const original = '{"ignore":[{"path":"A.y"}]}';
    await writeFile('.cdkrd/config.json', original, 'utf8');
    const r = await addIgnoreRules([p('A.y')]);
    expect(r.added).toEqual([]);
    expect(r.alreadyPresent).toEqual([p('A.y')]);
    // not rewritten — the original (compact) bytes survive
    expect(await readFile('.cdkrd/config.json', 'utf8')).toBe(original);
  });

  it('writes pretty JSON with a trailing newline (reviewable git diff)', async () => {
    await addIgnoreRules([p('Svc.DesiredCount')]);
    const raw = await readFile('.cdkrd/config.json', 'utf8');
    expect(raw).toBe(`{\n  "ignore": [\n    {\n      "path": "Svc.DesiredCount"\n    }\n  ]\n}\n`);
  });
});

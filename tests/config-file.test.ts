import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { buildRecorded } from '../src/baseline/baseline-file.js';
import {
  addIgnoreRules,
  applyIgnores,
  type CdkrdConfig,
  escapeGlobLiterals,
  type IgnoreRuleObject,
  type IgnoreScope,
  ignoreRuleFor,
  isUniversalPath,
  loadConfig,
  mergeIgnoreRules,
  parseIgnoreRule,
} from '../src/config/config-file.js';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

// #1290 — deterministically reproduce a concurrent-append interleave by scripting the bytes
// each `readFile('.cdkrd/ignore.yaml')` returns. ESM export namespaces are frozen so `readFile`
// cannot be `vi.spyOn`-ed; instead mock `node:fs/promises` with a factory that DELEGATES every
// call to the real module (so all other tests keep hitting the real temp filesystem) and only
// overrides ignore.yaml reads WHEN `readScript` is set (null by default = pure pass-through).
const { readScript } = vi.hoisted(() => ({ readScript: { seq: null as string[] | null, i: 0 } }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readFile: (async (path: unknown, ...args: unknown[]) => {
      if (readScript.seq !== null && typeof path === 'string' && path.endsWith('ignore.yaml')) {
        const next = readScript.seq[Math.min(readScript.i, readScript.seq.length - 1)];
        readScript.i++;
        return Buffer.from(next, 'utf8');
      }
      return (real.readFile as (...a: unknown[]) => unknown)(path, ...args);
    }) as typeof real.readFile,
  };
});

const ACCT = '111111111111';
const cfg = (ignore: IgnoreRuleObject[]): CdkrdConfig => ({ ignore });
// terse scope object for the explicitly-scoped applyIgnores tests
const sc = (stackName: string, accountId: string, region: string): IgnoreScope => ({
  stackName,
  accountId,
  region,
});
// terse unscoped rule: p('*.DesiredCount') === { path: '*.DesiredCount' }
const p = (path: string, extra: Omit<IgnoreRuleObject, 'path'> = {}): IgnoreRuleObject => ({
  path,
  ...extra,
});
// account/region-agnostic wrapper for the many cases that don't exercise account/region
// scope (the scoped tests call applyIgnores directly with an explicit account + region).
const ign = (findings: Finding[], stackName: string, config: CdkrdConfig): Finding[] =>
  applyIgnores(findings, sc(stackName, ACCT, 'us-east-1'), config);

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
  it('path only → unscoped rule (any stack, account, region)', () => {
    expect(parseIgnoreRule({ path: '*.DesiredCount' })).toEqual({
      raw: '*.DesiredCount',
      pathPattern: '*.DesiredCount',
      stackGlob: undefined,
      accountGlob: undefined,
      regionGlob: undefined,
    });
  });
  it('object with stack → stack-scoped rule', () => {
    expect(parseIgnoreRule({ path: '*.ReservedConcurrentExecutions', stack: 'Prod*' })).toEqual({
      raw: '*.ReservedConcurrentExecutions (stack:Prod*)',
      pathPattern: '*.ReservedConcurrentExecutions',
      stackGlob: 'Prod*',
      accountGlob: undefined,
      regionGlob: undefined,
    });
  });
  it('object with account → account-scoped rule', () => {
    expect(parseIgnoreRule({ path: '*.DesiredCount', account: '111111111111' })).toEqual({
      raw: '*.DesiredCount (account:111111111111)',
      pathPattern: '*.DesiredCount',
      stackGlob: undefined,
      accountGlob: '111111111111',
      regionGlob: undefined,
    });
  });
  it('object with region → region-scoped rule', () => {
    expect(parseIgnoreRule({ path: '*.DesiredCount', region: 'us-*' })).toEqual({
      raw: '*.DesiredCount (region:us-*)',
      pathPattern: '*.DesiredCount',
      stackGlob: undefined,
      accountGlob: undefined,
      regionGlob: 'us-*',
    });
  });
  it('all three scopes → renders them in stack, account, region order in the note', () => {
    expect(
      parseIgnoreRule({
        path: 'Fn*.x',
        stack: 'Prod*',
        account: '111111111111',
        region: 'ap-northeast-1',
      })
    ).toEqual({
      raw: 'Fn*.x (stack:Prod*, account:111111111111, region:ap-northeast-1)',
      pathPattern: 'Fn*.x',
      stackGlob: 'Prod*',
      accountGlob: '111111111111',
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

  it('a `Parent/*` rule matches a DIRECT construct-path child but NOT a deeper descendant (#842)', () => {
    // A `/` is a real construct-path segment boundary; `Parent/*` means "a direct child",
    // so it must not leak to arbitrarily deep descendants (`Parent/Child/Grandchild`).
    // The rule is LEAF-PINNED (`Parent/*.Policies`): even after the ancestor walk crosses
    // `/` (#903), no `/`-sliced ancestor of `Parent/Child/Grandchild.Policies` ever ends in
    // `.Policies`, so the grandchild still stays drift — like the `*.DesiredCount` bound.
    const child: Finding = {
      tier: 'undeclared',
      logicalId: 'ChildAAAA',
      constructPath: 'MyStack/Parent/Child',
      resourceType: 'AWS::IAM::Role',
      path: 'Policies',
      actual: [{}],
    };
    const grandchild: Finding = {
      tier: 'undeclared',
      logicalId: 'GrandBBBB',
      constructPath: 'MyStack/Parent/Child/Grandchild',
      resourceType: 'AWS::IAM::Role',
      path: 'Policies',
      actual: [{}],
    };
    // direct child (within-stack path `Parent/Child`) is ignored…
    expect(ign([child], 'MyStack', cfg([p('Parent/*.Policies')]))[0]?.tier).toBe('ignored');
    // …but the deeper `Parent/Child/Grandchild` must stay drift (no cross-slash leak)
    expect(ign([grandchild], 'MyStack', cfg([p('Parent/*.Policies')]))[0]?.tier).toBe('undeclared');
  });

  it('an explicit parent rule covers a `/`-subtree leaf finding (#903 exact repro)', () => {
    // The ancestor walk now trims at `/` too, so `MyApi/Res` covers `MyApi/Res/Method.Prop`
    // — symmetric with the `.` behavior. Before #903 the walk never crossed `/`, so a rule
    // on an explicit construct-path parent could not ignore a deeper child.
    const leaf: Finding = {
      tier: 'undeclared',
      logicalId: 'MethodCCCC',
      constructPath: 'MyStack/MyApi/Res/Method',
      resourceType: 'AWS::ApiGateway::Method',
      path: 'Prop',
      actual: { x: 1 },
    };
    expect(ign([leaf], 'MyStack', cfg([p('MyApi/Res')]))[0]?.tier).toBe('ignored');
  });

  it('a bare parent rule covers a deeper `/`-subtree finding', () => {
    // `MyApi` (no wildcard) covers its whole construct-path subtree via the walk.
    const deep: Finding = {
      tier: 'undeclared',
      logicalId: 'DeepDDDD',
      constructPath: 'MyStack/MyApi/Res/Method/Sub',
      resourceType: 'AWS::ApiGateway::Method',
      path: 'Prop',
      actual: { x: 1 },
    };
    expect(ign([deep], 'MyStack', cfg([p('MyApi')]))[0]?.tier).toBe('ignored');
  });

  it('an `added` child whose id is an ARN with `/` is ignorable by its parent rule (#903)', () => {
    // An `added` finding keys on the constructPath `<parent>/<CC-identifier>` with an EMPTY
    // path; a load balancer listener's CC identifier is an ARN full of `/`. Before #903 the
    // `/`-bounded `*` plus the never-cross-`/` walk left it un-ignorable by ANY wildcard.
    const arnChild: Finding = {
      tier: 'added',
      logicalId:
        'MyLb/arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-lb/50dc6c495c0c9188/f2f7dc8efc522ab2',
      constructPath:
        'MyStack/MyLb/arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-lb/50dc6c495c0c9188/f2f7dc8efc522ab2',
      resourceType: 'AWS::ElasticLoadBalancingV2::Listener',
      path: '',
    };
    // ignorable by the bare parent rule…
    expect(ign([arnChild], 'MyStack', cfg([p('MyLb')]))[0]?.tier).toBe('ignored');
    // …and by the `*`-suffixed parent rule (deep coverage comes via the walk, like `.`)
    expect(ign([arnChild], 'MyStack', cfg([p('MyLb/*')]))[0]?.tier).toBe('ignored');
  });

  it('a leaf-pinned `MyApi/*.Prop` rule does NOT ignore a grandchild `.Prop` (#842 spirit)', () => {
    // Symmetric with `*.DesiredCount`: a wildcard with a `.Prop` leaf only matches a DIRECT
    // child's `.Prop`, never a deeper `/`-descendant's — even after the walk crosses `/`.
    const grandchild: Finding = {
      tier: 'undeclared',
      logicalId: 'GrandEEEE',
      constructPath: 'MyStack/MyApi/Res/Method',
      resourceType: 'AWS::ApiGateway::Method',
      path: 'Prop',
      actual: { x: 1 },
    };
    expect(ign([grandchild], 'MyStack', cfg([p('MyApi/*.Prop')]))[0]?.tier).toBe('undeclared');
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
    // it is a DECIDED value and must not still surface under [Potential Drift] / "run record".
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

  it('an `added` rule for `P/a` ignores EXACTLY that resource, never a `.`/`[`-extended sibling (#990)', () => {
    // A whole-resource `added` target is atomic — its identifier's `.` / `[` are DATA, not a
    // property subtree. The ancestor walk must NOT trim there, else a rule for one added
    // resource silently over-suppresses a DIFFERENT added resource whose CC identifier is the
    // first's extended by `.` or `[` (`example` vs `example.com`, `a` vs `a[0]`) — a silent
    // detection hole in the `added` out-of-band feature, created by the user's own `ignore`.
    const added = (parent: string, id: string): Finding => ({
      tier: 'added',
      logicalId: `${parent}/${id}`,
      constructPath: `MyStack/${parent} ▸ ${id}`,
      resourceType: 'AWS::ApiGateway::Resource',
      path: '',
    });
    // the rule the verb writes for added('P','a') is the full literal identifier `P/a`
    const rule = ignoreRuleFor(added('P', 'a'), 'S');
    expect(rule.path).toBe('P/a');
    // it ignores EXACTLY its own resource (WRITE→MATCH round-trip preserved)…
    expect(ign([added('P', 'a')], 'S', cfg([rule]))[0]?.tier).toBe('ignored');
    // …but NOT a distinct sibling whose id extends `P/a` by `.` or `[` (BUG on main: ignored)
    expect(ign([added('P', 'a.b.c')], 'S', cfg([rule]))[0]?.tier).toBe('added');
    expect(ign([added('P', 'a[0]')], 'S', cfg([rule]))[0]?.tier).toBe('added');
    // …nor a plain hyphen-extended sibling (already correct on main; guard against regression)
    expect(ign([added('P', 'a-x')], 'S', cfg([rule]))[0]?.tier).toBe('added');
    // a dotted-identifier example (apex vs subdomain): a rule for `CDN/example` must not
    // swallow the distinct added resource `CDN/example.com`
    const cdnRule = ignoreRuleFor(added('CDN', 'example'), 'S');
    expect(ign([added('CDN', 'example')], 'S', cfg([cdnRule]))[0]?.tier).toBe('ignored');
    expect(ign([added('CDN', 'example.com')], 'S', cfg([cdnRule]))[0]?.tier).toBe('added');
  });

  it('an `added` rule for a `/`-bearing CC identifier never swallows a `/`-extended sibling (#1061)', () => {
    // #990 residue: the identifier itself can contain `/` (a Cognito ResourceServer URI
    // identifier `https://api.example.com` vs `https://api.example.com/v2`), and the old
    // wholeResource walk trimmed at EVERY `/` — so a rule for one added resource silently
    // over-suppressed a DIFFERENT sibling whose id is the first extended by `/…`.
    const added = (parent: string, id: string): Finding => ({
      tier: 'added',
      logicalId: `${parent}/${id}`,
      constructPath: `MyStack/${parent} ▸ ${id}`,
      resourceType: 'AWS::Cognito::UserPoolResourceServer',
      path: '',
    });
    const a = added('Pool', 'us-east-1_ABC|https://api.example.com');
    const b = added('Pool', 'us-east-1_ABC|https://api.example.com/v2');
    // rule written by the verb for `a` is the full literal identifier (no glob metachars)
    const rule = ignoreRuleFor(a, 'MyStack');
    expect(rule.path).toBe('Pool/us-east-1_ABC|https://api.example.com');
    // applying it over BOTH siblings ignores exactly `a`, leaving the extended sibling `b`
    const out = ign([a, b], 'MyStack', cfg([rule]));
    expect(out[0]?.tier).toBe('ignored');
    expect(out[1]?.tier).toBe('added'); // BUG on main: wrongly 'ignored'
    // symmetric: a rule for the LONGER `b` must not swallow the shorter `a` either (already
    // correct, but the full-target-only match must stay exact)
    const ruleB = ignoreRuleFor(b, 'MyStack');
    const out2 = ign([a, b], 'MyStack', cfg([ruleB]));
    expect(out2[0]?.tier).toBe('added');
    expect(out2[1]?.tier).toBe('ignored');
    // #903 preserved: the bare PARENT rule `Pool` still covers a child whose id has `/`
    expect(ign([b], 'MyStack', cfg([p('Pool')]))[0]?.tier).toBe('ignored');
    // #990 preserved: a `.`-extended sibling of `a`'s identifier is still not swallowed
    const dotSibling = added('Pool', 'us-east-1_ABC|https://api.example.com.bak');
    expect(ign([dotSibling], 'MyStack', cfg([rule]))[0]?.tier).toBe('added');
  });

  it('a bare PARENT-resource rule still covers its added children across `/` (#903 not regressed)', () => {
    // The `/`-boundary walk (parent-RESOURCE coverage) survives the #990 fix — only the
    // `.`/`[` within-identifier trim is dropped. A rule on the parent `MyLb` still ignores an
    // added listener child whose CC identifier is an ARN full of `/`.
    const arnChild: Finding = {
      tier: 'added',
      logicalId:
        'MyLb/arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-lb/50dc6c495c0c9188/f2f7dc8efc522ab2',
      constructPath:
        'MyStack/MyLb/arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-lb/50dc6c495c0c9188/f2f7dc8efc522ab2',
      resourceType: 'AWS::ElasticLoadBalancingV2::Listener',
      path: '',
    };
    expect(ign([arnChild], 'MyStack', cfg([p('MyLb')]))[0]?.tier).toBe('ignored');
    expect(ign([arnChild], 'MyStack', cfg([p('MyLb/*')]))[0]?.tier).toBe('ignored');
  });

  it('the NON-added property subtree walk is unchanged by the #990 fix (`.`/`[` still trims)', () => {
    // A real property path keeps its subtree coverage: a parent-property rule `Role.Policies`
    // still ignores `Role.Policies[0].X` (the `.`/`[` walk that #990 only disables for added).
    expect(
      ign([undeclared('Role', 'Policies[0].X')], 'S', cfg([p('Role.Policies')]))[0]?.tier
    ).toBe('ignored');
    expect(
      ign([declared('Role', 'Policies.0.PolicyName')], 'S', cfg([p('Role.Policies')]))[0]?.tier
    ).toBe('ignored');
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

  it('matches a Stage-nested constructPath (multi-slash: Stage/Stack/... — CDK Stages)', () => {
    // In a CDK `Stage`, aws:cdk:path is `<stage>/<stack>/<...>` (slash-separated) while the
    // CFn stack name is `<stage>-<stack>` (hyphen). So a finding's constructPath carries
    // EXTRA leading `/`-segments vs a plain stack. `matchesPathGlob` bounds `*` on `.`/`[`
    // only — NOT `/` — so both a full-path rule and a `*.prop` glob still match across the
    // stage/stack slashes, and a parent rule still covers the subtree. This locks that in
    // (existing tests only exercised a single-level `MyStack/ApiRole`).
    const f: Finding = {
      tier: 'declared',
      logicalId: 'ParameterGroup9AB12C',
      constructPath: 'my-app/Rds/Database/ParameterGroup',
      resourceType: 'AWS::RDS::DBClusterParameterGroup',
      path: 'Parameters.autocommit',
      physicalId: 'pg-phys',
      desired: '0',
      actual: '1',
    };
    // the CFn stack name is stage-qualified (my-app-Rds); rules are matched under it
    const atStack = (config: CdkrdConfig): Finding[] =>
      applyIgnores([f], sc('my-app-Rds', ACCT, 'us-east-1'), config);
    // (1) the full construct-path rule the `ignore` verb writes — literal exact match
    expect(
      atStack(cfg([p('my-app/Rds/Database/ParameterGroup.Parameters.autocommit')]))[0]?.tier
    ).toBe('ignored');
    // (2) a `*.prop` glob whose leading `*` spans the whole stage/stack construct-path prefix
    expect(atStack(cfg([p('*.Parameters.autocommit')]))[0]?.tier).toBe('ignored');
    // (3) a `*/`-anchored glob crossing the multi-slash prefix
    expect(atStack(cfg([p('*/ParameterGroup.Parameters.autocommit')]))[0]?.tier).toBe('ignored');
    // (4) a PARENT rule ignores the subtree leaf via the ancestor walk
    expect(atStack(cfg([p('my-app/Rds/Database/ParameterGroup.Parameters')]))[0]?.tier).toBe(
      'ignored'
    );
    // (5) the logicalId target still works regardless of the construct path
    expect(atStack(cfg([p('ParameterGroup*.Parameters.autocommit')]))[0]?.tier).toBe('ignored');
    // NOT over-suppressed: a rule for a SIBLING resource in the same stage must not match
    expect(atStack(cfg([p('*/OtherResource.Parameters.autocommit')]))[0]?.tier).toBe('declared');
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

  it('account-scoped object rule applies only in matching accounts', () => {
    // stack-name uniqueness only holds within one account, so without the account axis a
    // `stack: "Prod*"` rule would leak into a same-named stack in another account.
    const rule = cfg([p('*.DesiredCount', { account: '111111111111' })]);
    const f = () => [declared('Svc', 'DesiredCount')];
    expect(applyIgnores(f(), sc('S', '111111111111', 'us-east-1'), rule)[0]?.tier).toBe('ignored');
    expect(applyIgnores(f(), sc('S', '222222222222', 'us-east-1'), rule)[0]?.tier).toBe('declared');
  });

  it('account scope accepts a glob', () => {
    const rule = cfg([p('*.DesiredCount', { account: '1111*' })]);
    const f = () => [declared('Svc', 'DesiredCount')];
    expect(applyIgnores(f(), sc('S', '111199998888', 'us-east-1'), rule)[0]?.tier).toBe('ignored');
    expect(applyIgnores(f(), sc('S', '222200001111', 'us-east-1'), rule)[0]?.tier).toBe('declared');
  });

  it('region-scoped object rule applies only in matching regions', () => {
    const rule = cfg([p('*.DesiredCount', { region: 'us-*' })]);
    const f = () => [declared('Svc', 'DesiredCount')];
    expect(applyIgnores(f(), sc('S', ACCT, 'us-east-1'), rule)[0]?.tier).toBe('ignored');
    expect(applyIgnores(f(), sc('S', ACCT, 'us-west-2'), rule)[0]?.tier).toBe('ignored');
    expect(applyIgnores(f(), sc('S', ACCT, 'ap-northeast-1'), rule)[0]?.tier).toBe('declared');
  });

  it('stack, account AND region scope must ALL match (independent axes)', () => {
    const rule = cfg([
      p('*.DesiredCount', { stack: 'Prod*', account: '111111111111', region: 'ap-northeast-1' }),
    ]);
    const f = () => [declared('Svc', 'DesiredCount')];
    const tier = (stack: string, acct: string, region: string) =>
      applyIgnores(f(), sc(stack, acct, region), rule)[0]?.tier;
    expect(tier('ProdApi', '111111111111', 'ap-northeast-1')).toBe('ignored');
    expect(tier('ProdApi', '111111111111', 'us-east-1')).toBe('declared'); // wrong region
    expect(tier('ProdApi', '222222222222', 'ap-northeast-1')).toBe('declared'); // wrong account
    expect(tier('DevApi', '111111111111', 'ap-northeast-1')).toBe('declared'); // wrong stack
  });

  it('the scoped rule note names its scope', () => {
    const [f] = applyIgnores(
      [declared('Svc', 'DesiredCount')],
      sc('S', ACCT, 'us-east-1'),
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

describe('isUniversalPath (#842 all-wildcard guard)', () => {
  it('is true for a pure-wildcard/separator path (would ignore everything)', () => {
    for (const path of ['*', '**', '***', '*.*', '?', '??', '*.?', '*[*]', '*.*[*]', '.'])
      expect(isUniversalPath(path), path).toBe(true);
  });
  it('is false as soon as the path names any literal segment', () => {
    for (const path of ['Foo', 'Foo*', '*.DesiredCount', 'MyApi/*', '*/ApiRole.Policies', 'a?'])
      expect(isUniversalPath(path), path).toBe(false);
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
    await writeFile('.cdkrd/ignore.yaml', content, 'utf8');
  };

  it('absent file → empty config (no file, nothing to ignore)', async () => {
    expect(await loadConfig()).toEqual({ ignore: [] });
  });

  it('a comments-only / empty file → empty config (the verb writes a header before any rule)', async () => {
    await write('# just a header, no rules yet\n');
    expect(await loadConfig()).toEqual({ ignore: [] });
  });

  it('valid YAML loads object rules (unscoped + fully scoped)', async () => {
    await write(
      [
        'ignore:',
        '  - path: "*.DesiredCount"',
        '  - path: "*.Cpu"',
        '    stack: Prod*',
        '    account: "111111111111"',
        '    region: us-*',
      ].join('\n')
    );
    expect(await loadConfig()).toEqual({
      ignore: [
        { path: '*.DesiredCount' },
        { path: '*.Cpu', stack: 'Prod*', account: '111111111111', region: 'us-*' },
      ],
    });
  });

  it('still reads a legacy all-JSON file (YAML is a JSON superset)', async () => {
    await write('{ "ignore": [{ "path": "*.DesiredCount" }] }');
    expect(await loadConfig()).toEqual({ ignore: [{ path: '*.DesiredCount' }] });
  });

  it('mapping without ignore → empty ignore', async () => {
    await write('other: 1\n');
    await expect(loadConfig()).rejects.toThrow(/unknown key\(s\) "other"/);
  });

  it('invalid YAML → throws (fail-fast, not silent)', async () => {
    await write('ignore: [unterminated');
    await expect(loadConfig()).rejects.toThrow(/not valid YAML/);
  });

  it('an unresolved git merge-conflict marker → error carries the line/column diagnostic (#1049)', async () => {
    // The #1 real-world damage to this shared merge-magnet file: a conflict marker left
    // by a botched merge. The bare "is not valid YAML" gives the user nowhere to look;
    // the fix appends the prettyErrors diagnostic, which pins the exact line + column.
    await write(
      [
        'ignore:',
        '<<<<<<< HEAD',
        '  - path: A.x',
        '=======',
        '  - path: B.x',
        '>>>>>>> branch',
      ].join('\n')
    );
    let msg = '';
    try {
      await loadConfig();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/not valid YAML/); // prefix preserved for continuity
    expect(msg).toMatch(/line \d+, column \d+/); // actionable location, not the bare string
  });

  it('an unquoted "*"-glob path parses as a YAML alias → error surfaces the alias diagnostic + quote hint (#1049)', async () => {
    // `- path: *.DesiredCount` collects ZERO doc.errors, then toJS() throws on the `*`
    // alias. The old catch swallowed the message; the fix surfaces it AND adds the
    // documented remedy (quote a glob that starts with `*` / `?`).
    await write('ignore:\n  - path: *.DesiredCount\n');
    let msg = '';
    try {
      await loadConfig();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/not valid YAML/); // prefix preserved for continuity
    expect(msg).toMatch(/alias/i); // the swallowed diagnostic is now surfaced
    expect(msg).toMatch(/quoted/); // the actionable quote-glob hint
  });

  it('ignore not a sequence → throws', async () => {
    await write('ignore:\n  path: x\n');
    await expect(loadConfig()).rejects.toThrow(/"ignore" must be an array/);
  });

  it('a bare string entry → throws (every rule is a mapping now)', async () => {
    await write('ignore:\n  - "*.DesiredCount"\n');
    await expect(loadConfig()).rejects.toThrow(/"ignore"\[0\] must be a mapping/);
  });

  it('a non-mapping entry → throws', async () => {
    await write('ignore:\n  - 1\n');
    await expect(loadConfig()).rejects.toThrow(/"ignore"\[0\] must be a mapping/);
  });

  it('a mapping entry without "path" → throws', async () => {
    await write('ignore:\n  - stack: Prod*\n');
    await expect(loadConfig()).rejects.toThrow(/"path" is required and must be a string/);
  });

  it('an empty "path" → throws (a silent no-op rule must not masquerade as active, WAVE23)', async () => {
    await write('ignore:\n  - path: ""\n');
    await expect(loadConfig()).rejects.toThrow(/"path" must not be empty/);
  });

  it('an all-wildcard "path" → throws (would ignore every finding, #842)', async () => {
    for (const badPath of ['*', '**', '*.*', '?', '*/*', '*.*[*]']) {
      await write(`ignore:\n  - path: "${badPath}"\n`);
      await expect(loadConfig(), badPath).rejects.toThrow(/must not be an all-wildcard pattern/);
    }
  });

  it('a "path" with at least one literal segment is accepted (not over-rejected)', async () => {
    await write('ignore:\n  - path: "MyApi/*"\n  - path: "*.DesiredCount"\n  - path: "Foo*"\n');
    expect(await loadConfig()).toEqual({
      ignore: [{ path: 'MyApi/*' }, { path: '*.DesiredCount' }, { path: 'Foo*' }],
    });
  });

  it('a mapping entry with a non-string scope → throws', async () => {
    await write('ignore:\n  - path: x\n    region: 1\n');
    await expect(loadConfig()).rejects.toThrow(/"region" must be a string/);
  });

  it('an unknown key on a mapping entry → throws (typo guard, e.g. "reigon")', async () => {
    await write('ignore:\n  - path: x\n    reigon: us-*\n');
    await expect(loadConfig()).rejects.toThrow(/"ignore"\[0\]: unknown key\(s\) "reigon"/);
  });

  it('top-level sequence → throws (must be a mapping)', async () => {
    await write('- path: "*.DesiredCount"\n');
    await expect(loadConfig()).rejects.toThrow(/must be a YAML mapping/);
  });

  it('unknown top-level key → throws (a typo like "ignroe" must not silently disable rules)', async () => {
    await write('ignroe:\n  - path: "*.DesiredCount"\n');
    await expect(loadConfig()).rejects.toThrow(/unknown key\(s\) "ignroe" — known keys: "ignore"/);
  });

  it('unknown key alongside a valid one → still throws, listing only the unknown', async () => {
    await write('ignore: []\nconcurency: 4\n');
    await expect(loadConfig()).rejects.toThrow(/unknown key\(s\) "concurency"/);
  });

  // #1291 — a Windows-authored UTF-16 ignore.yaml (PowerShell 5.1 `Out-File` / `> file`
  // default) read as 'utf8' becomes NUL-interleaved mojibake the YAML parser reads as a
  // single scalar, so a valid mapping was mis-diagnosed as "must be a YAML mapping". The
  // BOM/UTF-16 sniff (mirroring resolveApp #1076) now decodes these correctly.
  const YAML = 'ignore:\n  - path: Res.Prop\n';
  const EXPECTED = { ignore: [{ path: 'Res.Prop' }] };
  // write a raw Buffer (bypasses the utf8 `write` helper) at .cdkrd/ignore.yaml
  const writeBytes = async (buf: Buffer) => {
    await mkdir('.cdkrd', { recursive: true });
    await writeFile('.cdkrd/ignore.yaml', buf);
  };
  const toUtf16be = (le: Buffer): Buffer => {
    const be = Buffer.alloc(le.length);
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1]!;
      be[i + 1] = le[i]!;
    }
    return be;
  };

  it('reads a UTF-16 LE ignore.yaml with a BOM (PowerShell 5.1 `Out-File` default)', async () => {
    await writeBytes(Buffer.from(`﻿${YAML}`, 'utf16le'));
    expect(await loadConfig()).toEqual(EXPECTED);
  });

  it('reads a UTF-16 LE ignore.yaml without a BOM', async () => {
    await writeBytes(Buffer.from(YAML, 'utf16le'));
    expect(await loadConfig()).toEqual(EXPECTED);
  });

  it('reads a UTF-16 BE ignore.yaml (with a BOM)', async () => {
    await writeBytes(toUtf16be(Buffer.from(`﻿${YAML}`, 'utf16le')));
    expect(await loadConfig()).toEqual(EXPECTED);
  });

  it('reads a UTF-8 BOM ignore.yaml (BOM stripped, uniform with cdk.json)', async () => {
    await writeBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(YAML, 'utf8')]));
    expect(await loadConfig()).toEqual(EXPECTED);
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

  it('writes the WITHIN-stack path when given the stack name (matches what the report shows)', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'ApiRole1234ABCD',
      constructPath: 'MyStack/ApiRole',
      resourceType: 'AWS::IAM::Role',
      path: 'Policies',
      actual: [{}],
    };
    // plain stack + a CDK Stage both collapse to the same within-stack path (the stack
    // scope is stamped on, but no account/region were passed here so those stay omitted)
    expect(ignoreRuleFor(f, 'MyStack')).toEqual({ path: 'ApiRole.Policies', stack: 'MyStack' });
    expect(ignoreRuleFor({ ...f, constructPath: 'my-app/Rds/ApiRole' }, 'my-app-Rds')).toEqual({
      path: 'ApiRole.Policies',
      stack: 'my-app-Rds',
    });
    // round-trip: the within-stack rule the verb now writes matches the finding it came from
    expect(ign([f], 'MyStack', cfg([ignoreRuleFor(f, 'MyStack')]))[0]?.tier).toBe('ignored');
    const staged: Finding = { ...f, constructPath: 'my-app/Rds/ApiRole' };
    expect(ign([staged], 'my-app-Rds', cfg([ignoreRuleFor(staged, 'my-app-Rds')]))[0]?.tier).toBe(
      'ignored'
    );
    // and an OLDER full-path rule (pre-strip) still matches (back-compat)
    expect(ign([f], 'MyStack', cfg([p('MyStack/ApiRole.Policies')]))[0]?.tier).toBe('ignored');
  });

  it('falls back to logicalId when constructPath is absent (non-CDK stack)', () => {
    expect(ignoreRuleFor(declared('ApiRole', 'Policies'))).toEqual({ path: 'ApiRole.Policies' });
  });

  it('falls back to logicalId when the within-stack path strips to empty (stack-root construct path) (#991)', () => {
    // `withinStackPath('MyStack/', 'MyStack')` returns '' — with an empty finding path that
    // would strip the id to '' and produce `rule.path === ''`, the empty-path poison pill.
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'ApiRole1234ABCD',
      constructPath: 'MyStack/',
      resourceType: 'AWS::IAM::Role',
      path: '',
    };
    // the id falls back to the always-present logicalId, so the path is never empty
    expect(ignoreRuleFor(f, 'MyStack')).toEqual({ path: 'ApiRole1234ABCD', stack: 'MyStack' });
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

  it('keys an `added` finding on the unique logicalId, NOT the non-unique display label (#802)', () => {
    // A Cognito UserPoolClient added child: its constructPath label is the ClientName,
    // which is NOT unique — writing a rule against it would silence EVERY same-named
    // client under the pool (present and future). The logicalId form
    // `<parent>/<CC-identifier>` is the unique identity — that is what must be written.
    const addedFinding: Finding = {
      tier: 'added',
      logicalId: 'UserPool/us-east-1_abc123|7clientid7',
      constructPath: 'MyStack/UserPool ▸ my-app-client',
      resourceType: 'AWS::Cognito::UserPoolClient',
      path: '',
    };
    // NOT the label form 'MyStack/UserPool ▸ my-app-client'
    expect(ignoreRuleFor(addedFinding)).toEqual({ path: 'UserPool/us-east-1_abc123|7clientid7' });
    // stamping a stack scope must not re-introduce the label either
    expect(ignoreRuleFor(addedFinding, 'MyStack')).toEqual({
      path: 'UserPool/us-east-1_abc123|7clientid7',
      stack: 'MyStack',
    });
    // and the rule the verb writes round-trips: it ignores exactly this finding
    expect(
      ign([addedFinding], 'MyStack', cfg([ignoreRuleFor(addedFinding, 'MyStack')]))[0]?.tier
    ).toBe('ignored');
  });

  it('an `added` finding whose label carries a glob metachar keys on logicalId (no accidental wildcard) (#802)', () => {
    // An SNS https subscription's label `https https://host/path?q=1` has a `?` — as a
    // path glob the `?` is a single-char wildcard, so a label-based rule would over-match.
    // The logicalId form is a literal composite id with no glob semantics leaking in.
    const addedFinding: Finding = {
      tier: 'added',
      logicalId: 'Topic/arn:aws:sns:us-east-1:111111111111:T:sub-uuid',
      constructPath: 'MyStack/Topic ▸ https https://host/path?q=1',
      resourceType: 'AWS::SNS::Subscription',
      path: '',
    };
    const rule = ignoreRuleFor(addedFinding);
    expect(rule.path).toBe('Topic/arn:aws:sns:us-east-1:111111111111:T:sub-uuid');
    expect(rule.path).not.toContain('?');
  });

  it('escapes a LITERAL `*` in the finding path so the rule matches ONLY that finding (#776)', () => {
    // An API Gateway MethodSettings key from `HttpMethod: "*"` — the `[*]` is a REAL bracket
    // key, not a wildcard. Written verbatim the rule would glob every HTTP method's sibling;
    // ignoreRuleFor must escape the `*` so the rule matches this finding and no other.
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'Stage0661E8F1',
      resourceType: 'AWS::ApiGateway::Stage',
      path: 'MethodSettings[*].CacheTtlInSeconds',
      actual: 300,
    };
    const rule = ignoreRuleFor(f);
    expect(rule.path).toBe('Stage0661E8F1.MethodSettings[\\*].CacheTtlInSeconds');
    // it ignores the exact finding it came from (round-trip)...
    expect(ign([f], 'S', cfg([rule]))[0]?.tier).toBe('ignored');
    // ...but NOT a sibling method key that the un-escaped `*` would have swallowed
    const sibling: Finding = { ...f, path: 'MethodSettings[GET].CacheTtlInSeconds' };
    expect(ign([sibling], 'S', cfg([rule]))[0]?.tier).toBe('undeclared');
  });

  it('escapes a literal `*` in a free-form key (S3 lifecycle Id) so the rule is not over-broad (#776)', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'B',
      resourceType: 'AWS::S3::Bucket',
      path: 'Rules[clean*tmp].Status',
      actual: 'Enabled',
    };
    const rule = ignoreRuleFor(f);
    expect(rule.path).toBe('B.Rules[clean\\*tmp].Status');
    expect(ign([f], 'S', cfg([rule]))[0]?.tier).toBe('ignored');
    const sibling: Finding = { ...f, path: 'Rules[cleanXYZtmp].Status' };
    expect(ign([sibling], 'S', cfg([rule]))[0]?.tier).toBe('undeclared');
  });
});

describe('escapeGlobLiterals (#776)', () => {
  it('escapes `*`, `?`, and `\\` (backslash first) and leaves separators alone', () => {
    expect(escapeGlobLiterals('a*b?c')).toBe('a\\*b\\?c');
    expect(escapeGlobLiterals('a\\b')).toBe('a\\\\b'); // `\` doubled — escaped first
    expect(escapeGlobLiterals('a\\*b')).toBe('a\\\\\\*b'); // `\` then `*`, not `\\*`
    expect(escapeGlobLiterals('X.Y[key]/Z')).toBe('X.Y[key]/Z'); // separators untouched
  });
});

describe('mergeIgnoreRules', () => {
  it('appends new rules to the END (append-only — the user owns the order)', () => {
    const r = mergeIgnoreRules([p('B.x')], [p('A.y'), p('C.z')]);
    expect(r.merged).toEqual([p('B.x'), p('A.y'), p('C.z')]); // existing first, new appended — NOT sorted
    expect(r.added).toEqual([p('A.y'), p('C.z')]);
    expect(r.alreadyPresent).toEqual([]);
  });

  it('drops rules already present (idempotent) and de-dupes the incoming list', () => {
    const r = mergeIgnoreRules([p('A.y')], [p('A.y'), p('B.x'), p('B.x')]);
    expect(r.merged).toEqual([p('A.y'), p('B.x')]);
    expect(r.added).toEqual([p('B.x')]);
    expect(r.alreadyPresent).toEqual([p('A.y')]);
  });

  it('all-already-present → no additions, merged equals existing (order untouched)', () => {
    const r = mergeIgnoreRules([p('B.x'), p('A.y')], [p('A.y')]);
    expect(r.added).toEqual([]);
    expect(r.alreadyPresent).toEqual([p('A.y')]);
    expect(r.merged).toEqual([p('B.x'), p('A.y')]); // original order preserved
  });

  it('a scoped rule does NOT collide with the unscoped one for the same path', () => {
    const scoped = p('*.Cpu', { region: 'us-*' });
    const r = mergeIgnoreRules([p('*.Cpu')], [scoped]);
    // same path, different scope → a distinct rule, purely additive
    expect(r.added).toEqual([scoped]);
    expect(r.merged).toEqual([p('*.Cpu'), scoped]);
  });

  it('account is part of a rule identity (a rule differing only by account is distinct)', () => {
    const a = p('*.Cpu', { account: '111111111111' });
    const b = p('*.Cpu', { account: '222222222222' });
    const r = mergeIgnoreRules([a], [b]);
    expect(r.added).toEqual([b]);
    expect(r.merged).toEqual([a, b]);
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

  it('creates .cdkrd/ignore.yaml (and the dir) with a header comment when absent', async () => {
    const r = await addIgnoreRules([p('Svc.DesiredCount')]);
    expect(r.added).toEqual([p('Svc.DesiredCount')]);
    expect(r.path).toBe('.cdkrd/ignore.yaml');
    const raw = await readFile('.cdkrd/ignore.yaml', 'utf8');
    expect(raw).toContain('# cdkrd ignore rules');
    expect(await loadConfig()).toEqual({ ignore: [{ path: 'Svc.DesiredCount' }] });
  });

  it('appends to an existing config at the END (append-only, prior rules + order preserved)', async () => {
    await mkdir('.cdkrd', { recursive: true });
    await writeFile('.cdkrd/ignore.yaml', 'ignore:\n  - path: Zeta.x\n', 'utf8');
    const r = await addIgnoreRules([p('Alpha.y')]);
    expect(r.added).toEqual([p('Alpha.y')]);
    expect((await loadConfig()).ignore).toEqual([{ path: 'Zeta.x' }, { path: 'Alpha.y' }]);
  });

  it('PRESERVES a hand-authored comment on append (the whole point of YAML)', async () => {
    await mkdir('.cdkrd', { recursive: true });
    await writeFile(
      '.cdkrd/ignore.yaml',
      '# DesiredCount is managed by Application Auto Scaling\nignore:\n  - path: "*.DesiredCount"\n',
      'utf8'
    );
    await addIgnoreRules([p('Alpha.y')]);
    const raw = await readFile('.cdkrd/ignore.yaml', 'utf8');
    expect(raw).toContain('# DesiredCount is managed by Application Auto Scaling');
    expect(raw).toContain('Alpha.y');
    // both rules present, original first (append-only)
    expect((await loadConfig()).ignore).toEqual([{ path: '*.DesiredCount' }, { path: 'Alpha.y' }]);
  });

  it('preserves a hand-authored scoped rule on append', async () => {
    await mkdir('.cdkrd', { recursive: true });
    await writeFile('.cdkrd/ignore.yaml', 'ignore:\n  - path: "*.Cpu"\n    region: us-*\n', 'utf8');
    await addIgnoreRules([p('Alpha.y')]);
    expect((await loadConfig()).ignore).toEqual([
      { path: '*.Cpu', region: 'us-*' },
      { path: 'Alpha.y' },
    ]);
  });

  it('all-already-present → leaves the file byte-for-byte untouched', async () => {
    await mkdir('.cdkrd', { recursive: true });
    const original = 'ignore:\n  - path: A.y\n';
    await writeFile('.cdkrd/ignore.yaml', original, 'utf8');
    const r = await addIgnoreRules([p('A.y')]);
    expect(r.added).toEqual([]);
    expect(r.alreadyPresent).toEqual([p('A.y')]);
    // not rewritten — the original bytes survive (comments + layout intact)
    expect(await readFile('.cdkrd/ignore.yaml', 'utf8')).toBe(original);
  });

  it('REJECTS a universal ("*/*") rule before writing — no poison pill, next loadConfig stays clean (#991)', async () => {
    await expect(addIgnoreRules([p('*/*', { stack: 'MyStack' })])).rejects.toThrow(/all-wildcard/);
    // the write-side guard fired BEFORE writeFile, so the file was never created / bricked
    await expect(loadConfig()).resolves.toEqual({ ignore: [] });
  });

  it('REJECTS an empty-path ("") rule before writing — no poison pill (#991)', async () => {
    await expect(addIgnoreRules([p('', { stack: 'MyStack' })])).rejects.toThrow(
      /must not be empty/
    );
    await expect(loadConfig()).resolves.toEqual({ ignore: [] });
  });

  it('a bad rule does not clobber an existing valid config (rejected before writeFile) (#991)', async () => {
    await mkdir('.cdkrd', { recursive: true });
    const original = 'ignore:\n  - path: Good.x\n';
    await writeFile('.cdkrd/ignore.yaml', original, 'utf8');
    await expect(addIgnoreRules([p('**')])).rejects.toThrow(/all-wildcard/);
    // original bytes untouched, config still loads
    expect(await readFile('.cdkrd/ignore.yaml', 'utf8')).toBe(original);
    expect((await loadConfig()).ignore).toEqual([{ path: 'Good.x' }]);
  });

  it('writes the scope keys in canonical order (path, stack, account, region)', async () => {
    await addIgnoreRules([
      p('Svc.DesiredCount', { region: 'us-*', stack: 'Prod*', account: '111111111111' }),
    ]);
    const raw = await readFile('.cdkrd/ignore.yaml', 'utf8');
    const order = ['path', 'stack', 'account', 'region'].map((k) => raw.indexOf(`${k}:`));
    expect(order).toEqual([...order].sort((a, b) => a - b)); // ascending = canonical order
  });

  // ── atomic write + race narrowing (#759) ──────────────────────────────────────────────
  it('replaces an existing config via tmp+rename, not an in-place overwrite (#759)', async () => {
    // The atomic write goes through a SIBLING temp file then `rename`s it over the target,
    // so a reader never sees a half-written file. A read-only existing CONFIG_PATH is the
    // deterministic discriminator: an in-place `writeFile(CONFIG_PATH, …)` (the buggy path)
    // opens the target for writing and fails EACCES; a tmp+rename writes a NEW file and
    // renames it over the read-only one (POSIX `rename` needs directory write, not file
    // write, permission) — so the atomic version SUCCEEDS where the in-place one cannot.
    if (process.getuid?.() === 0) return; // root ignores read-only perms — skip the discriminator
    await mkdir('.cdkrd', { recursive: true });
    const original = 'ignore:\n  - path: Good.x\n';
    await writeFile('.cdkrd/ignore.yaml', original, 'utf8');
    await chmod('.cdkrd/ignore.yaml', 0o444); // read-only target — in-place writeFile can't touch it
    try {
      // must NOT throw: the atomic path renames over the read-only file
      await addIgnoreRules([p('Alpha.y')]);
      expect((await loadConfig()).ignore).toEqual([{ path: 'Good.x' }, { path: 'Alpha.y' }]);
      // and no `.tmp` litter is left behind on success
      const left = await readdir('.cdkrd');
      expect(left.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      await chmod('.cdkrd/ignore.yaml', 0o644).catch(() => {});
    }
  });

  it('a fresh write lands a complete, valid config and leaves no partial/tmp file (#759)', async () => {
    // A crash mid-write must never leave a TRUNCATED-but-valid config (a truncated bare
    // scalar `path: Api` over-matches). On a clean write the final path is the full config
    // and no half-written `.tmp` sibling survives.
    await addIgnoreRules([p('Svc.DesiredCount')]);
    expect(await loadConfig()).toEqual({ ignore: [{ path: 'Svc.DesiredCount' }] });
    const left = await readdir('.cdkrd');
    expect(left.filter((f) => f.endsWith('.tmp'))).toEqual([]); // no orphaned temp file
    expect(left).toContain('ignore.yaml');
  });

  it('preserves comments through the atomic write (round-trip is unchanged by tmp+rename) (#759)', async () => {
    // The tmp+rename change touches only HOW the bytes hit disk, not WHAT bytes — the
    // comment-preserving append must still hold end to end.
    await mkdir('.cdkrd', { recursive: true });
    await writeFile(
      '.cdkrd/ignore.yaml',
      '# WHY: managed by Application Auto Scaling\nignore:\n  - path: "*.DesiredCount"\n',
      'utf8'
    );
    await addIgnoreRules([p('Alpha.y')]);
    const raw = await readFile('.cdkrd/ignore.yaml', 'utf8');
    expect(raw).toContain('# WHY: managed by Application Auto Scaling');
    expect(raw).toContain('Alpha.y');
    expect((await loadConfig()).ignore).toEqual([{ path: '*.DesiredCount' }, { path: 'Alpha.y' }]);
  });

  it('sequential appends from separate calls each build on the freshest on-disk state (#759)', async () => {
    // The re-read-merge means each write is built from the CURRENT on-disk config, not a
    // snapshot captured earlier. Sequential appends therefore accumulate — the mechanism the
    // race-narrowing relies on: a write never drops rules that reached disk after this call
    // began. (True parallelism can still lose an update without a lock — the fix NARROWS the
    // window per the issue, it does not add heavy locking.)
    await mkdir('.cdkrd', { recursive: true });
    await writeFile('.cdkrd/ignore.yaml', 'ignore:\n  - path: Base.x\n', 'utf8');
    await addIgnoreRules([p('One.y')]);
    await addIgnoreRules([p('Two.y')]);
    await addIgnoreRules([p('Three.y')]);
    expect((await loadConfig()).ignore).toEqual([
      { path: 'Base.x' },
      { path: 'One.y' },
      { path: 'Two.y' },
      { path: 'Three.y' },
    ]);
  });

  it('a concurrent append that lands on disk after our load is preserved by the re-read (#759)', async () => {
    // Simulate a peer process that appends a rule AFTER this process has already loaded the
    // config but BEFORE it writes: kick off addIgnoreRules, and — because the re-read reads
    // the file again right before writing — a rule written to disk in that window is carried
    // forward, not clobbered. We approximate the interleave deterministically by seeding a
    // pre-existing rule that stands in for the "peer's" concurrent append: the re-read must
    // include it in the merged output alongside ours.
    await mkdir('.cdkrd', { recursive: true });
    await writeFile('.cdkrd/ignore.yaml', 'ignore:\n  - path: Peer.appended\n', 'utf8');
    await addIgnoreRules([p('Mine.z')]);
    // both the peer's rule and ours land — the write was built from the re-read, not a write
    // that overwrote the file with only our rule.
    expect((await loadConfig()).ignore).toEqual([{ path: 'Peer.appended' }, { path: 'Mine.z' }]);
  });

  it('builds the write AND the dedupe from ONE re-read snapshot — a peer rule already on disk is not re-appended as a duplicate (#1290)', async () => {
    // The #759 re-read narrowing is only sound when the WRITE basis (`existingRaw`, re-emitted
    // with comments) and the DEDUPE basis come from the SAME snapshot. The old code did TWO
    // separate reads before writing: `existingRaw` = one readFile, then a SECOND `loadConfig()`
    // (another readFile) used ONLY for dedupe. When those two reads observe DIFFERENT bytes —
    // a concurrent `cdkrd` appending a rule between them — the dedupe basis and the write basis
    // disagree, and the merge decision (what counts as "new") is computed against a snapshot
    // that is not the one being written. Here a peer appends OUR rule (`Mine.z`) to disk: it is
    // present in `existingRaw` (the write basis) but ABSENT from the stale second read (the
    // dedupe basis), so the old code judged `Mine.z` new and appended it ON TOP of the copy
    // that already had it — a DUPLICATE. The fix derives the dedupe basis from
    // `parseConfigRaw(existingRaw)` (one snapshot), so the peer's `Mine.z` is seen as present
    // and the write is a no-op. We script the sequence of on-disk-config reads to reproduce the
    // exact interleave the issue names.
    await mkdir('.cdkrd', { recursive: true });
    const raw1 = 'ignore:\n  - path: Base.x\n';
    // The peer process, racing us, appends OUR rule to disk in the window between our reads.
    const raw2 = `${raw1}  - path: Mine.z\n`;
    // Seed the REAL file with the peer-included state (raw2) so the final loadConfig assertion
    // reads the true on-disk result after the spy is restored.
    await writeFile('.cdkrd/ignore.yaml', raw2, 'utf8');
    // Read order in addIgnoreRules: (1) top loadConfig, (2) existingRaw = the write basis,
    // (3) OLD-ONLY second loadConfig = the dedupe basis. Scripting existingRaw to see the
    // peer (raw2) but the stale dedupe read to miss it (raw1) is the divergence the issue
    // describes. The NEW code never does read (3), so its dedupe basis IS raw2 and the write
    // is a no-op. After the scripted reads are exhausted, later reads (the assertion's
    // loadConfig) fall through to the LAST scripted value; we clear the script instead so the
    // final assertion reads the true on-disk file.
    readScript.seq = [raw1, raw2, raw1];
    readScript.i = 0;
    try {
      await addIgnoreRules([p('Mine.z')]);
    } finally {
      readScript.seq = null;
      readScript.i = 0;
    }
    // Exactly one Mine.z — the peer's rule is deduped against the SAME snapshot the write is
    // built from, so the stale second read can no longer make us re-append a duplicate.
    expect((await loadConfig()).ignore).toEqual([{ path: 'Base.x' }, { path: 'Mine.z' }]);
  });

  it('appends to a UTF-16 LE existing file without mojibaking its prior rules (#1291 re-read)', async () => {
    // The pre-write re-read (existingRaw) must decode with the same BOM/UTF-16 sniff as
    // loadConfig, else a Windows-authored UTF-16 ignore.yaml would parse to mojibake here
    // and its existing rules would be dropped on append.
    await mkdir('.cdkrd', { recursive: true });
    await writeFile('.cdkrd/ignore.yaml', Buffer.from('﻿ignore:\n  - path: Prior.x\n', 'utf16le'));
    await addIgnoreRules([p('Mine.z')]);
    expect((await loadConfig()).ignore).toEqual([{ path: 'Prior.x' }, { path: 'Mine.z' }]);
  });
});

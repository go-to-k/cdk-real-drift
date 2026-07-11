// #1305 — applyDefinitionSubstitutions must resolve DefinitionSubstitutions in a SINGLE
// Fn::Sub-like pass. The old per-key sequential split/join re-scanned text injected by an
// earlier key, so a substitution VALUE containing a literal `${otherKey}` got re-substituted and
// the result depended on template JSON key order. CloudFormation's StepFunctions provider resolves
// in one pass (injected `${...}` is NEVER re-scanned), so cdkrd folding the declared side to the
// re-substituted text produced a permanent false declared drift (and a mis-resolved revert write).
import { describe, expect, it } from 'vite-plus/test';
import { applyDefinitionSubstitutions, classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

describe('#1305 applyDefinitionSubstitutions — single Fn::Sub-like pass', () => {
  it('does NOT re-substitute a value that contains a literal ${otherKey}', () => {
    // ${a} -> '${b}' (injected), and that injected ${b} must NOT be re-substituted to 'X'.
    const out = applyDefinitionSubstitutions('{"Result":"${a}"}', { a: '${b}', b: 'X' });
    expect(out).toBe('{"Result":"${b}"}');
  });

  it('is independent of substitution key insertion order', () => {
    const ab = applyDefinitionSubstitutions('{"Result":"${a}"}', { a: '${b}', b: 'X' });
    const ba = applyDefinitionSubstitutions('{"Result":"${a}"}', { b: 'X', a: '${b}' });
    expect(ab).toBe(ba);
    expect(ab).toBe('{"Result":"${b}"}');
  });

  it('resolves a plain substitution', () => {
    expect(applyDefinitionSubstitutions('${Name}', { Name: 'Foo' })).toBe('Foo');
  });

  it('preserves an unknown ${token} verbatim', () => {
    expect(applyDefinitionSubstitutions('${Unknown}', { Name: 'Foo' })).toBe('${Unknown}');
  });

  it('leaves a null / object-valued substitution token verbatim', () => {
    expect(applyDefinitionSubstitutions('${N} ${O}', { N: null, O: { x: 1 } })).toBe('${N} ${O}');
  });

  it('stringifies scalar substitution values', () => {
    expect(applyDefinitionSubstitutions('${A}-${B}-${C}', { A: 1, B: true, C: 'z' })).toBe(
      '1-true-z'
    );
  });
});

// End-to-end: a state machine whose substitution value keeps a literal ${b} must NOT surface a
// declared drift, since the live definition also keeps that literal (CFn single-pass).
const sfnSchema: SchemaInfo = {
  readOnly: new Set(['Arn', 'Name', 'StateMachineRevisionId']),
  writeOnly: new Set(['Definition', 'DefinitionS3Location', 'DefinitionSubstitutions']),
  createOnly: new Set(['StateMachineName', 'StateMachineType']),
  readOnlyPaths: ['Arn', 'Name', 'StateMachineRevisionId'],
  writeOnlyPaths: ['Definition', 'DefinitionS3Location', 'DefinitionSubstitutions'],
  createOnlyPaths: ['StateMachineName', 'StateMachineType'],
  defaults: {},
  defaultPaths: {},
};

const tier = (fs: Finding[], t: string): string[] =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();

const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'Machine',
  resourceType: 'AWS::StepFunctions::StateMachine',
  physicalId: 'arn:aws:states:us-east-1:111111111111:stateMachine:m',
  declared,
});

describe('#1305 classifyResource — no false declared drift when a substitution value holds ${literal}', () => {
  const DECLARED_WITH_TOKEN =
    '{"StartAt":"P","States":{"P":{"Type":"Pass","Result":{"v":"${a}"},"End":true}}}';

  for (const [label, subs] of [
    ['{a,b} order', { a: '${b}', b: 'X' }],
    ['{b,a} order', { b: 'X', a: '${b}' }],
  ] as const) {
    it(`no declared drift with substitutions in ${label}`, () => {
      const res = mk({
        DefinitionString: DECLARED_WITH_TOKEN,
        DefinitionSubstitutions: subs,
        RoleArn: 'arn:aws:iam::111111111111:role/r',
      });
      // ${a} -> '${b}' single pass; live keeps the literal ${b} (CFn provider does not re-scan).
      const live = {
        DefinitionString:
          '{"StartAt":"P","States":{"P":{"End":true,"Result":{"v":"${b}"},"Type":"Pass"}}}',
        RoleArn: 'arn:aws:iam::111111111111:role/r',
      };
      const f = classifyResource(res, live, sfnSchema);
      expect(tier(f, 'declared')).not.toContain('DefinitionString');
    });
  }
});

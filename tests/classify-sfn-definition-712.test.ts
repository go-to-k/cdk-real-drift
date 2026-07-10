// #712 — two related first-run false positives on AWS::StepFunctions::StateMachine, both
// caused by cdkrd not reconciling the writeOnly declared `Definition` / `DefinitionSubstitutions`
// inputs with the readable live `DefinitionString`.
//   Symptom A — the OBJECT `Definition` form is writeOnly (→ readGap) and the live read supplies
//     only `DefinitionString`; its whole live definition surfaced as undeclared drift on a clean
//     deploy. Fold DefinitionString atDefault when the parsed live JSON is STRUCTURALLY EQUAL to
//     the declared `Definition` object; a genuine out-of-band definition change still surfaces.
//   Symptom B — `DefinitionSubstitutions` is a writeOnly `${token}` map CloudFormation resolves
//     into the deployed definition, so the live `DefinitionString` echoes the SUBSTITUTED text
//     while the declared string keeps the literal `${token}` — a false declared drift that
//     survives record and, on revert, would write the literal `${token}` back and break the state
//     machine. Resolve the substitutions into the declared string before comparing; a genuine
//     body edit still surfaces as declared drift.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// AWS::StepFunctions::StateMachine schema: Definition / DefinitionS3Location /
// DefinitionSubstitutions are writeOnly (unreadable); DefinitionString is readable.
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

const DEFINITION_OBJECT = {
  StartAt: 'Pass1',
  States: {
    Pass1: { Type: 'Pass', Result: { ok: true }, Next: 'Pass2' },
    Pass2: { Type: 'Pass', End: true },
  },
};

describe('#712 symptom A — object Definition mirrors the live DefinitionString', () => {
  it('folds DefinitionString atDefault when it parses structurally equal to the declared Definition object', () => {
    const res = mk({ Definition: DEFINITION_OBJECT, RoleArn: 'arn:aws:iam::111111111111:role/r' });
    // Live echoes the same definition compiled to a JSON string with a DIFFERENT key order
    // (AWS re-serializes) — the fold must be structural, not a string compare.
    const live = {
      DefinitionString:
        '{"StartAt":"Pass1","States":{"Pass1":{"Next":"Pass2","Result":{"ok":true},"Type":"Pass"},"Pass2":{"End":true,"Type":"Pass"}}}',
      RoleArn: 'arn:aws:iam::111111111111:role/r',
    };
    const f = classifyResource(res, live, sfnSchema);
    expect(tier(f, 'atDefault')).toContain('DefinitionString');
    expect(tier(f, 'undeclared')).not.toContain('DefinitionString');
    // The writeOnly Definition object is still surfaced as a readGap (declared-but-unreadable).
    expect(tier(f, 'readGap')).toContain('Definition');
  });

  it('surfaces DefinitionString as drift when the live definition diverges from the declared object (out-of-band change)', () => {
    const res = mk({ Definition: DEFINITION_OBJECT, RoleArn: 'arn:aws:iam::111111111111:role/r' });
    // An out-of-band edit: Pass2 became a Fail state — live is NOT structurally equal.
    const live = {
      DefinitionString:
        '{"StartAt":"Pass1","States":{"Pass1":{"Next":"Pass2","Result":{"ok":true},"Type":"Pass"},"Pass2":{"Type":"Fail"}}}',
      RoleArn: 'arn:aws:iam::111111111111:role/r',
    };
    const f = classifyResource(res, live, sfnSchema);
    expect(tier(f, 'atDefault')).not.toContain('DefinitionString');
    expect(tier(f, 'undeclared')).toContain('DefinitionString');
  });
});

describe('#712 symptom B — DefinitionSubstitutions resolved into the declared DefinitionString', () => {
  const DECLARED_WITH_TOKEN =
    '{"StartAt":"P","States":{"P":{"Type":"Pass","Result":{"v":"${greeting}"},"End":true}}}';

  it('does NOT report declared drift when the live substituted DefinitionString equals the resolved declared string', () => {
    const res = mk({
      DefinitionString: DECLARED_WITH_TOKEN,
      DefinitionSubstitutions: { greeting: 'hello-world' },
      RoleArn: 'arn:aws:iam::111111111111:role/r',
    });
    // Live echoes the substituted text (${greeting} -> hello-world), pretty-print-agnostic.
    const live = {
      DefinitionString:
        '{"StartAt":"P","States":{"P":{"End":true,"Result":{"v":"hello-world"},"Type":"Pass"}}}',
      RoleArn: 'arn:aws:iam::111111111111:role/r',
    };
    const f = classifyResource(res, live, sfnSchema);
    expect(tier(f, 'declared')).not.toContain('DefinitionString');
    // DefinitionSubstitutions is writeOnly — surfaced as a readGap, never a declared drift.
    expect(tier(f, 'readGap')).toContain('DefinitionSubstitutions');
    expect(tier(f, 'declared')).not.toContain('DefinitionSubstitutions');
  });

  it('still surfaces declared drift when the live definition diverges beyond the substitution (real change)', () => {
    const res = mk({
      DefinitionString: DECLARED_WITH_TOKEN,
      DefinitionSubstitutions: { greeting: 'hello-world' },
      RoleArn: 'arn:aws:iam::111111111111:role/r',
    });
    // Live substituted the token BUT also flipped End:true -> a Wait state — a genuine edit.
    const live = {
      DefinitionString:
        '{"StartAt":"P","States":{"P":{"Type":"Wait","Seconds":5,"Result":{"v":"hello-world"},"End":true}}}',
      RoleArn: 'arn:aws:iam::111111111111:role/r',
    };
    const f = classifyResource(res, live, sfnSchema);
    expect(tier(f, 'declared')).toContain('DefinitionString');
  });

  it('reports declared drift when substitutions are absent — the literal ${token} vs substituted live still diverges (no false clean)', () => {
    // Symptom-B guard: without DefinitionSubstitutions declared, the literal ${greeting} declared
    // string is NOT resolved, so a live that resolved it is a genuine mismatch and must surface.
    const res = mk({
      DefinitionString: DECLARED_WITH_TOKEN,
      RoleArn: 'arn:aws:iam::111111111111:role/r',
    });
    const live = {
      DefinitionString:
        '{"StartAt":"P","States":{"P":{"End":true,"Result":{"v":"hello-world"},"Type":"Pass"}}}',
      RoleArn: 'arn:aws:iam::111111111111:role/r',
    };
    const f = classifyResource(res, live, sfnSchema);
    expect(tier(f, 'declared')).toContain('DefinitionString');
  });
});

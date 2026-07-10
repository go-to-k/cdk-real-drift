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

describe('GetTemplate non-ASCII mask inside a DefinitionString — readGap, not declared drift', () => {
  // GetTemplate returns every non-ASCII char in a stored string literal as `?`, so a
  // definition carrying e.g. a Japanese Fail-state Cause arrives masked on the declared
  // side while the live read is intact. The SFN structural-compare branch must demote
  // that to a readGap (declared-but-unverifiable) instead of pushing a false declared
  // drift whose desired shows `????…` (observed live: two Japanese Cause runs of 13 and
  // 24 chars masked 1:1 while CloudFormation's own drift detection reported IN_SYNC).
  const LIVE_JP =
    '{"StartAt":"Check","States":{"Check":{"Type":"Choice","Choices":[{"Condition":"{% $ok %}","Next":"Done"}],"Default":"Bad"},"Bad":{"Type":"Fail","Cause":"入力された値 item.<type>.<size> の形式が正しくありません","Error":"InvalidFormat"},"Done":{"Type":"Pass","End":true}}}';
  const mask = (s: string): string => s.replace(/[^\x00-\x7f]/gu, '?');

  it('demotes to readGap when the declared definition differs from live ONLY at masked non-ASCII leaves', () => {
    const res = mk({
      DefinitionString: mask(LIVE_JP),
      RoleArn: 'arn:aws:iam::111111111111:role/r',
    });
    const live = { DefinitionString: LIVE_JP, RoleArn: 'arn:aws:iam::111111111111:role/r' };
    const f = classifyResource(res, live, sfnSchema);
    expect(tier(f, 'declared')).not.toContain('DefinitionString');
    const gap = f.find((x) => x.tier === 'readGap' && x.path === 'DefinitionString');
    expect(gap?.note).toContain('masks non-ASCII');
  });

  it('demotes to readGap even when the live definition is re-serialized with a different key order (structural mask compare)', () => {
    // Byte-alignment breaks (Cause/Error/Type reordered), so the raw-string mask check
    // cannot fire — only the structural mask-tolerant compare can.
    const liveReordered = LIVE_JP.replace(
      '"Type":"Fail","Cause":"入力された値 item.<type>.<size> の形式が正しくありません","Error":"InvalidFormat"',
      '"Cause":"入力された値 item.<type>.<size> の形式が正しくありません","Error":"InvalidFormat","Type":"Fail"'
    );
    const res = mk({
      DefinitionString: mask(LIVE_JP),
      RoleArn: 'arn:aws:iam::111111111111:role/r',
    });
    const live = { DefinitionString: liveReordered, RoleArn: 'arn:aws:iam::111111111111:role/r' };
    const f = classifyResource(res, live, sfnSchema);
    expect(tier(f, 'declared')).not.toContain('DefinitionString');
    expect(tier(f, 'readGap')).toContain('DefinitionString');
  });

  it('still reports declared drift when a genuine ASCII edit exists alongside the masks (fail-toward-reporting)', () => {
    // An out-of-band edit changed an ASCII leaf (Error code) — masks alone no longer
    // explain the difference, so the finding must surface as declared drift.
    const liveEdited = LIVE_JP.replace('"Error":"InvalidFormat"', '"Error":"SomethingElse"');
    const res = mk({
      DefinitionString: mask(LIVE_JP),
      RoleArn: 'arn:aws:iam::111111111111:role/r',
    });
    const live = { DefinitionString: liveEdited, RoleArn: 'arn:aws:iam::111111111111:role/r' };
    const f = classifyResource(res, live, sfnSchema);
    expect(tier(f, 'declared')).toContain('DefinitionString');
    expect(tier(f, 'readGap')).not.toContain('DefinitionString');
  });

  it('does NOT demote a pure-ASCII genuine change even when the declared side contains a literal "?"', () => {
    // A real `?` character in a definition (a regex, a message) must never excuse a diff:
    // isCfnTemplateNonAsciiMask requires the live side to carry non-ASCII at the masked
    // positions, so an ASCII-vs-ASCII difference always surfaces.
    const declared =
      '{"StartAt":"P","States":{"P":{"Type":"Fail","Cause":"expected item.<type>.<size>?","Error":"E"}}}';
    const live = {
      DefinitionString:
        '{"StartAt":"P","States":{"P":{"Type":"Fail","Cause":"expected item.<type>.<size>!","Error":"E"}}}',
      RoleArn: 'arn:aws:iam::111111111111:role/r',
    };
    const res = mk({ DefinitionString: declared, RoleArn: 'arn:aws:iam::111111111111:role/r' });
    const f = classifyResource(res, live, sfnSchema);
    expect(tier(f, 'declared')).toContain('DefinitionString');
  });
});

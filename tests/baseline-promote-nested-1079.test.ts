import { describe, expect, it } from 'vite-plus/test';
import {
  applyBaseline,
  type BaselineFile,
  declaredKeysByLogical,
} from '../src/baseline/baseline-file.js';
import { buildRevertPlan } from '../src/revert/plan.js';

// #1079: promoting a NESTED recorded value into the template (the recommended
// "promote undeclared drift into code" workflow) surfaced a FALSE confirmed "baseline
// value removed since record" drift — and revert then offered to overwrite the
// freshly-declared value with the STALE recorded one. #749 folded only TOP-LEVEL promoted
// paths (declaredByLogical carried just the top-level key set); a nested recorded path the
// user later declared was invisible to that gate. The fix walks the whole declared MODEL
// along the recorded path: promoted iff the path resolves. #749's nested-REMOVAL FN still
// surfaces because a removed value's path does NOT resolve unless the user declared it.

function baseline(recorded: BaselineFile['recorded']): BaselineFile {
  return {
    schemaVersion: 1,
    stackName: 's',
    region: 'r',
    accountId: '111122223333',
    capturedAt: '',
    templateHash: '',
    recorded,
  };
}

describe('#1079 promoted-to-code NESTED recorded path folds (not "removed since record")', () => {
  it('folds a NESTED recorded path whose value is now DECLARED (the repro from the issue)', () => {
    // recorded live-only `LoggingConfig.LogFormat = 'Text'`, then the user declares
    // LoggingConfig (incl. LogFormat) in the template and deploys → nothing drifted.
    const b = baseline([
      {
        logicalId: 'Fn',
        resourceType: 'AWS::Lambda::Function',
        path: 'LoggingConfig.LogFormat',
        value: 'Text',
      },
    ]);
    const warnings: string[] = [];
    const out = applyBaseline([], b, {
      declaredByLogical: new Map([
        ['Fn', { LoggingConfig: { LogFormat: 'JSON', ApplicationLogLevel: 'INFO' } }],
      ]),
      physicalIdByLogical: new Map([['Fn', 'my-fn']]),
      warn: (m) => warnings.push(m),
    });
    // NO false "removed since record" finding — it was promoted, not removed.
    expect(out).toHaveLength(0);
    expect(warnings.some((w) => w.includes('now declared in the template'))).toBe(true);
  });

  it('does NOT offer a stale-value revert for the promoted nested path', () => {
    const b = baseline([
      {
        logicalId: 'Fn',
        resourceType: 'AWS::Lambda::Function',
        path: 'LoggingConfig.LogFormat',
        value: 'Text',
      },
    ]);
    const out = applyBaseline([], b, {
      declaredByLogical: new Map([['Fn', { LoggingConfig: { LogFormat: 'JSON' } }]]),
      physicalIdByLogical: new Map([['Fn', 'my-fn']]),
    });
    const plan = buildRevertPlan(out, b, { schemas: new Map() });
    // no synthesized finding survived → no revert op that would clobber the declared 'JSON'.
    expect(plan.items).toHaveLength(0);
  });

  it('folds a bracketed nested path (Foo[0].Baz) when the element is now declared', () => {
    const b = baseline([
      {
        logicalId: 'Pol',
        resourceType: 'AWS::IAM::Policy',
        path: 'PolicyDocument.Statement[0].Condition',
        value: { StringEquals: { 'aws:username': 'x' } },
      },
    ]);
    const warnings: string[] = [];
    const out = applyBaseline([], b, {
      declaredByLogical: new Map([
        [
          'Pol',
          {
            PolicyDocument: {
              Statement: [
                {
                  Effect: 'Allow',
                  Action: 's3:*',
                  Resource: '*',
                  Condition: { StringEquals: { 'aws:username': 'x' } },
                },
              ],
            },
          },
        ],
      ]),
      warn: (m) => warnings.push(m),
    });
    expect(out).toHaveLength(0);
    expect(warnings.some((w) => w.includes('now declared in the template'))).toBe(true);
  });

  it('folds a bracketed nested path keyed by an IDENTITY field value when now declared', () => {
    // an identity-keyed object-array element — classify keys the bracket by the element's
    // identity FIELD value (here `Name`), not a numeric index. The walk must resolve the
    // element by that same identity value.
    const b = baseline([
      {
        logicalId: 'Ev',
        resourceType: 'AWS::Events::Rule',
        path: 'Targets[my-target].RetryPolicy',
        value: { MaximumRetryAttempts: 3 },
      },
    ]);
    const out = applyBaseline([], b, {
      declaredByLogical: new Map([
        [
          'Ev',
          {
            Targets: [
              {
                Name: 'my-target',
                Arn: 'arn:aws:x',
                RetryPolicy: { MaximumRetryAttempts: 3 },
              },
            ],
          },
        ],
      ]),
    });
    expect(out).toHaveLength(0);
  });

  it('does NOT over-fold: a nested path whose top-level parent is NOT declared still surfaces', () => {
    // `Config` is entirely absent from the declared model → not promoted, a real removal.
    const b = baseline([
      {
        logicalId: 'Fn',
        resourceType: 'AWS::Lambda::Function',
        path: 'Config.Nested.Value',
        value: 42,
      },
    ]);
    const out = applyBaseline([], b, {
      declaredByLogical: new Map([['Fn', { Code: { ZipFile: 'x' }, Role: 'arn' }]]),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      path: 'Config.Nested.Value',
      note: 'baseline value removed since record',
    });
  });

  it('does NOT over-fold: parent declared but the exact nested leaf NOT declared → still a removal', () => {
    // `LoggingConfig` is declared, but only ApplicationLogLevel — the recorded LogFormat was
    // an out-of-band nested value that vanished (the #749 FN we must keep detecting).
    const b = baseline([
      {
        logicalId: 'Fn',
        resourceType: 'AWS::Lambda::Function',
        path: 'LoggingConfig.LogFormat',
        value: 'Text',
      },
    ]);
    const out = applyBaseline([], b, {
      declaredByLogical: new Map([['Fn', { LoggingConfig: { ApplicationLogLevel: 'INFO' } }]]),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      path: 'LoggingConfig.LogFormat',
      note: 'baseline value removed since record',
    });
  });

  it('folds the whole subtree when the parent is declared as a LEAF (Foo declared, Foo.Bar promoted)', () => {
    // declaring `Environment` at all moves its whole subtree to the declared dimension; the
    // recorded `Environment.Variables.FOO` is now redundant intent, not a vanished value.
    const b = baseline([
      {
        logicalId: 'Fn',
        resourceType: 'AWS::Lambda::Function',
        path: 'Environment.Variables.FOO',
        value: 'bar',
      },
    ]);
    const warnings: string[] = [];
    // `Environment` declared as a leaf-ish value (an unresolved token placeholder) — the
    // walk hits a non-container before the path ends → the subtree is declared intent.
    const out = applyBaseline([], b, {
      declaredByLogical: new Map([['Fn', { Environment: 'DECLARED_TOKEN' }]]),
      warn: (m) => warnings.push(m),
    });
    expect(out).toHaveLength(0);
    expect(warnings.some((w) => w.includes('now declared in the template'))).toBe(true);
  });

  it('declaredKeysByLogical carries the full declared model (not just top-level keys)', () => {
    const m = declaredKeysByLogical([
      { logicalId: 'Fn', declared: { LoggingConfig: { LogFormat: 'JSON' }, Role: 'arn' } },
    ]);
    expect(m.get('Fn')).toEqual({ LoggingConfig: { LogFormat: 'JSON' }, Role: 'arn' });
  });
});

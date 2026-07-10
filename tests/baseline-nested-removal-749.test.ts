import { describe, expect, it } from 'vite-plus/test';
import { applyBaseline, type BaselineFile } from '../src/baseline/baseline-file.js';

// #749: the "baseline value removed since record" drift never fired for NESTED recorded
// values. Every nested undeclared path is built as `<TopLevelKey>.<...>` and is only ever
// collected where its parent key is DECLARED (collectNestedUndeclared descends only into
// `k in declaredVal`). The old promotion check tested the top-level key against
// declaredByLogical's key set, so for EVERY nested recorded value that top segment was a
// declared key and the vanished value was misclassified `promotedStale` instead of
// surfacing as a real removal. #1079 replaced that with a WALK of the whole declared MODEL
// along the recorded path: a nested value is promoted only if the path RESOLVES in the
// model, so an out-of-band nested REMOVAL — a path present under a declared parent but NOT
// itself declared — still surfaces. These tests declare the PARENT (an object with other
// keys) but NOT the recorded nested leaf, so the removal must still fire.

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

describe('#749 nested recorded value removed since record', () => {
  it('surfaces a NESTED recorded value that vanished as "removed since record" (not promotedStale)', () => {
    // `Environment.Variables.FOO` — nested under `Environment`, a DECLARED top-level key.
    const b = baseline([
      {
        logicalId: 'Fn',
        resourceType: 'AWS::Lambda::Function',
        path: 'Environment.Variables.FOO',
        value: 'bar',
      },
    ]);
    const warnings: string[] = [];
    // `Environment` is declared, but the nested value FOO is NOT in the template (the
    // declared Environment.Variables holds a DIFFERENT key) — the recorded value disappeared
    // out of band → a genuine removal, and the path must NOT resolve in the declared model.
    const out = applyBaseline([], b, {
      declaredByLogical: new Map([['Fn', { Environment: { Variables: { OTHER: 'y' } } }]]),
      warn: (m) => warnings.push(m),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      tier: 'undeclared',
      logicalId: 'Fn',
      path: 'Environment.Variables.FOO',
      desired: 'bar',
      actual: undefined,
      note: 'baseline value removed since record',
    });
    // and it must NOT be swallowed into the "now declared in the template" nudge
    expect(warnings.some((w) => w.includes('now declared in the template'))).toBe(false);
  });

  it('surfaces a vanished nested TAG in a declared map as "removed since record"', () => {
    // an extra tag inside a declared `Tags` map that disappeared out of band.
    const b = baseline([
      {
        logicalId: 'Bkt',
        resourceType: 'AWS::S3::Bucket',
        path: 'Tags.Owner',
        value: 'team-a',
      },
    ]);
    const warnings: string[] = [];
    // `Tags` is declared with a different entry; the recorded `Owner` tag is not declared.
    const out = applyBaseline([], b, {
      declaredByLogical: new Map([['Bkt', { Tags: [{ Key: 'Env', Value: 'prod' }] }]]),
      warn: (m) => warnings.push(m),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      path: 'Tags.Owner',
      note: 'baseline value removed since record',
    });
    expect(warnings).toHaveLength(0);
  });

  it('surfaces a vanished value under a declared ARRAY (bracket-notation path)', () => {
    // an out-of-band Condition added inside a declared policy statement, then removed.
    const b = baseline([
      {
        logicalId: 'Pol',
        resourceType: 'AWS::IAM::Policy',
        path: 'PolicyDocument.Statement[0].Condition',
        value: { StringEquals: { 'aws:username': 'x' } },
      },
    ]);
    // The declared statement[0] has NO Condition — the recorded one was added then removed
    // out of band, so `PolicyDocument.Statement[0].Condition` must NOT resolve.
    const out = applyBaseline([], b, {
      declaredByLogical: new Map([
        [
          'Pol',
          {
            PolicyDocument: {
              Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }],
            },
          },
        ],
      ]),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      path: 'PolicyDocument.Statement[0].Condition',
      note: 'baseline value removed since record',
    });
  });

  it('control: a TOP-LEVEL recorded key genuinely promoted into the template is still promotedStale', () => {
    const b = baseline([
      { logicalId: 'A', resourceType: 'AWS::X::Y', path: 'ReservedConcurrentExecutions', value: 5 },
    ]);
    const warnings: string[] = [];
    const out = applyBaseline([], b, {
      declaredByLogical: new Map([['A', { ReservedConcurrentExecutions: 5 }]]),
      warn: (m) => warnings.push(m),
    });
    expect(out).toHaveLength(0); // no false "removed" finding for a real promotion
    expect(warnings[0]).toContain('now declared in the template');
  });
});

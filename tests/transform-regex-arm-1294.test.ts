// #1294 — ~35 of the 181 real registry `propertyTransform` entries produce a REGEX PATTERN string,
// not a concrete value (e.g. DirectConnect Connection Location → the constant `^[a-zA-Z0-9-]+$`;
// ECS Service TaskDefinition → an `arn:…:task-definition/<family:rev>` pattern built from the
// declared value). CloudFormation's own drift engine matches the LIVE value against the transformed
// string as an ANCHORED pattern; cdkrd only did `deepEqual`, so the fold was DEAD for every
// pattern-producing transform → a permanent declared False Positive on a clean stack.
//
// The pattern arm (in matchesPropertyTransform, driven here via classifyResource) matches the live
// value against the transform OUTPUT interpreted as an anchored full-match regex, GUARDED so it only
// fires when out !== declaredValue and both output+live are strings — a value-producing transform is
// never re-interpreted as a pattern. The NEGATIVE + GUARD tests prove no over-folding.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const baseSchema: Omit<SchemaInfo, 'propertyTransforms'> = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};
const schema = (propertyTransforms: Record<string, string>): SchemaInfo => ({
  ...baseSchema,
  propertyTransforms,
});
const declaredPaths = (fs: Finding[]): string[] =>
  fs
    .filter((f) => f.tier === 'declared')
    .map((f) => f.path)
    .sort();
const mk = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId: 'phys',
  declared,
});

describe('#1294 pattern-producing propertyTransform matches live against the transformed regex', () => {
  it('ECS Service TaskDefinition — transform builds an ARN PATTERN from the declared family:rev', () => {
    const res = mk('AWS::ECS::Service', { TaskDefinition: 'webtask:3' });
    // The transform embeds the declared leaf in an ARN regex; live is the full resolved ARN.
    const s = schema({
      TaskDefinition: '"arn:aws:ecs:[^:]*:[0-9]*:task-definition/" & TaskDefinition',
    });
    const f = classifyResource(
      res,
      { TaskDefinition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/webtask:3' },
      s
    );
    expect(declaredPaths(f)).not.toContain('TaskDefinition');
  });

  it('DirectConnect Connection Location — a CONSTANT pattern matches an arbitrary conforming live', () => {
    const res = mk('AWS::DirectConnect::Connection', { Location: 'my-conn' });
    const s = schema({ Location: '"^[a-zA-Z0-9-]+$"' });
    // live is a different (but pattern-conforming) value → folds
    const f = classifyResource(res, { Location: 'abc-123' }, s);
    expect(declaredPaths(f)).not.toContain('Location');
  });

  it('NEGATIVE: a live value that FAILS the constant pattern still surfaces as declared drift', () => {
    const res = mk('AWS::DirectConnect::Connection', { Location: 'my-conn' });
    const s = schema({ Location: '"^[a-zA-Z0-9-]+$"' });
    // "has space!" violates the pattern (space + `!`) → NOT folded, surfaces
    const f = classifyResource(res, { Location: 'has space!' }, s);
    expect(declaredPaths(f)).toContain('Location');
  });

  it('GUARD: a value-producing transform whose output == declared is NOT reinterpreted as a pattern', () => {
    const res = mk('AWS::DirectConnect::Connection', { Location: 'abc' });
    // Identity-ish transform: output === declared "abc". As a regex it would MATCH a live "abc",
    // but the out !== declaredValue guard blocks that — a genuinely different live must surface.
    const s = schema({ Location: 'Location' });
    const f = classifyResource(res, { Location: 'abcd' }, s);
    // out ("abc") !== live ("abcd") and out === declared → guard prevents a spurious pattern fold
    expect(declaredPaths(f)).toContain('Location');
  });

  // CONTROL: with NO propertyTransform the same divergence surfaces — proves the fold is what suppresses.
  it('CONTROL: with NO propertyTransform, the ECS ARN divergence surfaces as declared drift', () => {
    const res = mk('AWS::ECS::Service', { TaskDefinition: 'webtask:3' });
    const f = classifyResource(
      res,
      { TaskDefinition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/webtask:3' },
      baseSchema
    );
    expect(declaredPaths(f)).toContain('TaskDefinition');
  });
});

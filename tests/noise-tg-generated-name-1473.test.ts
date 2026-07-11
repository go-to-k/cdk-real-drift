// #1473 — an ELBv2 TargetGroup that declares no `Name` reads back CloudFormation's generated
// `<stackName>-<logicalId>-<random>` name, TRUNCATED to the 32-char TG-name cap (e.g.
// "Cdkrd1-Insta-MCQ3G4BOIKE6"). When the deployed template has no `aws:cdk:path` metadata the
// resource's constructPath is undefined, so isCfnGeneratedName can't validate the truncation and
// the name floods the first `check` as [Potential Drift]. GENERATED_TOPLEVEL_PATHS folds it
// value-independently (Name is createOnly — an undeclared value is always the AWS-minted identity).
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const emptySchema: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};

const TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();

// No constructPath / physicalId ARN — the raw-CFn / stripped-metadata case that defeats
// isCfnGeneratedName's stack-prefix + truncated branches.
const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'InstanceTg',
  resourceType: TYPE,
  physicalId:
    'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/Cdkrd1-Insta-MCQ3G4BOIKE6/f5d5aeadf380a557',
  declared,
});

describe('#1473 ELBv2 TargetGroup generated Name folds value-independently', () => {
  it('an undeclared generated Name (truncated, no constructPath) folds as generated, not drift', () => {
    const t = tiers(
      classifyResource(
        mk({ Port: 80, Protocol: 'HTTP' }),
        { Name: 'Cdkrd1-Insta-MCQ3G4BOIKE6' },
        emptySchema
      )
    );
    expect(t.generated).toEqual(['Name']);
    expect(t.undeclared).toEqual([]);
  });

  it('a DIFFERENT generated Name still folds (value-independent — createOnly, always AWS-minted)', () => {
    const t = tiers(
      classifyResource(
        mk({ Port: 80, Protocol: 'HTTP' }),
        { Name: 'Some-Other-ZZ9Qw3RtVak2' },
        emptySchema
      )
    );
    expect(t.generated).toEqual(['Name']);
    expect(t.undeclared).toEqual([]);
  });

  it('a DECLARED Name is compared in the declared loop (a real change still surfaces)', () => {
    const t = tiers(
      classifyResource(mk({ Name: 'my-tg', Port: 80 }), { Name: 'renamed-tg' }, emptySchema)
    );
    expect(t.declared).toContain('Name');
    expect(t.generated).toEqual([]);
  });

  it('the fold is scoped per-type (a Name on another type stays undeclared)', () => {
    const other: DesiredResource = {
      logicalId: 'X',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'x',
      declared: {},
    };
    expect(
      tiers(classifyResource(other, { Name: 'Cdkrd1-Insta-MCQ3G4BOIKE6' }, emptySchema)).undeclared
    ).toEqual(['Name']);
  });
});

function tiers(findings: Finding[]) {
  return {
    declared: tier(findings, 'declared'),
    undeclared: tier(findings, 'undeclared'),
    atDefault: tier(findings, 'atDefault'),
    generated: tier(findings, 'generated'),
  };
}

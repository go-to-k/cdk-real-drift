// #1094 — the #845/#1027 derived-echo folds were case-split: they fired only for the exact
// shapes the corpus captured, leaving sibling shapes as first-run undeclared [Potential Drift].
//   F8 CodeBuild Artifacts.Name — the derivation gated on a declared top-level Name; the
//      default CDK project declares NO Name and AWS generates it (= physicalId), still echoing
//      Artifacts.Name. Fall back to physicalId when Name is undeclared.
//   F9 AmazonMQ StorageType — the derivation folded EFS only for ACTIVEMQ; a RabbitMQ broker
//      reads back StorageType 'EBS' (RabbitMQ supports only EBS). Add RABBITMQ → EBS.
// Each fold stays equality-gated: a genuinely diverging value still surfaces as undeclared drift.
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
const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();
const mk = (
  resourceType: string,
  declared: Record<string, unknown>,
  physicalId = 'phys'
): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId,
  declared,
});

describe('#1094 F8 CodeBuild Artifacts.Name echoes the generated project name (unnamed project)', () => {
  const PHYS = 'MyStack-Build45A36621-1AB2C3';
  it('folds Artifacts.Name to atDefault when it equals the AWS-generated project name (= physicalId)', () => {
    const res = mk(
      'AWS::CodeBuild::Project',
      { Artifacts: { Type: 'CODEPIPELINE' } }, // NO declared top-level Name
      PHYS
    );
    const f = classifyResource(
      res,
      { Artifacts: { Type: 'CODEPIPELINE', Name: PHYS } },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('Artifacts.Name');
    expect(tier(f, 'undeclared')).not.toContain('Artifacts.Name');
  });
  it('surfaces Artifacts.Name when it diverges from the generated project name — detection preserved', () => {
    const res = mk('AWS::CodeBuild::Project', { Artifacts: { Type: 'CODEPIPELINE' } }, PHYS);
    const f = classifyResource(
      res,
      { Artifacts: { Type: 'CODEPIPELINE', Name: 'renamed-artifact' } },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('Artifacts.Name');
  });
  it('still folds Artifacts.Name to the declared top-level Name when one is declared (regression)', () => {
    const res = mk('AWS::CodeBuild::Project', {
      Name: 'my-build',
      Artifacts: { Type: 'CODEPIPELINE' },
    });
    const f = classifyResource(
      res,
      { Name: 'my-build', Artifacts: { Type: 'CODEPIPELINE', Name: 'my-build' } },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('Artifacts.Name');
    expect(tier(f, 'undeclared')).not.toContain('Artifacts.Name');
  });
});

describe('#1094 F9 AmazonMQ StorageType default per engine', () => {
  it('folds StorageType EBS to atDefault for a RABBITMQ broker declaring no StorageType', () => {
    const res = mk('AWS::AmazonMQ::Broker', {
      EngineType: 'RABBITMQ',
      DeploymentMode: 'SINGLE_INSTANCE',
    });
    const f = classifyResource(res, { EngineType: 'RABBITMQ', StorageType: 'EBS' }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('StorageType');
    expect(tier(f, 'undeclared')).not.toContain('StorageType');
  });
  it('handles mixed-case EngineType (rabbitmq) for the RabbitMQ EBS default', () => {
    const res = mk('AWS::AmazonMQ::Broker', { EngineType: 'rabbitmq' });
    const f = classifyResource(res, { EngineType: 'rabbitmq', StorageType: 'EBS' }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('StorageType');
    expect(tier(f, 'undeclared')).not.toContain('StorageType');
  });
  it('surfaces a RABBITMQ broker whose StorageType is EFS (away from the EBS default) — detection preserved', () => {
    const res = mk('AWS::AmazonMQ::Broker', { EngineType: 'RABBITMQ' });
    const f = classifyResource(res, { EngineType: 'RABBITMQ', StorageType: 'EFS' }, emptySchema);
    expect(tier(f, 'undeclared')).toContain('StorageType');
  });
  it('still folds StorageType EFS for an ACTIVEMQ broker (regression)', () => {
    const res = mk('AWS::AmazonMQ::Broker', { EngineType: 'ACTIVEMQ' });
    const f = classifyResource(res, { EngineType: 'ACTIVEMQ', StorageType: 'EFS' }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('StorageType');
    expect(tier(f, 'undeclared')).not.toContain('StorageType');
  });
});

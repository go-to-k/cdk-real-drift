// #1539 — two more members of the lowercase/re-case echo FP family (#1531 class),
// live-proven on case-idents2-min (us-east-1, 2026-07-13):
//   * AWS::Redshift::ClusterParameterGroup ParameterGroupName: the handler accepts a
//     mixed-case name, the service stores/echoes it lowercased
//     ("CdkrdHunt-RsCpg" -> "cdkrdhunt-rscpg").
//   * AWS::Batch::JobDefinition Type: "Container" echoes as the canonical "container"
//     (the same enum re-case as the already-guarded ComputeEnvironment Type).
// Both fold via CASE_INSENSITIVE_PATHS — values differing beyond case still surface.
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

const pathsByTier = (findings: Finding[], tier: string) =>
  findings
    .filter((f) => f.tier === tier)
    .map((f) => f.path)
    .sort();

describe('#1539 Redshift ClusterParameterGroup lowercase-stored name', () => {
  const mk = (declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'HuntRsCpg',
    resourceType: 'AWS::Redshift::ClusterParameterGroup',
    physicalId: 'cdkrdhunt-rscpg',
    declared,
  });
  const declared = {
    ParameterGroupName: 'CdkrdHunt-RsCpg',
    ParameterGroupFamily: 'redshift-1.0',
    Description: 'd',
  };

  it('a pure case-fold echo is not declared drift', () => {
    const f = classifyResource(
      mk(declared),
      { ...declared, ParameterGroupName: 'cdkrdhunt-rscpg' },
      emptySchema
    );
    expect(pathsByTier(f, 'declared')).toEqual([]);
  });

  it('a name differing beyond case still surfaces as declared drift', () => {
    const f = classifyResource(
      mk(declared),
      { ...declared, ParameterGroupName: 'cdkrdhunt-other' },
      emptySchema
    );
    expect(pathsByTier(f, 'declared')).toEqual(['ParameterGroupName']);
  });
});

describe('#1539 Batch JobDefinition Type enum re-case echo', () => {
  const mk = (declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'HuntJobDef',
    resourceType: 'AWS::Batch::JobDefinition',
    physicalId: 'CdkrdHunt-JobDef:1',
    declared,
  });
  const declared = { Type: 'Container', JobDefinitionName: 'CdkrdHunt-JobDef' };

  it('the canonical lowercase echo is not declared drift', () => {
    const f = classifyResource(mk(declared), { ...declared, Type: 'container' }, emptySchema);
    expect(pathsByTier(f, 'declared')).toEqual([]);
  });

  it('a genuinely different type still surfaces', () => {
    const f = classifyResource(mk(declared), { ...declared, Type: 'multinode' }, emptySchema);
    expect(pathsByTier(f, 'declared')).toEqual(['Type']);
  });
});

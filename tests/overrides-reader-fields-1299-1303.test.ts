import { BatchGetProjectsCommand, CodeBuildClient } from '@aws-sdk/client-codebuild';
import {
  DescribeDBClustersCommand,
  DocDBClient,
  ListTagsForResourceCommand as DocDbListTagsForResourceCommand,
} from '@aws-sdk/client-docdb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { KNOWN_DEFAULTS } from '../src/normalize/noise.js';
import { SDK_OVERRIDES } from '../src/read/overrides.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// #1299 (readCodeBuildProject) + #1303 (readDocDbCluster) — the recurring #1056 class: an
// SDK_OVERRIDES reader dropped writable schema COLLECTION props, so a declared collection had
// no live counterpart (actual=undefined) → a permanent `declared`-tier false drift on a clean
// stack that SURVIVES record. Each reader now projects the omitted props present-only, and any
// AWS-assigned default is equality-gated in KNOWN_DEFAULTS so an undeclared clean resource
// still folds to atDefault while a real change surfaces.

const codebuild = mockClient(CodeBuildClient);
const docdb = mockClient(DocDBClient);

const ctx = (declared: Record<string, unknown>, physicalId = '', accountId = '123456789012') => ({
  physicalId,
  declared,
  region: 'us-east-1',
  accountId,
});

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

function tiers(findings: Finding[]) {
  const by = (t: string) =>
    findings
      .filter((f) => f.tier === t)
      .map((f) => f.path)
      .sort();
  return {
    declared: by('declared'),
    undeclared: by('undeclared'),
    atDefault: by('atDefault'),
    readGap: by('readGap'),
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  codebuild.reset();
  docdb.reset();
  warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => {
  warn.mockRestore();
});

describe('readCodeBuildProject writable collection fields (#1299)', () => {
  it('projects Triggers / SecondarySources / SecondaryArtifacts / BuildBatchConfig / AutoRetryLimit', async () => {
    codebuild.on(BatchGetProjectsCommand).resolves({
      projects: [
        {
          name: 'my-project',
          source: { type: 'GITHUB', location: 'https://github.com/o/r.git' },
          artifacts: { type: 'NO_ARTIFACTS' },
          // webhook object present => Webhook: true, filterGroups mapped to CFn FilterGroups
          webhook: {
            url: 'https://api.github.com/hooks/123', // readOnly noise — must NOT be projected
            payloadUrl: 'https://codebuild.../webhook', // readOnly noise
            secret: 'shhh', // readOnly noise
            filterGroups: [
              [
                { type: 'EVENT', pattern: 'PUSH,PULL_REQUEST_CREATED' },
                { type: 'HEAD_REF', pattern: '^refs/heads/main$', excludeMatchedPattern: false },
              ],
            ],
            buildType: 'BUILD',
          },
          secondarySources: [{ type: 'S3', location: 'bucket/src2.zip', sourceIdentifier: 'src2' }],
          secondaryArtifacts: [
            { type: 'S3', location: 'artbucket', name: 'a2', artifactIdentifier: 'art2' },
          ],
          secondarySourceVersions: [{ sourceIdentifier: 'src2', sourceVersion: 'v1' }],
          buildBatchConfig: {
            serviceRole: 'arn:aws:iam::123456789012:role/batch',
            combineArtifacts: true,
            timeoutInMins: 60,
            restrictions: {
              maximumBuildsAllowed: 10,
              computeTypesAllowed: ['BUILD_GENERAL1_SMALL'],
            },
          },
          autoRetryLimit: 2,
        },
      ],
    });
    const out = await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'my-project'));

    // Triggers: Webhook:true + CFn-shaped FilterGroups, and NO readOnly url/secret leak.
    expect(out?.Triggers).toEqual({
      Webhook: true,
      BuildType: 'BUILD',
      FilterGroups: [
        [
          { Type: 'EVENT', Pattern: 'PUSH,PULL_REQUEST_CREATED' },
          { Type: 'HEAD_REF', Pattern: '^refs/heads/main$', ExcludeMatchedPattern: false },
        ],
      ],
    });
    expect(JSON.stringify(out?.Triggers)).not.toContain('shhh');

    expect(out?.SecondarySources).toEqual([
      { Type: 'S3', Location: 'bucket/src2.zip', SourceIdentifier: 'src2' },
    ]);
    expect(out?.SecondaryArtifacts).toEqual([
      { Type: 'S3', Location: 'artbucket', Name: 'a2', ArtifactIdentifier: 'art2' },
    ]);
    expect(out?.SecondarySourceVersions).toEqual([
      { SourceIdentifier: 'src2', SourceVersion: 'v1' },
    ]);
    expect(out?.BuildBatchConfig).toEqual({
      ServiceRole: 'arn:aws:iam::123456789012:role/batch',
      CombineArtifacts: true,
      TimeoutInMins: 60,
      Restrictions: {
        MaximumBuildsAllowed: 10,
        ComputeTypesAllowed: ['BUILD_GENERAL1_SMALL'],
      },
    });
    expect(out?.AutoRetryLimit).toBe(2);
  });

  it('a declared webhook project no longer false-drifts (Triggers now has a live counterpart)', async () => {
    codebuild.on(BatchGetProjectsCommand).resolves({
      projects: [
        {
          name: 'hook-proj',
          source: { type: 'GITHUB', location: 'https://github.com/o/r.git' },
          artifacts: { type: 'NO_ARTIFACTS' },
          webhook: { filterGroups: [[{ type: 'EVENT', pattern: 'PUSH' }]] },
        },
      ],
    });
    const declared = {
      Triggers: { Webhook: true, FilterGroups: [[{ Type: 'EVENT', Pattern: 'PUSH' }]] },
    };
    const live = await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx(declared, 'hook-proj'));
    const res: DesiredResource = {
      logicalId: 'HookProj',
      resourceType: 'AWS::CodeBuild::Project',
      physicalId: 'hook-proj',
      declared,
    };
    const t = tiers(classifyResource(res, live as Record<string, unknown>, emptySchema));
    expect(t.declared).toEqual([]); // was ['Triggers'] before the fix
  });

  it('a minimal project (no webhook / no secondaries / autoRetryLimit:0) stays clean', async () => {
    codebuild.on(BatchGetProjectsCommand).resolves({
      projects: [
        {
          name: 'min',
          source: { type: 'NO_SOURCE' },
          artifacts: { type: 'NO_ARTIFACTS' },
          autoRetryLimit: 0, // server default — must be OMITTED (0 is not folded by isTrivialEmpty)
        },
      ],
    });
    const out = await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'min'));
    expect(out?.Triggers).toBeUndefined();
    expect(out?.SecondarySources).toBeUndefined();
    expect(out?.SecondaryArtifacts).toBeUndefined();
    expect(out?.SecondarySourceVersions).toBeUndefined();
    expect(out?.BuildBatchConfig).toBeUndefined();
    expect(out?.AutoRetryLimit).toBeUndefined();
  });
});

describe('readDocDbCluster writable fields (#1303)', () => {
  it('projects ServerlessV2ScalingConfiguration / StorageType / NetworkType / DBSubnetGroupName', async () => {
    docdb.on(DescribeDBClustersCommand).resolves({
      DBClusters: [
        {
          DBClusterIdentifier: 'serverless-cluster',
          DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:serverless-cluster',
          ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 8 },
          StorageType: 'standard',
          NetworkType: 'IPV4',
          DBSubnetGroup: 'my-subnet-group',
        },
      ],
    });
    docdb.on(DocDbListTagsForResourceCommand).resolves({ TagList: [] });
    const out = await SDK_OVERRIDES['AWS::DocDB::DBCluster'](ctx({}, 'serverless-cluster'));
    expect(out?.ServerlessV2ScalingConfiguration).toEqual({ MinCapacity: 0.5, MaxCapacity: 8 });
    expect(out?.StorageType).toBe('standard');
    expect(out?.NetworkType).toBe('IPV4');
    expect(out?.DBSubnetGroupName).toBe('my-subnet-group'); // SDK DBSubnetGroup -> CFn DBSubnetGroupName
  });

  it('a minimal provisioned cluster omits ServerlessV2ScalingConfiguration', async () => {
    docdb.on(DescribeDBClustersCommand).resolves({
      DBClusters: [
        {
          DBClusterIdentifier: 'provisioned',
          DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:provisioned',
          StorageType: 'standard',
          NetworkType: 'IPV4',
          // DescribeDBClusters returns NO ServerlessV2ScalingConfiguration for a provisioned cluster
        },
      ],
    });
    docdb.on(DocDbListTagsForResourceCommand).resolves({ TagList: [] });
    const out = await SDK_OVERRIDES['AWS::DocDB::DBCluster'](ctx({}, 'provisioned'));
    expect(out?.ServerlessV2ScalingConfiguration).toBeUndefined();
  });
});

describe('DocDB StorageType / NetworkType default fold (#1303, KNOWN_DEFAULTS)', () => {
  it('has the equality-gated defaults registered', () => {
    expect(KNOWN_DEFAULTS['AWS::DocDB::DBCluster']).toMatchObject({
      StorageType: 'standard',
      NetworkType: 'IPV4',
    });
  });

  it('an undeclared standard/IPV4 cluster folds to atDefault (clean first check)', () => {
    const res: DesiredResource = {
      logicalId: 'Cluster',
      resourceType: 'AWS::DocDB::DBCluster',
      physicalId: 'clean-cluster',
      declared: { DBClusterIdentifier: 'clean-cluster' },
    };
    const t = tiers(
      classifyResource(
        res,
        { DBClusterIdentifier: 'clean-cluster', StorageType: 'standard', NetworkType: 'IPV4' },
        emptySchema
      )
    );
    expect(t.undeclared).toEqual([]);
    expect(t.atDefault.sort()).toEqual(['NetworkType', 'StorageType']);
  });

  it('a change to iopt1 / DUAL still surfaces as undeclared drift', () => {
    const res: DesiredResource = {
      logicalId: 'Cluster',
      resourceType: 'AWS::DocDB::DBCluster',
      physicalId: 'drifted-cluster',
      declared: { DBClusterIdentifier: 'drifted-cluster' },
    };
    const t = tiers(
      classifyResource(
        res,
        { DBClusterIdentifier: 'drifted-cluster', StorageType: 'iopt1', NetworkType: 'DUAL' },
        emptySchema
      )
    );
    expect(t.undeclared.sort()).toEqual(['NetworkType', 'StorageType']);
  });
});

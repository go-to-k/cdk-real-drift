// #1609: a barest CodePipeline (RoleArn + ArtifactStore + minimal stages)
// materializes PipelineType (era-dependent: fresh pipelines read "V2", pre-2023-10
// pipelines read "V1" -> KNOWN_DEFAULT_ONE_OF) and RunOrder=1 on every action
// (constant -> nested KNOWN_DEFAULT_PATHS). Both must fold to atDefault on a
// clean deploy. Live-found on the 2026-07-14 hunt (codepipeline-hunt,
// CdkrdHunt0714Pipe).
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

const stages = (runOrder?: number) => [
  {
    Name: 'Source',
    Actions: [
      {
        Name: 'Src',
        ActionTypeId: { Category: 'Source', Owner: 'AWS', Provider: 'S3', Version: '1' },
        Configuration: { S3Bucket: 'b', S3ObjectKey: 'src.zip' },
        OutputArtifacts: [{ Name: 'SrcOut' }],
        ...(runOrder === undefined ? {} : { RunOrder: runOrder }),
      },
    ],
  },
];

const res: DesiredResource = {
  logicalId: 'HuntPipeline',
  resourceType: 'AWS::CodePipeline::Pipeline',
  physicalId: 'HuntPipeline-ABC',
  declared: {
    RoleArn: 'arn:aws:iam::111122223333:role/pipe',
    ArtifactStore: { Type: 'S3', Location: 'b' },
    Stages: stages(),
  },
};
const cleanLive = (pipelineType: string, runOrder = 1) => ({
  RoleArn: 'arn:aws:iam::111122223333:role/pipe',
  ArtifactStore: { Type: 'S3', Location: 'b' },
  Stages: stages(runOrder),
  PipelineType: pipelineType,
});

describe('CodePipeline PipelineType (era ONE_OF) + Actions RunOrder (nested constant)', () => {
  it('folds the V2-era creation default + RunOrder=1 on a clean deploy', () => {
    const f = classifyResource(res, cleanLive('V2'), emptySchema);
    expect(tier(f, 'undeclared')).toEqual([]);
    expect(tier(f, 'atDefault')).toContain('PipelineType');
    expect(tier(f, 'atDefault').filter((p) => p.endsWith('RunOrder'))).toHaveLength(1);
  });
  it('folds the V1 era default too (same-template asymmetry)', () => {
    const f = classifyResource(res, cleanLive('V1'), emptySchema);
    expect(tier(f, 'atDefault')).toContain('PipelineType');
    expect(tier(f, 'undeclared')).toEqual([]);
  });
  it('surfaces an out-of-band RunOrder re-ordering — detection preserved', () => {
    const f = classifyResource(res, cleanLive('V2', 3), emptySchema);
    expect(tier(f, 'undeclared').filter((p) => p.endsWith('RunOrder'))).toHaveLength(1);
  });
  it('compares a DECLARED PipelineType in the declared dimension (unaffected)', () => {
    const declaredRes: DesiredResource = {
      ...res,
      declared: { ...res.declared, PipelineType: 'V1' },
    };
    const f = classifyResource(declaredRes, cleanLive('V2'), emptySchema);
    expect(tier(f, 'declared')).toContain('PipelineType');
  });
});

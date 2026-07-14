// #1610: a barest awsvpc-mode ECS service (NetworkConfiguration declared with
// Subnets only) materializes AssignPublicIp=DISABLED, which must fold to
// atDefault on a clean deploy while an out-of-band ENABLED flip (a real
// exposure change) still surfaces. Live-found on the 2026-07-14 hunt
// (fargate-hunt, CdkrdHunt0714Fargate).
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

const res: DesiredResource = {
  logicalId: 'HuntFargateSvc',
  resourceType: 'AWS::ECS::Service',
  physicalId: 'arn:aws:ecs:us-east-1:111122223333:service/c/svc',
  declared: {
    Cluster: 'c',
    TaskDefinition: 'td',
    LaunchType: 'FARGATE',
    DesiredCount: 0,
    NetworkConfiguration: { AwsvpcConfiguration: { Subnets: ['subnet-1'] } },
  },
};
const live = (assign: string) => ({
  Cluster: 'c',
  TaskDefinition: 'td',
  LaunchType: 'FARGATE',
  DesiredCount: 0,
  NetworkConfiguration: {
    AwsvpcConfiguration: { Subnets: ['subnet-1'], AssignPublicIp: assign },
  },
});

describe('ECS::Service AwsvpcConfiguration.AssignPublicIp (equality-gated constant)', () => {
  it('folds the DISABLED creation default on a clean deploy', () => {
    const f = classifyResource(res, live('DISABLED'), emptySchema);
    expect(tier(f, 'undeclared')).toEqual([]);
    expect(tier(f, 'atDefault')).toContain(
      'NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp'
    );
  });
  it('surfaces an out-of-band ENABLED flip — detection preserved', () => {
    const f = classifyResource(res, live('ENABLED'), emptySchema);
    expect(tier(f, 'undeclared')).toEqual([
      'NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp',
    ]);
  });
  it('compares a DECLARED AssignPublicIp in the declared dimension (unaffected)', () => {
    const declaredRes: DesiredResource = {
      ...res,
      declared: {
        ...res.declared,
        NetworkConfiguration: {
          AwsvpcConfiguration: { Subnets: ['subnet-1'], AssignPublicIp: 'DISABLED' },
        },
      },
    };
    const f = classifyResource(declaredRes, live('ENABLED'), emptySchema);
    expect(tier(f, 'declared')).toContain(
      'NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp'
    );
  });
});

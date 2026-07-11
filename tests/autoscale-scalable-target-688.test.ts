import { describe, expect, it } from 'vite-plus/test';
import { buildScalableTargetBands } from '../src/commands/gather.js';
import type { Desired } from '../src/desired/template-adapter.js';
import { applyAutoscalerBandFold, classifyResource } from '../src/diff/classify.js';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// #688: a declared property the stack DELEGATES to Application Auto Scaling (a sibling
// AWS::ApplicationAutoScaling::ScalableTarget whose ScalableDimension names it) surfaces as
// [CFn-Declared Drift] within minutes of a clean deploy — the autoscaler enforces MinCapacity,
// moving the live value above the declared initial. That is intent, not drift: gather builds the
// per-resource band map (buildScalableTargetBands), classify FOLDS a value within the declared
// [MinCapacity, MaxCapacity] band and SURFACES one outside it (marked non-revertable so a
// scaler-fighting write is refused).

// --- desired-model helpers -------------------------------------------------------------------

const desiredOf = (
  resources: DesiredResource[],
  liveAttrs: Record<string, Record<string, unknown>> = {}
): Desired => ({ resources, ctx: { liveAttrs } }) as unknown as Desired;

// ECS Service ScalableTarget: ResourceId built by CDK as `service/<cluster>/<serviceName>` via a
// GetAtt on the service — the raw form carries the Ref/GetAtt we link by.
const ecsScalableTarget = (over: Record<string, unknown> = {}): DesiredResource => ({
  logicalId: 'Target',
  resourceType: 'AWS::ApplicationAutoScaling::ScalableTarget',
  declared: {
    ScalableDimension: 'ecs:service:DesiredCount',
    ServiceNamespace: 'ecs',
    MinCapacity: 2,
    MaxCapacity: 4,
    ResourceId: 'service/my-cluster/my-service',
    ...over,
  },
  declaredRaw: {
    ScalableDimension: 'ecs:service:DesiredCount',
    ServiceNamespace: 'ecs',
    MinCapacity: 2,
    MaxCapacity: 4,
    ResourceId: {
      'Fn::Join': ['', ['service/', { Ref: 'Cluster' }, '/', { 'Fn::GetAtt': ['Svc', 'Name'] }]],
    },
    ...over,
  },
});

const ecsService = (): DesiredResource => ({
  logicalId: 'Svc',
  resourceType: 'AWS::ECS::Service',
  physicalId: 'my-service',
  declared: { DesiredCount: 1 },
});

const ecsCluster = (): DesiredResource => ({
  logicalId: 'Cluster',
  resourceType: 'AWS::ECS::Cluster',
  physicalId: 'my-cluster',
  declared: {},
});

describe('#688 buildScalableTargetBands', () => {
  it('links an ECS ScalableTarget to its Service by the Ref/GetAtt in the raw ResourceId', () => {
    const map = buildScalableTargetBands(
      desiredOf([ecsCluster(), ecsService(), ecsScalableTarget()])
    );
    expect(map.Svc).toEqual([{ path: 'DesiredCount', min: 2, max: 4 }]);
  });

  it('collects both read and write capacity bands for a DynamoDB table', () => {
    const table: DesiredResource = {
      logicalId: 'Table',
      resourceType: 'AWS::DynamoDB::Table',
      physicalId: 'my-table',
      declared: { ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 } },
    };
    const st = (dim: string, id: string): DesiredResource => ({
      logicalId: id,
      resourceType: 'AWS::ApplicationAutoScaling::ScalableTarget',
      declared: {
        ScalableDimension: dim,
        MinCapacity: 5,
        MaxCapacity: 50,
        ResourceId: 'table/my-table',
      },
      declaredRaw: {
        ScalableDimension: dim,
        MinCapacity: 5,
        MaxCapacity: 50,
        ResourceId: { 'Fn::Join': ['', ['table/', { Ref: 'Table' }]] },
      },
    });
    const map = buildScalableTargetBands(
      desiredOf([
        table,
        st('dynamodb:table:ReadCapacityUnits', 'R'),
        st('dynamodb:table:WriteCapacityUnits', 'W'),
      ])
    );
    expect(map.Table).toEqual([
      { path: 'ProvisionedThroughput.ReadCapacityUnits', min: 5, max: 50 },
      { path: 'ProvisionedThroughput.WriteCapacityUnits', min: 5, max: 50 },
    ]);
  });

  it('falls back to matching the resolved ResourceId string against a physical id (no raw refs)', () => {
    const st = ecsScalableTarget();
    delete (st as { declaredRaw?: unknown }).declaredRaw; // force the physicalId-string fallback
    const map = buildScalableTargetBands(desiredOf([ecsService(), st]));
    expect(map.Svc).toEqual([{ path: 'DesiredCount', min: 2, max: 4 }]);
  });

  it('takes the band from the live model when MinCapacity/MaxCapacity are not literal in the template', () => {
    const st = ecsScalableTarget({
      MinCapacity: { Ref: 'MinParam' },
      MaxCapacity: { Ref: 'MaxParam' },
    });
    const map = buildScalableTargetBands(
      desiredOf([ecsService(), st], { Target: { MinCapacity: 3, MaxCapacity: 9 } })
    );
    expect(map.Svc).toEqual([{ path: 'DesiredCount', min: 3, max: 9 }]);
  });

  it('skips an unrecognized ScalableDimension (fail-open, no fold)', () => {
    const st = ecsScalableTarget({ ScalableDimension: 'custom-resource:ResourceType:Property' });
    expect(buildScalableTargetBands(desiredOf([ecsService(), st]))).toEqual({});
  });

  it('skips when neither the template nor the live model gives a numeric band', () => {
    const st = ecsScalableTarget({ MinCapacity: { Ref: 'P' }, MaxCapacity: { Ref: 'Q' } });
    expect(buildScalableTargetBands(desiredOf([ecsService(), st]))).toEqual({});
  });
});

// --- pure fold -------------------------------------------------------------------------------

const declaredFinding = (over: Partial<Finding>): Finding => ({
  tier: 'declared',
  logicalId: 'Svc',
  resourceType: 'AWS::ECS::Service',
  path: 'DesiredCount',
  desired: 1,
  actual: 2,
  ...over,
});

describe('#688 applyAutoscalerBandFold', () => {
  const bands = [{ path: 'DesiredCount', min: 2, max: 4 }];

  it('DROPS a declared finding whose live value is within the declared band', () => {
    expect(applyAutoscalerBandFold([declaredFinding({ actual: 2 })], bands)).toEqual([]);
    expect(applyAutoscalerBandFold([declaredFinding({ actual: 4 })], bands)).toEqual([]);
  });

  it('KEEPS a value above the band, marked autoscalerGoverned with a hint', () => {
    const [f] = applyAutoscalerBandFold([declaredFinding({ actual: 7 })], bands);
    expect(f?.autoscalerGoverned).toBe(true);
    expect(f?.hint).toContain('Application Auto Scaling');
    expect(f?.tier).toBe('declared');
  });

  it('KEEPS a value below the band (an odd under-set) marked non-revertable', () => {
    const [f] = applyAutoscalerBandFold([declaredFinding({ actual: 0 })], bands);
    expect(f?.autoscalerGoverned).toBe(true);
  });

  it('leaves a finding at a non-governed path untouched', () => {
    const other = declaredFinding({ path: 'LaunchType', desired: 'EC2', actual: 'FARGATE' });
    expect(applyAutoscalerBandFold([other], bands)).toEqual([other]);
  });

  it('never touches a non-declared tier finding', () => {
    const undeclared = declaredFinding({ tier: 'undeclared', actual: 99 });
    expect(applyAutoscalerBandFold([undeclared], bands)).toEqual([undeclared]);
  });
});

// --- classify integration --------------------------------------------------------------------

const ecsSchema: SchemaInfo = {
  readOnly: new Set([]),
  writeOnly: new Set([]),
  createOnly: new Set([]),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};

describe('#688 classifyResource with scalableTargetBands', () => {
  const bands = { Svc: [{ path: 'DesiredCount', min: 2, max: 4 }] };

  it('folds the in-band DesiredCount drift (clean-deploy false positive)', () => {
    const findings = classifyResource(ecsService(), { DesiredCount: 2 }, ecsSchema, {
      scalableTargetBands: bands,
    });
    expect(findings.filter((f) => f.path === 'DesiredCount')).toEqual([]);
  });

  it('surfaces an out-of-band DesiredCount beyond the band, marked autoscalerGoverned', () => {
    const findings = classifyResource(ecsService(), { DesiredCount: 9 }, ecsSchema, {
      scalableTargetBands: bands,
    });
    const dc = findings.find((f) => f.path === 'DesiredCount');
    expect(dc?.tier).toBe('declared');
    expect(dc?.autoscalerGoverned).toBe(true);
  });

  it('without bands, the clean-deploy drift still surfaces (the bug being fixed)', () => {
    const findings = classifyResource(ecsService(), { DesiredCount: 2 }, ecsSchema, {});
    expect(findings.find((f) => f.path === 'DesiredCount')?.tier).toBe('declared');
  });
});

// --- revert guard ----------------------------------------------------------------------------

describe('#688 revert guard', () => {
  it('refuses to revert an autoscaler-governed finding (would fight the scaler)', () => {
    const f = declaredFinding({
      physicalId: 'my-service',
      actual: 9,
      autoscalerGoverned: true,
    });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toEqual([]);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]?.reason).toContain('Application Auto Scaling');
  });
});

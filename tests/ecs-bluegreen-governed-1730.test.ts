// #1730: an ECS blue/green deployment rewrites its production listener rule's forward action to
// a WEIGHTED ForwardConfig over {production TG, alternate TG} (the scalar TargetGroupArn member
// disappears; weights swing on every deployment) — a permanent declared FP on the rule before
// this fix (live-found 2026-08-09, modes-hunt). gather builds the governed-rule map
// (buildEcsBgGovernedListenerRules), classify FOLDS the rule's Actions declared drift while the
// live forward-target set stays within the declared pair, an outside target SURFACES marked
// ecsBlueGreenGoverned, and the revert plan refuses to fight the controller.
import { describe, expect, it } from 'vite-plus/test';
import { buildEcsBgGovernedListenerRules } from '../src/commands/gather.js';
import type { Desired } from '../src/desired/template-adapter.js';
import { applyEcsBlueGreenListenerRuleFold } from '../src/diff/classify.js';
import { buildRevertPlan } from '../src/revert/plan.js';
import type { DesiredResource, Finding } from '../src/types.js';

const BLUE_ARN = 'arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/blue/1111';
const GREEN_ARN = 'arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/green/2222';
const ROGUE_ARN = 'arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/rogue/9999';
const RULE_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:111122223333:listener-rule/app/lb/1/2/3333';

const desiredOf = (resources: DesiredResource[]): Desired =>
  ({ resources, ctx: { liveAttrs: {} } }) as unknown as Desired;

const bgService = (over: Record<string, unknown> = {}): DesiredResource =>
  ({
    logicalId: 'Svc',
    resourceType: 'AWS::ECS::Service',
    physicalId: 'my-service',
    declared: {
      DeploymentConfiguration: { Strategy: 'BLUE_GREEN' },
      LoadBalancers: [
        {
          ContainerName: 'web',
          ContainerPort: 80,
          TargetGroupArn: { Ref: 'BlueTg' },
          AdvancedConfiguration: {
            AlternateTargetGroupArn: { Ref: 'GreenTg' },
            ProductionListenerRule: { Ref: 'ProdRule' },
            RoleArn: 'arn:aws:iam::111122223333:role/infra',
          },
        },
      ],
      ...over,
    },
  }) as unknown as DesiredResource;

const tg = (logicalId: string, physicalId: string): DesiredResource =>
  ({
    logicalId,
    resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
    physicalId,
    declared: {},
  }) as unknown as DesiredResource;

const rule = (): DesiredResource =>
  ({
    logicalId: 'ProdRule',
    resourceType: 'AWS::ElasticLoadBalancingV2::ListenerRule',
    physicalId: RULE_ARN,
    declared: {},
  }) as unknown as DesiredResource;

const ruleFinding = (over: Partial<Finding> = {}): Finding => ({
  tier: 'declared',
  logicalId: 'ProdRule',
  resourceType: 'AWS::ElasticLoadBalancingV2::ListenerRule',
  path: 'Actions.0.TargetGroupArn',
  desired: BLUE_ARN,
  actual: undefined,
  ...over,
});

const weightedLive = (arns: [string, number][]): Record<string, unknown> => ({
  Actions: [
    {
      Type: 'forward',
      ForwardConfig: {
        TargetGroups: arns.map(([a, w]) => ({ TargetGroupArn: a, Weight: w })),
        TargetGroupStickinessConfig: { Enabled: false },
      },
    },
  ],
});

describe('#1730 buildEcsBgGovernedListenerRules', () => {
  it('registers the rule under BOTH identities with the resolved production+alternate TG ids', () => {
    const map = buildEcsBgGovernedListenerRules(
      desiredOf([bgService(), tg('BlueTg', BLUE_ARN), tg('GreenTg', GREEN_ARN), rule()])
    );
    expect(map.ProdRule).toEqual(expect.arrayContaining([BLUE_ARN, GREEN_ARN]));
    expect(map[RULE_ARN]).toEqual(expect.arrayContaining([BLUE_ARN, GREEN_ARN]));
  });

  it('resolved ARN strings (post-resolution declared shape) register directly', () => {
    const map = buildEcsBgGovernedListenerRules(
      desiredOf([
        bgService({
          LoadBalancers: [
            {
              TargetGroupArn: BLUE_ARN,
              AdvancedConfiguration: {
                AlternateTargetGroupArn: GREEN_ARN,
                ProductionListenerRule: RULE_ARN,
              },
            },
          ],
        }),
        rule(),
      ])
    );
    expect(map[RULE_ARN]).toEqual(expect.arrayContaining([BLUE_ARN, GREEN_ARN]));
    expect(map.ProdRule).toEqual(expect.arrayContaining([BLUE_ARN, GREEN_ARN]));
  });

  it('a service without AdvancedConfiguration produces no entries (rolling stays unfolded)', () => {
    const map = buildEcsBgGovernedListenerRules(
      desiredOf([
        bgService({ LoadBalancers: [{ TargetGroupArn: { Ref: 'BlueTg' } }] }),
        tg('BlueTg', BLUE_ARN),
        rule(),
      ])
    );
    expect(map).toEqual({});
  });
});

describe('#1730 applyEcsBlueGreenListenerRuleFold', () => {
  const allowed = [BLUE_ARN, GREEN_ARN];

  it('DROPS the rule drift while the live weighted targets stay within the declared pair', () => {
    for (const live of [
      weightedLive([
        [BLUE_ARN, 0],
        [GREEN_ARN, 100],
      ]),
      weightedLive([
        [BLUE_ARN, 100],
        [GREEN_ARN, 0],
      ]),
      weightedLive([[GREEN_ARN, 100]]),
    ]) {
      expect(applyEcsBlueGreenListenerRuleFold([ruleFinding()], allowed, live)).toEqual([]);
    }
  });

  it('KEEPS an outside-pair retarget, marked ecsBlueGreenGoverned with a hint', () => {
    const out = applyEcsBlueGreenListenerRuleFold(
      [ruleFinding()],
      allowed,
      weightedLive([
        [GREEN_ARN, 50],
        [ROGUE_ARN, 50],
      ])
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.ecsBlueGreenGoverned).toBe(true);
    expect(out[0]?.hint).toContain('blue/green');
  });

  it('leaves non-forward-target findings untouched', () => {
    const other = ruleFinding({ path: 'Conditions.0.Values', desired: ['/*'], actual: ['/x'] });
    const out = applyEcsBlueGreenListenerRuleFold(
      [other],
      allowed,
      weightedLive([[GREEN_ARN, 100]])
    );
    expect(out).toEqual([other]);
  });

  it('an EMPTY live target set keeps the finding (fail-open, never a hidden change)', () => {
    const out = applyEcsBlueGreenListenerRuleFold([ruleFinding()], allowed, { Actions: [] });
    expect(out).toHaveLength(1);
    expect(out[0]?.ecsBlueGreenGoverned).toBe(true);
  });
});

describe('#1730 revert guard', () => {
  it('refuses to revert an ECS-blue/green-governed finding (would fight the controller)', () => {
    const f = ruleFinding({ physicalId: RULE_ARN, ecsBlueGreenGoverned: true });
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items).toEqual([]);
    expect(plan.notRevertable).toHaveLength(1);
    expect(plan.notRevertable[0]?.reason).toContain('blue/green');
  });
});

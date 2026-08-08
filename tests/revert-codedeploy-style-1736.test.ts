// #1736 — CodeDeploy UpdateDeploymentGroup KEEPS an omitted DeploymentStyle and an omitted
// LoadBalancerInfo (the #1725 keep-omitted contract), so the bare CC `remove`s a revert
// plans for an out-of-band WITH_TRAFFIC_CONTROL flip (which attaches a target group) report
// SUCCESS while the live values persist — live-hit on the 2026-08-09 cdstyle-hunt, where a
// standalone target group made the previously "unreachable" off-default shape reachable.
// The fix: RSDP writes the #1723 KNOWN_DEFAULTS DeploymentStyle default explicitly
// (CC-patch-proven to converge even while LoadBalancerInfo is still attached), and
// LoadBalancerInfo — which has no KNOWN_DEFAULTS source — writes the explicit empty
// TargetGroupInfoList from REVERT_SET_DEFAULT_VALUES (CC-patch-proven: the service reads
// back `loadBalancerInfo: null` afterwards).
import { describe, expect, it } from 'vite-plus/test';
import { KNOWN_DEFAULTS } from '../src/normalize/noise.js';
import { buildRevertPlan, REVERT_SET_DEFAULT_PATHS } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

const TYPE = 'AWS::CodeDeploy::DeploymentGroup';

function finding(path: string, actual: unknown): Finding {
  return {
    tier: 'undeclared',
    logicalId: 'CdGroup',
    physicalId: 'cdkrd-hunt-cd-0809b|cdkrd-hunt-dg-0809b',
    resourceType: TYPE,
    path,
    actual,
  };
}

describe('#1736: CodeDeploy DeploymentGroup DeploymentStyle/LoadBalancerInfo revert as explicit writes', () => {
  it('both RSDP entries exist', () => {
    expect(REVERT_SET_DEFAULT_PATHS.has(`${TYPE}\0DeploymentStyle`)).toBe(true);
    expect(REVERT_SET_DEFAULT_PATHS.has(`${TYPE}\0LoadBalancerInfo`)).toBe(true);
  });

  it('an OOB DeploymentStyle flip plans an add writing the KNOWN_DEFAULTS default, not a bare remove', () => {
    const f = finding('DeploymentStyle', {
      DeploymentType: 'IN_PLACE',
      DeploymentOption: 'WITH_TRAFFIC_CONTROL',
    });
    const plan = buildRevertPlan([f], undefined);
    const op = plan.items[0]!.ops[0]!;
    expect(op.op).toBe('add');
    expect(op.value).toEqual((KNOWN_DEFAULTS[TYPE] as Record<string, unknown>)['DeploymentStyle']);
    expect(op.value).toEqual({
      DeploymentType: 'IN_PLACE',
      DeploymentOption: 'WITHOUT_TRAFFIC_CONTROL',
    });
  });

  it('an appeared LoadBalancerInfo plans an explicit empty TargetGroupInfoList write, not a bare remove', () => {
    const f = finding('LoadBalancerInfo', {
      TargetGroupInfoList: [{ Name: 'cdkrd-hunt-tg-0809' }],
    });
    const plan = buildRevertPlan([f], undefined);
    const op = plan.items[0]!.ops[0]!;
    expect(op.op).toBe('add');
    expect(op.value).toEqual({ TargetGroupInfoList: [] });
  });
});

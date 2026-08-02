// #1725 — CodeDeploy UpdateDeploymentGroup KEEPS an omitted DeploymentConfigName, so the
// bare CC `remove` a revert plans for an out-of-band config-name change reports SUCCESS
// while the live value persists (silent no-op, live-hit on the 2026-08-03 enum-added2
// hunt). The RSDP entry makes revert write the #1723 KNOWN_DEFAULTS default
// (CodeDeployDefault.OneAtATime) explicitly — the explicit CC `add` was stackless-probed
// to converge the same day.
import { describe, expect, it } from 'vite-plus/test';
import { KNOWN_DEFAULTS } from '../src/normalize/noise.js';
import { buildRevertPlan, REVERT_SET_DEFAULT_PATHS } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

describe('#1725: CodeDeploy DeploymentGroup DeploymentConfigName reverts as an explicit set-default', () => {
  it('the RSDP entry exists', () => {
    expect(
      REVERT_SET_DEFAULT_PATHS.has('AWS::CodeDeploy::DeploymentGroup\0DeploymentConfigName')
    ).toBe(true);
  });

  it('plans an add op writing the KNOWN_DEFAULTS default, not a bare remove', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'CdGroup',
      physicalId: 'cdkrd-hunt-cd-0803|cdkrd-hunt-dg-0803',
      resourceType: 'AWS::CodeDeploy::DeploymentGroup',
      path: 'DeploymentConfigName',
      actual: 'CodeDeployDefault.AllAtOnce',
    };
    const plan = buildRevertPlan([f], undefined);
    const op = plan.items[0]!.ops[0]!;
    expect(op.op).toBe('add');
    expect(op.value).toBe(
      (KNOWN_DEFAULTS['AWS::CodeDeploy::DeploymentGroup'] as Record<string, unknown>)[
        'DeploymentConfigName'
      ]
    );
    expect(op.value).toBe('CodeDeployDefault.OneAtATime');
  });
});

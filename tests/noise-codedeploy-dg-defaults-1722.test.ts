// #1722: two first-run FPs on a minimal AWS::CodeDeploy::DeploymentGroup (just
// ApplicationName + ServiceRoleArn + a group name — the CDK L1 minimal shape). A group
// that declares neither DeploymentStyle nor DeploymentConfigName reads back the
// documented creation defaults, which surfaced as [Potential Drift] on a first check.
// The corpus Group case declares BOTH leaves, which is why replay never caught it (the
// #615-class apparent-coverage trap). Both are stable constants → tier-1 equality-gated
// KNOWN_DEFAULTS, so an out-of-band switch (BLUE_GREEN / WITH_TRAFFIC_CONTROL, or a
// different deployment config) still surfaces. Live-repro'd 2026-08-03 on
// Cdkrd1718Verify (us-east-1) during PR #1721's verification; reproduced on the
// released 0.24.0 binary too (pre-existing, not an enumerator artifact).
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

const tierPaths = (findings: Finding[]) => findings.map((f) => `${f.tier}:${f.path}`).sort();

// The minimal declared shape from the live repro (Cdkrd1718Verify's CdGroup).
const group: DesiredResource = {
  logicalId: 'CdGroup',
  resourceType: 'AWS::CodeDeploy::DeploymentGroup',
  physicalId: 'cdkrd1718-declared-dg',
  declared: {
    ApplicationName: 'cdkrd1718-cd-app',
    DeploymentGroupName: 'cdkrd1718-declared-dg',
    ServiceRoleArn: 'arn:aws:iam::111111111111:role/cdkrd1718-codedeploy-role',
  },
};

const live = (style: Record<string, unknown>, configName: string) => ({
  ApplicationName: 'cdkrd1718-cd-app',
  DeploymentGroupName: 'cdkrd1718-declared-dg',
  ServiceRoleArn: 'arn:aws:iam::111111111111:role/cdkrd1718-codedeploy-role',
  DeploymentStyle: style,
  DeploymentConfigName: configName,
  OutdatedInstancesStrategy: 'UPDATE',
  AutoScalingGroups: [],
  Ec2TagFilters: [],
  OnPremisesInstanceTagFilters: [],
  ECSServices: [],
  TerminationHookEnabled: false,
});

const DEFAULT_STYLE = {
  DeploymentType: 'IN_PLACE',
  DeploymentOption: 'WITHOUT_TRAFFIC_CONTROL',
};

describe('#1722 CodeDeploy DeploymentGroup first-run default folds', () => {
  it('folds the undeclared creation defaults to atDefault (zero potential drift)', () => {
    const f = classifyResource(
      group,
      live(DEFAULT_STYLE, 'CodeDeployDefault.OneAtATime'),
      emptySchema
    );
    expect(tierPaths(f)).toEqual([
      'atDefault:DeploymentConfigName',
      'atDefault:DeploymentStyle',
      'atDefault:OutdatedInstancesStrategy',
    ]);
  });

  it('still surfaces an out-of-band deployment config change (equality-gated)', () => {
    const f = classifyResource(
      group,
      live(DEFAULT_STYLE, 'CodeDeployDefault.AllAtOnce'),
      emptySchema
    );
    expect(tierPaths(f)).toContain('undeclared:DeploymentConfigName');
    expect(tierPaths(f)).not.toContain('undeclared:DeploymentStyle');
  });

  it('still surfaces an out-of-band BLUE_GREEN / WITH_TRAFFIC_CONTROL style (equality-gated)', () => {
    const f = classifyResource(
      group,
      live(
        { DeploymentType: 'BLUE_GREEN', DeploymentOption: 'WITH_TRAFFIC_CONTROL' },
        'CodeDeployDefault.OneAtATime'
      ),
      emptySchema
    );
    expect(tierPaths(f)).toContain('undeclared:DeploymentStyle');
    expect(tierPaths(f)).not.toContain('undeclared:DeploymentConfigName');
  });
});

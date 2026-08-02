// #1718 — two parents added to CHILD_ENUMERATORS (the lower-priority remainder of
// #1713) so their out-of-band-added children surface in the `added` tier: CodeDeploy
// Application (DeploymentGroup — an OOB group is a deployment surface that can push
// arbitrary revisions to a fleet) and ElasticBeanstalk Application (ApplicationVersion
// / ConfigurationTemplate — an OOB version stages a deployable bundle, an OOB saved
// configuration changes what a template-based launch materializes). Pure-diff units
// below; identifiers mirror router.ts CC_IDENTIFIER_ADAPTERS composite orders
// (parent-first `compositeWith('ApplicationName')` for all three child types), and
// siblingLookupId always carries the bare CFn physical id for the sibling-stack
// membership check.
import { describe, expect, it } from 'vite-plus/test';
import {
  CHILD_ENUMERATORS,
  diffCodeDeployApplicationChildren,
  diffElasticBeanstalkApplicationChildren,
} from '../src/read/child-enumerators.js';

describe('#1718 CodeDeploy application children', () => {
  const APP = 'MyStack-App-XzN9elTm5vrt';

  it('emits an OOB deployment group with the PARENT-first composite id (router.ts order)', () => {
    const added = diffCodeDeployApplicationChildren({
      applicationName: APP,
      declaredGroupNames: ['declared-dg'],
      liveGroupNames: ['declared-dg', 'oob-dg'],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::CodeDeploy::DeploymentGroup',
        identifier: `${APP}|oob-dg`,
        label: 'oob-dg',
        live: { ApplicationName: APP, DeploymentGroupName: 'oob-dg' },
        siblingLookupId: 'oob-dg',
      },
    ]);
  });

  it('declared groups are never flagged', () => {
    expect(
      diffCodeDeployApplicationChildren({
        applicationName: APP,
        declaredGroupNames: ['declared-dg'],
        liveGroupNames: ['declared-dg'],
      })
    ).toEqual([]);
  });
});

describe('#1718 Elastic Beanstalk application children', () => {
  const APP = 'cdkrd-eb-app';
  const base = {
    applicationName: APP,
    declaredVersionLabels: [] as string[],
    declaredTemplateNames: [] as string[],
    liveVersionLabels: [] as string[],
    liveTemplateNames: [] as string[],
  };

  it('emits an OOB application version with the PARENT-first composite id (Id == version label)', () => {
    const added = diffElasticBeanstalkApplicationChildren({
      ...base,
      declaredVersionLabels: ['mystack-version-d82hufheyxde'],
      liveVersionLabels: ['mystack-version-d82hufheyxde', 'oob-v1'],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::ElasticBeanstalk::ApplicationVersion',
        identifier: `${APP}|oob-v1`,
        label: 'oob-v1',
        live: { ApplicationName: APP, Id: 'oob-v1' },
        siblingLookupId: 'oob-v1',
      },
    ]);
  });

  it('emits an OOB configuration template too', () => {
    const added = diffElasticBeanstalkApplicationChildren({
      ...base,
      declaredTemplateNames: ['MyStack-EbTemplate-wwcSqIxxE8f2'],
      liveTemplateNames: ['MyStack-EbTemplate-wwcSqIxxE8f2', 'oob-saved-config'],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::ElasticBeanstalk::ConfigurationTemplate',
        identifier: `${APP}|oob-saved-config`,
        label: 'oob-saved-config',
        live: { ApplicationName: APP, TemplateName: 'oob-saved-config' },
        siblingLookupId: 'oob-saved-config',
      },
    ]);
  });

  it('declared children are never flagged', () => {
    expect(
      diffElasticBeanstalkApplicationChildren({
        ...base,
        declaredVersionLabels: ['v-declared'],
        declaredTemplateNames: ['t-declared'],
        liveVersionLabels: ['v-declared'],
        liveTemplateNames: ['t-declared'],
      })
    ).toEqual([]);
  });
});

describe('#1718 registry wiring', () => {
  it('both parents are registered in CHILD_ENUMERATORS', () => {
    expect(CHILD_ENUMERATORS['AWS::CodeDeploy::Application']).toBeTypeOf('function');
    expect(CHILD_ENUMERATORS['AWS::ElasticBeanstalk::Application']).toBeTypeOf('function');
  });
});

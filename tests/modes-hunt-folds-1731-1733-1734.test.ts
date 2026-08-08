// 2026-08-09 modes-hunt first-run FP folds (live-found on CdkrdHunt0809Modes, us-east-1):
// - #1733: a PARTIALLY-declared ECS DeploymentConfiguration (a blue/green service declaring
//   only Strategy + BakeTimeInMinutes) is filled with MaximumPercent=200 /
//   MinimumHealthyPercent=100 — the CDK L2 always declares them, so only the partial raw-CFn
//   shape leaked (the #1701 partial-fill dimension).
// - #1734: a barest CloudFront VpcOrigin fills the legacy OriginSSLProtocols default.
// - #1731: CloudFront's VPC-origin service security group is tagged in the DOT namespace
//   (`aws.cloudfront.vpcorigin=enabled`), which the aws:-prefix filter missed — it was flagged
//   as a rogue added SG.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { isAwsManagedSecurityGroup } from '../src/read/child-enumerators.js';
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

const surfaced = (findings: Finding[]) =>
  findings.filter((f) => f.tier === 'declared' || f.tier === 'undeclared').map((f) => f.path);

describe('#1733 partial-declared ECS DeploymentConfiguration fill', () => {
  const svc: DesiredResource = {
    logicalId: 'BgService',
    resourceType: 'AWS::ECS::Service',
    physicalId: 'cdkrd-hunt-0809-bg',
    declared: {
      ServiceName: 'cdkrd-hunt-0809-bg',
      DeploymentConfiguration: { Strategy: 'BLUE_GREEN', BakeTimeInMinutes: 0 },
    },
  };

  it('folds the service-filled rollout band defaults to atDefault', () => {
    const findings = classifyResource(
      svc,
      {
        ServiceName: 'cdkrd-hunt-0809-bg',
        DeploymentConfiguration: {
          Strategy: 'BLUE_GREEN',
          BakeTimeInMinutes: 0,
          MaximumPercent: 200,
          MinimumHealthyPercent: 100,
        },
      },
      emptySchema,
      {}
    );
    expect(surfaced(findings)).toEqual([]);
    expect(
      findings.some(
        (f) => f.tier === 'atDefault' && f.path === 'DeploymentConfiguration.MaximumPercent'
      )
    ).toBe(true);
  });

  it('an out-of-band non-default band still surfaces (equality-gated)', () => {
    const findings = classifyResource(
      svc,
      {
        ServiceName: 'cdkrd-hunt-0809-bg',
        DeploymentConfiguration: {
          Strategy: 'BLUE_GREEN',
          BakeTimeInMinutes: 0,
          MaximumPercent: 150,
          MinimumHealthyPercent: 100,
        },
      },
      emptySchema,
      {}
    );
    expect(surfaced(findings)).toEqual(['DeploymentConfiguration.MaximumPercent']);
  });
});

describe('#1734 barest CloudFront VpcOrigin OriginSSLProtocols fill', () => {
  const vpco: DesiredResource = {
    logicalId: 'VpcOrigin',
    resourceType: 'AWS::CloudFront::VpcOrigin',
    physicalId: 'vo-123',
    declared: {
      VpcOriginEndpointConfig: {
        Name: 'cdkrd-hunt-0809-vpco',
        Arn: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:loadbalancer/app/x/1',
      },
    },
  };
  const live = (protocols: string[]) => ({
    VpcOriginEndpointConfig: {
      Name: 'cdkrd-hunt-0809-vpco',
      Arn: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:loadbalancer/app/x/1',
      OriginSSLProtocols: protocols,
    },
  });

  it('folds the legacy SSL-protocols service default to atDefault', () => {
    const findings = classifyResource(vpco, live(['SSLv3', 'TLSv1']), emptySchema, {});
    expect(surfaced(findings)).toEqual([]);
  });

  it('an out-of-band hardened protocol list still surfaces (equality-gated)', () => {
    const findings = classifyResource(vpco, live(['TLSv1.2']), emptySchema, {});
    expect(surfaced(findings)).toEqual(['VpcOriginEndpointConfig.OriginSSLProtocols']);
  });
});

describe('#1731 CloudFront VPC-origin service SG recognition', () => {
  it('recognizes the aws.cloudfront.vpcorigin dot-namespace service tag', () => {
    expect(isAwsManagedSecurityGroup([{ Key: 'aws.cloudfront.vpcorigin', Value: 'enabled' }])).toBe(
      true
    );
  });

  it('does NOT treat other unreserved dot-namespace tags as AWS-managed', () => {
    expect(isAwsManagedSecurityGroup([{ Key: 'aws.something.else', Value: 'x' }])).toBe(false);
    expect(isAwsManagedSecurityGroup([{ Key: 'team', Value: 'core' }])).toBe(false);
    expect(isAwsManagedSecurityGroup(undefined)).toBe(false);
  });
});

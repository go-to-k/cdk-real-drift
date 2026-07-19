import { describe, expect, it } from 'vite-plus/test';
import { buildCloudFrontStagingDistCdPolicyIds } from '../src/commands/gather.js';
import type { Desired } from '../src/desired/template-adapter.js';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// First-run FPs found by the 2026-07-20 cloudfront-cd-hunt (a fresh two-phase continuous-
// deployment stack: staging distribution + ContinuousDeploymentPolicy + primary attached via
// UPDATE):
//   1. The policy's config carries the SAME traffic split in TWO writable representations —
//      the canonical `TrafficConfig` and the flattened console-era synonyms (`Type` +
//      `SingleWeightPolicyConfig`) — and the CC read echoes BOTH. The undeclared mirror
//      first-run-FP'd (`Type: "SingleWeight"`, `SingleWeightPolicyConfig: {Weight: 0.05}`).
//      Fold: tier-2 derived from the DECLARED counterpart representation, symmetric.
//   2. The STAGING distribution materializes the reverse pointer
//      `DistributionConfig.ContinuousDeploymentPolicyId` to the in-stack policy that lists its
//      DNS name (sibling-attachment echo). Fold: tier-2 sibling-derived
//      (gather.buildCloudFrontStagingDistCdPolicyIds), equality-gated so an out-of-band
//      re-link to a DIFFERENT policy still surfaces.

const emptySchema: SchemaInfo = {
  readOnly: new Set(['Id', 'LastModifiedTime']),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: ['Id', 'LastModifiedTime'],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};

const POLICY_ID = '6fd4a2bb-b335-437f-83a0-1a7a9635666d';

const byPath = (findings: Finding[], path: string) => findings.filter((f) => f.path === path);

describe('CloudFront ContinuousDeploymentPolicy traffic-config synonym echo', () => {
  const policyResource = (declaredCfg: Record<string, unknown>): DesiredResource => ({
    logicalId: 'CdPolicy',
    resourceType: 'AWS::CloudFront::ContinuousDeploymentPolicy',
    physicalId: POLICY_ID,
    declared: { ContinuousDeploymentPolicyConfig: declaredCfg },
  });

  // The live CC read the hunt observed: both representations echoed.
  const liveCfg = (over?: Record<string, unknown>): Record<string, unknown> => ({
    ContinuousDeploymentPolicyConfig: {
      Enabled: true,
      StagingDistributionDnsNames: ['d2zvi88nqbrjcw.cloudfront.net'],
      TrafficConfig: { Type: 'SingleWeight', SingleWeightConfig: { Weight: 0.05 } },
      Type: 'SingleWeight',
      SingleWeightPolicyConfig: { Weight: 0.05 },
      ...over,
    },
  });

  const declaredTraffic = {
    Enabled: true,
    StagingDistributionDnsNames: ['d2zvi88nqbrjcw.cloudfront.net'],
    TrafficConfig: { Type: 'SingleWeight', SingleWeightConfig: { Weight: 0.05 } },
  };

  it('folds the undeclared flattened mirror of a declared TrafficConfig to atDefault', () => {
    const got = classifyResource(policyResource(declaredTraffic), liveCfg(), emptySchema);
    for (const path of [
      'ContinuousDeploymentPolicyConfig.Type',
      'ContinuousDeploymentPolicyConfig.SingleWeightPolicyConfig',
    ]) {
      const f = byPath(got, path);
      expect(f).toHaveLength(1);
      expect(f[0]?.tier).toBe('atDefault');
    }
  });

  it('a mirror DIVERGED from the declared traffic config still surfaces (detection kept)', () => {
    const got = classifyResource(
      policyResource(declaredTraffic),
      liveCfg({ SingleWeightPolicyConfig: { Weight: 0.15 } }),
      emptySchema
    );
    const f = byPath(got, 'ContinuousDeploymentPolicyConfig.SingleWeightPolicyConfig');
    expect(f).toHaveLength(1);
    expect(f[0]?.tier).toBe('undeclared');
  });

  it('the INVERSE declaration (flattened form declared) folds the undeclared TrafficConfig mirror', () => {
    const declaredFlattened = {
      Enabled: true,
      StagingDistributionDnsNames: ['d2zvi88nqbrjcw.cloudfront.net'],
      Type: 'SingleWeight',
      SingleWeightPolicyConfig: { Weight: 0.05 },
    };
    const got = classifyResource(policyResource(declaredFlattened), liveCfg(), emptySchema);
    const f = byPath(got, 'ContinuousDeploymentPolicyConfig.TrafficConfig');
    expect(f).toHaveLength(1);
    expect(f[0]?.tier).toBe('atDefault');
  });
});

describe('CloudFront staging distribution reverse-pointer echo (sibling map)', () => {
  const distDeclared = {
    DistributionConfig: {
      Enabled: true,
      Staging: true,
      Origins: [
        {
          Id: 'origin1',
          DomainName: 'example.com',
          CustomOriginConfig: { OriginProtocolPolicy: 'https-only' },
        },
      ],
      DefaultCacheBehavior: {
        TargetOriginId: 'origin1',
        ViewerProtocolPolicy: 'allow-all',
        CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
      },
    },
  };
  const stagingResource: DesiredResource = {
    logicalId: 'StagingDist',
    resourceType: 'AWS::CloudFront::Distribution',
    physicalId: 'E2ABCDEF123456',
    declared: distDeclared,
  };
  const liveDist = (policyId: string): Record<string, unknown> => ({
    DistributionConfig: {
      ...distDeclared.DistributionConfig,
      ContinuousDeploymentPolicyId: policyId,
    },
  });

  const desiredWithPolicy = (policyPhysicalId?: string): Desired =>
    ({
      resources: [
        stagingResource,
        {
          logicalId: 'CdPolicy',
          resourceType: 'AWS::CloudFront::ContinuousDeploymentPolicy',
          physicalId: policyPhysicalId,
          declared: {
            ContinuousDeploymentPolicyConfig: {
              Enabled: true,
              StagingDistributionDnsNames: [{ 'Fn::GetAtt': ['StagingDist', 'DomainName'] }],
              TrafficConfig: { Type: 'SingleWeight', SingleWeightConfig: { Weight: 0.05 } },
            },
          },
        },
      ],
    }) as unknown as Desired;

  it('(map) links the staging distribution to the policy via the GetAtt DNS-name reference', () => {
    const map = buildCloudFrontStagingDistCdPolicyIds(desiredWithPolicy(POLICY_ID));
    expect(map).toEqual({ StagingDist: POLICY_ID, E2ABCDEF123456: POLICY_ID });
  });

  it('(map) a policy without a physical id degrades to null (fail open)', () => {
    const map = buildCloudFrontStagingDistCdPolicyIds(desiredWithPolicy(undefined));
    expect(map).toEqual({ StagingDist: null, E2ABCDEF123456: null });
  });

  it('(map) links via the RESOLVED literal DNS name against the live DomainName (the classify-time shape)', () => {
    // At classify time the declared model is re-resolved: the GetAtt has collapsed to the
    // literal domain string, so the link is recovered from the distribution's LIVE DomainName.
    const desired = {
      resources: [
        stagingResource,
        {
          logicalId: 'CdPolicy',
          resourceType: 'AWS::CloudFront::ContinuousDeploymentPolicy',
          physicalId: POLICY_ID,
          declared: {
            ContinuousDeploymentPolicyConfig: {
              Enabled: true,
              StagingDistributionDnsNames: ['d2zvi88nqbrjcw.cloudfront.net'],
              TrafficConfig: { Type: 'SingleWeight', SingleWeightConfig: { Weight: 0.05 } },
            },
          },
        },
      ],
    } as unknown as Desired;
    const liveByLogical = new Map<string, Record<string, unknown>>([
      ['StagingDist', { DomainName: 'd2zvi88nqbrjcw.cloudfront.net' }],
    ]);
    expect(buildCloudFrontStagingDistCdPolicyIds(desired, liveByLogical)).toEqual({
      StagingDist: POLICY_ID,
      E2ABCDEF123456: POLICY_ID,
    });
    // Without the live map the literal is unmatchable → nothing mapped (pointer would surface).
    expect(buildCloudFrontStagingDistCdPolicyIds(desired)).toEqual({});
  });

  it('folds the reverse pointer equal to the sibling policy id to atDefault', () => {
    const got = classifyResource(stagingResource, liveDist(POLICY_ID), emptySchema, {
      siblingCloudFrontCdPolicyIds: buildCloudFrontStagingDistCdPolicyIds(
        desiredWithPolicy(POLICY_ID)
      ),
    });
    const f = byPath(got, 'DistributionConfig.ContinuousDeploymentPolicyId');
    expect(f).toHaveLength(1);
    expect(f[0]?.tier).toBe('atDefault');
  });

  it('a pointer to a DIFFERENT policy surfaces (out-of-band re-link)', () => {
    const got = classifyResource(
      stagingResource,
      liveDist('0000dead-beef-0000-0000-000000000000'),
      emptySchema,
      {
        siblingCloudFrontCdPolicyIds: buildCloudFrontStagingDistCdPolicyIds(
          desiredWithPolicy(POLICY_ID)
        ),
      }
    );
    const f = byPath(got, 'DistributionConfig.ContinuousDeploymentPolicyId');
    expect(f).toHaveLength(1);
    expect(f[0]?.tier).toBe('undeclared');
  });

  it('with NO declared policy the pointer surfaces (out-of-band link)', () => {
    const got = classifyResource(stagingResource, liveDist(POLICY_ID), emptySchema, {
      siblingCloudFrontCdPolicyIds: {},
    });
    const f = byPath(got, 'DistributionConfig.ContinuousDeploymentPolicyId');
    expect(f).toHaveLength(1);
    expect(f[0]?.tier).toBe('undeclared');
  });
});

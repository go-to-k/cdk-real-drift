// First-run fold gaps + a declared reorder cascade mined from the 2026-07-11 bug hunt:
//   #1459 — CloudFront custom-origin OriginSSLProtocols + IPV6Enabled undeclared creation
//           defaults surfacing as first-run [Potential Drift].
//   #1455 — Route53Resolver FirewallRuleGroupAssociation undeclared MutationProtection
//           default "DISABLED" surfacing as first-run [Potential Drift].
//   #1458 — CloudFront CustomErrorResponses echoed ErrorCode-sorted, cascading a
//           non-ascending declaration into several bogus DECLARED drifts.
// Each fold is equality-gated (or identity-aligned), so a genuine divergence still surfaces.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import {
  NESTED_OBJECT_ARRAY_IDENTITY,
  UNORDERED_NESTED_OBJECT_ARRAY_PATHS,
} from '../src/normalize/noise.js';
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

const pathsByTier = (findings: Finding[], tier: string) =>
  findings
    .filter((f) => f.tier === tier)
    .map((f) => f.path)
    .sort();

describe('#1459 CloudFront custom-origin OriginSSLProtocols + IPV6Enabled defaults', () => {
  // A minimal custom-origin distribution declaring neither OriginSSLProtocols nor IPV6Enabled.
  const res: DesiredResource = {
    logicalId: 'Dist',
    resourceType: 'AWS::CloudFront::Distribution',
    physicalId: 'E123ABC',
    declared: {
      DistributionConfig: {
        Enabled: true,
        DefaultCacheBehavior: { TargetOriginId: 'origin1', ViewerProtocolPolicy: 'allow-all' },
        Origins: [
          {
            Id: 'origin1',
            DomainName: 'example.com',
            CustomOriginConfig: { OriginProtocolPolicy: 'https-only' },
          },
        ],
      },
    },
  };
  const live = (over: { ssl?: unknown; ipv6?: unknown }) => ({
    DistributionConfig: {
      Enabled: true,
      IPV6Enabled: over.ipv6 ?? true,
      DefaultCacheBehavior: { TargetOriginId: 'origin1', ViewerProtocolPolicy: 'allow-all' },
      Origins: [
        {
          Id: 'origin1',
          DomainName: 'example.com',
          CustomOriginConfig: {
            OriginProtocolPolicy: 'https-only',
            HTTPPort: 80,
            HTTPSPort: 443,
            OriginKeepaliveTimeout: 5,
            OriginSSLProtocols: over.ssl ?? ['SSLv3', 'TLSv1'],
          },
        },
      ],
    },
  });

  // Live findings key an identity-bearing array element by its Id (`Origins[origin1]`),
  // not a positional index.
  const SSL_PATH = 'DistributionConfig.Origins[origin1].CustomOriginConfig.OriginSSLProtocols';

  it('folds the undeclared creation defaults to atDefault (zero first-run drift)', () => {
    const f = classifyResource(res, live({}), emptySchema);
    const atDefault = pathsByTier(f, 'atDefault');
    expect(atDefault).toContain('DistributionConfig.IPV6Enabled');
    expect(atDefault).toContain(SSL_PATH);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces an out-of-band tightened OriginSSLProtocols as undeclared (equality gate)', () => {
    const f = classifyResource(res, live({ ssl: ['TLSv1.2'] }), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain(SSL_PATH);
    // The other undeclared creation defaults still fold — only the changed one surfaces.
    expect(pathsByTier(f, 'atDefault')).toContain('DistributionConfig.IPV6Enabled');
  });

  // #660 item 3: an out-of-band IPV6Enabled=false disable — a nested `false` that used to be
  // swallowed by isTrivialEmpty before the pin gate — now surfaces as `undeclared` via the
  // nested MEANINGFUL_WHEN_OFF twin, while the clean `true` still folds atDefault (above).
  it('surfaces an out-of-band undeclared IPV6Enabled=false disable as undeclared (#660)', () => {
    const f = classifyResource(res, live({ ipv6: false }), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('DistributionConfig.IPV6Enabled');
    // The sibling undeclared creation defaults still fold — only the disabled flag surfaces.
    expect(pathsByTier(f, 'atDefault')).toContain(SSL_PATH);
  });
});

describe('#1455 Route53Resolver FirewallRuleGroupAssociation MutationProtection default', () => {
  const res: DesiredResource = {
    logicalId: 'DnsFwAssoc',
    resourceType: 'AWS::Route53Resolver::FirewallRuleGroupAssociation',
    physicalId: 'rslvr-frgassoc-abc',
    declared: {
      FirewallRuleGroupId: 'rslvr-frg-1',
      VpcId: 'vpc-1',
      Priority: 101,
      Name: 'x',
    },
  };
  it('folds the undeclared "DISABLED" default to atDefault', () => {
    const f = classifyResource(res, { MutationProtection: 'DISABLED' }, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('MutationProtection');
    expect(pathsByTier(f, 'undeclared')).not.toContain('MutationProtection');
  });
  it('surfaces an out-of-band ENABLED as undeclared', () => {
    const f = classifyResource(res, { MutationProtection: 'ENABLED' }, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('MutationProtection');
  });
});

describe('#1458 CloudFront CustomErrorResponses is an ErrorCode-keyed set (no reorder cascade)', () => {
  // The template lists them 500/403/404 (natural SPA order); CloudFront echoes them sorted
  // ascending by ErrorCode (403/404/500).
  const mk = (declaredOrder: number[]): DesiredResource => ({
    logicalId: 'Dist',
    resourceType: 'AWS::CloudFront::Distribution',
    physicalId: 'E123ABC',
    declared: {
      DistributionConfig: {
        Enabled: true,
        CustomErrorResponses: declaredOrder.map((c) => ({
          ErrorCode: c,
          ResponseCode: 200,
          ResponsePagePath: `/e${c}.html`,
        })),
      },
    },
  });
  const liveSorted = (paths: Record<number, string>) => ({
    DistributionConfig: {
      Enabled: true,
      CustomErrorResponses: [403, 404, 500].map((c) => ({
        ErrorCode: c,
        ResponseCode: 200,
        ResponsePagePath: paths[c] ?? `/e${c}.html`,
      })),
    },
  });

  it('registers CustomErrorResponses as an ErrorCode-keyed unordered nested set', () => {
    expect(UNORDERED_NESTED_OBJECT_ARRAY_PATHS['AWS::CloudFront::Distribution']).toContain(
      'DistributionConfig.CustomErrorResponses'
    );
    expect(NESTED_OBJECT_ARRAY_IDENTITY['AWS::CloudFront::Distribution']).toMatchObject({
      'DistributionConfig.CustomErrorResponses': 'ErrorCode',
    });
  });

  it('produces zero declared drift when the only difference is declaration order', () => {
    const f = classifyResource(mk([500, 403, 404]), liveSorted({}), emptySchema);
    expect(pathsByTier(f, 'declared')).toEqual([]);
  });

  it('surfaces a real out-of-band ResponsePagePath change as a single aligned finding', () => {
    // 404's page was changed out of band; the identity-keyed sort keeps 404 in the same
    // slot on both sides, so exactly one aligned finding surfaces (no positional cascade).
    const f = classifyResource(mk([500, 403, 404]), liveSorted({ 404: '/oops.html' }), emptySchema);
    const declared = pathsByTier(f, 'declared');
    expect(declared.length).toBe(1);
    expect(declared[0]).toContain('CustomErrorResponses');
    expect(declared[0]).toContain('ResponsePagePath');
  });
});

// #1547 / #1548 — two child-enumerator defects live-proven on CdkrdHunt0713bNetVariants
// (us-east-1, 2026-07-13):
//   * #1547: MSK Serverless plants a SERVICE-MANAGED interface endpoint in the customer
//     VPC (tagged AWSMSKManaged=true + ClusterArn=...); the VPC endpoint scan flagged it
//     as out-of-band `added` on every check. The scan now drops endpoints carrying a
//     curated service-managed marker tag; user endpoints (no marker) still surface.
//   * #1548: a gateway (GWLB) listener has no rules concept — elbv2:DescribeRules REJECTS
//     its `listener/gwy/...` ARN with ListenerNotFound, which failed the scan and stamped
//     the listener with a misleading `skipped` note. The enumerator now returns [] for
//     gateway listeners without calling the API.
import { describe, expect, it } from 'vite-plus/test';
import type { Desired } from '../src/desired/template-adapter.js';
import { CHILD_ENUMERATORS, isServiceManagedVpcEndpoint } from '../src/read/child-enumerators.js';
import type { DesiredResource } from '../src/types.js';

describe('#1547 service-managed VPC endpoint marker', () => {
  it('recognizes the MSK Serverless managed endpoint by its AWSMSKManaged tag', () => {
    expect(
      isServiceManagedVpcEndpoint({
        VpcEndpointId: 'vpce-0123456789abcdef0',
        ServiceName: 'com.amazonaws.vpce.us-east-1.vpce-svc-05c7aba739c5543b1',
        Tags: [
          { Key: 'ClusterArn', Value: 'arn:aws:kafka:us-east-1:111111111111:cluster/x/y' },
          { Key: 'AWSMSKManaged', Value: 'true' },
        ],
      })
    ).toBe(true);
  });

  it('a user-created endpoint (no marker tag) is NOT service-managed', () => {
    expect(
      isServiceManagedVpcEndpoint({
        VpcEndpointId: 'vpce-0123456789abcdef1',
        ServiceName: 'com.amazonaws.us-east-1.s3',
        Tags: [{ Key: 'Name', Value: 'my-endpoint' }],
      })
    ).toBe(false);
    expect(isServiceManagedVpcEndpoint({ VpcEndpointId: 'vpce-0123456789abcdef2' })).toBe(false);
  });
});

describe('#1548 gateway listener rules scan', () => {
  it('returns no children for a gwy listener WITHOUT calling DescribeRules', async () => {
    const parent: DesiredResource = {
      logicalId: 'HuntGwlbListener',
      resourceType: 'AWS::ElasticLoadBalancingV2::Listener',
      physicalId:
        'arn:aws:elasticloadbalancing:us-east-1:111111111111:listener/gwy/CdkrdH-HuntG-x/60097202e3984d48/98adddd1af01305a',
      declared: {},
    };
    const desired = { resources: [parent] } as unknown as Desired;
    // No SDK mock is armed: if the enumerator attempted DescribeRules the call would
    // reject and this await would throw — the early return IS the assertion.
    const added = await CHILD_ENUMERATORS['AWS::ElasticLoadBalancingV2::Listener']!({
      parent,
      desired,
      region: 'us-east-1',
    });
    expect(added).toEqual([]);
  });
});

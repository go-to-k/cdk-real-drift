// #1540 — five parents added to CHILD_ENUMERATORS so their out-of-band-added children
// surface in the `added` tier: AutoScalingGroup (ScheduledAction / LifecycleHook), VPC
// (NatGateway / FlowLog), Cognito UserPool (UserPoolDomain), Glue Database (Table), and
// TransitGateway (VpcAttachment / RouteTable). Pure-diff units below; the full cycle was
// live-proven on CdkrdHunt0713cEnumChildren (us-east-1, 2026-07-13): 8 out-of-band
// children (one per family plus NAT + flow log) were INVISIBLE pre-fix and all 8
// surfaced `added` post-fix, with the declared siblings (a declared ScheduledAction /
// LifecycleHook / Glue Table) NOT flagged and the TGW's auto-created default route
// table excluded.
import { describe, expect, it } from 'vite-plus/test';
import {
  CHILD_ENUMERATORS,
  diffAsgLifecycleHookChildren,
  diffAsgScheduledActionChildren,
  diffGlueDatabaseChildren,
  diffTransitGatewayAttachmentChildren,
  diffTransitGatewayRouteTableChildren,
  diffUserPoolDomainChildren,
  diffVpcFlowLogChildren,
  diffVpcNatGatewayChildren,
} from '../src/read/child-enumerators.js';

const ASG = 'CdkrdHunt-Asg';

describe('#1540 ASG scheduled-action / lifecycle-hook children', () => {
  it('emits an undeclared scheduled action with the CHILD-first composite id (router.ts order)', () => {
    const added = diffAsgScheduledActionChildren({
      asgName: ASG,
      declaredActionNames: ['declared-sched'],
      liveActions: [
        { name: 'declared-sched' },
        { name: 'oob-sched', label: 'oob-sched (30 4 * * *)' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::AutoScaling::ScheduledAction',
        identifier: `oob-sched|${ASG}`,
        label: 'oob-sched (30 4 * * *)',
        live: { ScheduledActionName: 'oob-sched', AutoScalingGroupName: ASG },
      },
    ]);
  });

  it('emits an undeclared lifecycle hook with the PARENT-first composite id (compositeWith order)', () => {
    const added = diffAsgLifecycleHookChildren({
      asgName: ASG,
      declaredHookNames: ['declared-hook'],
      liveHooks: [{ name: 'declared-hook' }, { name: 'oob-hook' }],
    });
    expect(added.map((a) => a.identifier)).toEqual([`${ASG}|oob-hook`]);
    expect(added[0]!.resourceType).toBe('AWS::AutoScaling::LifecycleHook');
  });
});

describe('#1540 VPC NAT gateway / flow log children', () => {
  it('emits an undeclared NAT gateway and excludes gone states', () => {
    const added = diffVpcNatGatewayChildren({
      declaredNatGatewayIds: ['nat-declared'],
      liveNatGateways: [
        { id: 'nat-declared', state: 'available' },
        { id: 'nat-oob', state: 'available' },
        { id: 'nat-dead', state: 'deleted' },
        { id: 'nat-dying', state: 'deleting' },
        { id: 'nat-failed', state: 'failed' },
      ],
    });
    expect(added.map((a) => a.identifier)).toEqual(['nat-oob']);
    expect(added[0]!.resourceType).toBe('AWS::EC2::NatGateway');
  });

  it('emits an undeclared flow log and excludes declared ones', () => {
    const added = diffVpcFlowLogChildren({
      declaredFlowLogIds: ['fl-declared'],
      liveFlowLogs: [{ id: 'fl-declared' }, { id: 'fl-oob' }],
    });
    expect(added.map((a) => a.identifier)).toEqual(['fl-oob']);
    expect(added[0]!.resourceType).toBe('AWS::EC2::FlowLog');
  });
});

describe('#1540 Cognito hosted-UI domain child', () => {
  it('emits an undeclared prefix domain with the UserPoolId|Domain composite id', () => {
    const added = diffUserPoolDomainChildren({
      userPoolId: 'us-east-1_abc',
      declaredDomains: [],
      liveDomains: [{ domain: 'oob-domain' }],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Cognito::UserPoolDomain',
        identifier: 'us-east-1_abc|oob-domain',
        label: 'oob-domain (hosted UI domain)',
        live: { Domain: 'oob-domain', UserPoolId: 'us-east-1_abc' },
      },
    ]);
  });

  it('a declared domain is not flagged', () => {
    expect(
      diffUserPoolDomainChildren({
        userPoolId: 'us-east-1_abc',
        declaredDomains: ['declared-domain'],
        liveDomains: [{ domain: 'declared-domain' }],
      })
    ).toEqual([]);
  });
});

describe('#1540 Glue database table children', () => {
  it('emits an undeclared table with the DatabaseName|TableName composite id and skips declared ones', () => {
    const added = diffGlueDatabaseChildren({
      databaseName: 'hunt_db',
      declaredTableNames: ['declared_table'],
      liveTables: [{ name: 'declared_table' }, { name: 'oob_table' }],
    });
    expect(added.map((a) => a.identifier)).toEqual(['hunt_db|oob_table']);
    expect(added[0]!.resourceType).toBe('AWS::Glue::Table');
  });

  // #1749: GetTables on a resource-link database proxies to the linked TARGET's tables
  // (each echoed with the TARGET's DatabaseName) — a proxy echo is not a child of the
  // link and must never surface as added (the offered delete would destroy the shared
  // real table). A genuine out-of-band table still surfaces: its owning DatabaseName
  // matches the queried database (or is absent on an older echo shape).
  it('drops resource-link proxy echoes (owning DatabaseName differs) but keeps real OOB tables (#1749)', () => {
    const added = diffGlueDatabaseChildren({
      databaseName: 'link_db',
      declaredTableNames: [],
      liveTables: [
        { name: 'proxied_target_table', sourceDatabaseName: 'target_db' },
        { name: 'real_oob_table', sourceDatabaseName: 'link_db' },
        { name: 'legacy_echo_no_owner' },
      ],
    });
    expect(added.map((a) => a.identifier)).toEqual([
      'link_db|real_oob_table',
      'link_db|legacy_echo_no_owner',
    ]);
  });

  it('declared resource link (DatabaseInput.TargetDatabase) short-circuits enumeration with no API call (#1749)', async () => {
    const enumerate = CHILD_ENUMERATORS['AWS::Glue::Database']!;
    const added = await enumerate({
      parent: {
        logicalId: 'LinkDb',
        resourceType: 'AWS::Glue::Database',
        physicalId: 'link_db',
        declared: {
          CatalogId: '111111111111',
          DatabaseInput: {
            Name: 'link_db',
            TargetDatabase: { CatalogId: '111111111111', DatabaseName: 'target_db' },
          },
        },
      } as never,
      desired: { resources: [] } as never,
      // An invalid region guarantees the test fails loudly if the enumerator ever
      // reaches the Glue client instead of short-circuiting.
      region: 'invalid-region-never-called',
    });
    expect(added).toEqual([]);
  });
});

describe('#1540 transit gateway children', () => {
  it('emits an undeclared vpc attachment, excluding non-vpc types and gone states', () => {
    const added = diffTransitGatewayAttachmentChildren({
      declaredAttachmentIds: ['tgw-attach-declared'],
      liveAttachments: [
        { id: 'tgw-attach-declared', resourceType: 'vpc', state: 'available' },
        { id: 'tgw-attach-oob', resourceType: 'vpc', state: 'available' },
        { id: 'tgw-attach-vpn', resourceType: 'vpn', state: 'available' },
        { id: 'tgw-attach-dead', resourceType: 'vpc', state: 'deleted' },
      ],
    });
    expect(added.map((a) => a.identifier)).toEqual(['tgw-attach-oob']);
    expect(added[0]!.resourceType).toBe('AWS::EC2::TransitGatewayAttachment');
  });

  it('emits an undeclared route table and excludes the TGW default route table', () => {
    const added = diffTransitGatewayRouteTableChildren({
      declaredRouteTableIds: ['tgw-rtb-declared'],
      liveRouteTables: [
        { id: 'tgw-rtb-declared', state: 'available' },
        {
          id: 'tgw-rtb-default',
          state: 'available',
          isDefaultAssociation: true,
          isDefaultPropagation: true,
        },
        { id: 'tgw-rtb-oob', state: 'available' },
      ],
    });
    expect(added.map((a) => a.identifier)).toEqual(['tgw-rtb-oob']);
    expect(added[0]!.resourceType).toBe('AWS::EC2::TransitGatewayRouteTable');
  });
});

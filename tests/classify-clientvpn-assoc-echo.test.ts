import { describe, expect, it } from 'vite-plus/test';
import { buildClientVpnEndpointSiblingVpcs } from '../src/commands/gather.js';
import type { Desired } from '../src/desired/template-adapter.js';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// First-run FP found by the 2026-07-13 hunt: an AWS::EC2::ClientVpnEndpoint that declares neither
// `VpcId` nor `SecurityGroupIds` gains BOTH the moment the FIRST target-network association lands
// (live-confirmed us-east-1: VpcId = the associated subnet's VPC, SecurityGroupIds = that VPC's
// default SG). The unassociated `clientvpn-barest` shape never materializes the fields, which is
// why this stayed latent. Folds (both tier 2, detection-preserving):
//   - SecurityGroupIds → the shared derived VPC-default-SG gate (DEFAULT_SG_LIST_PATHS): a single
//     default SG folds, an out-of-band swap/append surfaces.
//   - VpcId → the sibling-derived VPC (gather.buildClientVpnEndpointSiblingVpcs: association
//     SubnetId → in-stack Subnet.VpcId): a match folds, an out-of-band `modify-client-vpn-endpoint
//     --vpc-id` move (or an association echo with NO declared sibling) surfaces.

const schema: SchemaInfo = {
  readOnly: new Set(['Id']),
  writeOnly: new Set(),
  createOnly: new Set(['AuthenticationOptions', 'ClientCidrBlock', 'TransportProtocol']),
  readOnlyPaths: ['Id'],
  writeOnlyPaths: [],
  createOnlyPaths: ['AuthenticationOptions', 'ClientCidrBlock', 'TransportProtocol'],
  defaults: {},
  defaultPaths: {},
};

const CERT = 'arn:aws:acm:us-east-1:111111111111:certificate/a549a63e';
const endpointResource: DesiredResource = {
  logicalId: 'Endpoint',
  resourceType: 'AWS::EC2::ClientVpnEndpoint',
  physicalId: 'cvpn-endpoint-0eb61aeb3a584e71a',
  declared: {
    AuthenticationOptions: [
      {
        MutualAuthentication: { ClientRootCertificateChainArn: CERT },
        Type: 'certificate-authentication',
      },
    ],
    ClientCidrBlock: '10.100.0.0/22',
    ConnectionLogOptions: { Enabled: false },
    ServerCertificateArn: CERT,
  },
};

// The live model mirrors the real DescribeClientVpnEndpoints projection of the associated
// endpoint the hunt harvested (tests/corpus AWS__EC2__ClientVpnEndpoint.EndpointAssoc).
const associatedLive = (): Record<string, unknown> => ({
  ClientCidrBlock: '10.100.0.0/22',
  SplitTunnel: false,
  TransportProtocol: 'udp',
  VpnPort: 443,
  ServerCertificateArn: CERT,
  SecurityGroupIds: ['sg-09b6d7fd7f1364328'],
  VpcId: 'vpc-07c0e7826547bd2a7',
  SessionTimeoutHours: 24,
  DisconnectOnSessionTimeout: true,
  ConnectionLogOptions: { Enabled: false },
  AuthenticationOptions: [
    {
      Type: 'certificate-authentication',
      MutualAuthentication: { ClientRootCertificateChainArn: CERT },
    },
  ],
});

const byPath = (findings: Finding[], path: string) => findings.filter((f) => f.path === path);

const desiredWithAssociation = (subnetVpc: unknown, opts?: { vpcPhysical?: string }): Desired =>
  ({
    resources: [
      endpointResource,
      {
        logicalId: 'Vpc',
        resourceType: 'AWS::EC2::VPC',
        physicalId: opts?.vpcPhysical ?? 'vpc-07c0e7826547bd2a7',
        declared: { CidrBlock: '10.42.0.0/16' },
      },
      {
        logicalId: 'Subnet',
        resourceType: 'AWS::EC2::Subnet',
        physicalId: 'subnet-0aaa1111bbb22222c',
        declared: { VpcId: subnetVpc, CidrBlock: '10.42.0.0/24' },
      },
      {
        logicalId: 'Assoc',
        resourceType: 'AWS::EC2::ClientVpnTargetNetworkAssociation',
        physicalId: 'cvpn-assoc-0123456789abcdef0',
        declared: { ClientVpnEndpointId: { Ref: 'Endpoint' }, SubnetId: { Ref: 'Subnet' } },
      },
    ],
  }) as unknown as Desired;

describe('ClientVpnEndpoint association-echo folds (2026-07-13 hunt)', () => {
  it('(map) derives the VPC from a Ref-form association + in-stack subnet with Ref VpcId', () => {
    const map = buildClientVpnEndpointSiblingVpcs(desiredWithAssociation({ Ref: 'Vpc' }));
    // Keyed by BOTH the endpoint's logicalId and physicalId; value = the VPC's physical id.
    expect(map).toEqual({
      Endpoint: 'vpc-07c0e7826547bd2a7',
      'cvpn-endpoint-0eb61aeb3a584e71a': 'vpc-07c0e7826547bd2a7',
    });
  });

  it('(map) derives from a fully RESOLVED association (literal endpoint + subnet ids)', () => {
    const desired = {
      resources: [
        endpointResource,
        {
          logicalId: 'Subnet',
          resourceType: 'AWS::EC2::Subnet',
          physicalId: 'subnet-0aaa1111bbb22222c',
          declared: { VpcId: 'vpc-07c0e7826547bd2a7', CidrBlock: '10.42.0.0/24' },
        },
        {
          logicalId: 'Assoc',
          resourceType: 'AWS::EC2::ClientVpnTargetNetworkAssociation',
          declared: {
            ClientVpnEndpointId: 'cvpn-endpoint-0eb61aeb3a584e71a',
            SubnetId: 'subnet-0aaa1111bbb22222c',
          },
        },
      ],
    } as unknown as Desired;
    const map = buildClientVpnEndpointSiblingVpcs(desired);
    expect(map).toEqual({ 'cvpn-endpoint-0eb61aeb3a584e71a': 'vpc-07c0e7826547bd2a7' });
  });

  it('(map) an association onto an IMPORTED subnet (not in-stack) degrades to null (fail open)', () => {
    const desired = {
      resources: [
        endpointResource,
        {
          logicalId: 'Assoc',
          resourceType: 'AWS::EC2::ClientVpnTargetNetworkAssociation',
          declared: {
            ClientVpnEndpointId: { Ref: 'Endpoint' },
            SubnetId: 'subnet-imported00000001',
          },
        },
      ],
    } as unknown as Desired;
    const map = buildClientVpnEndpointSiblingVpcs(desired);
    expect(map).toEqual({ Endpoint: null, 'cvpn-endpoint-0eb61aeb3a584e71a': null });
  });

  it('(map) no declared association → no entry (a live VpcId then surfaces)', () => {
    const desired = { resources: [endpointResource] } as unknown as Desired;
    expect(buildClientVpnEndpointSiblingVpcs(desired)).toEqual({});
  });

  it('(classify) the clean-deploy association echo folds: VpcId + default SG → atDefault', () => {
    const findings = classifyResource(endpointResource, associatedLive(), schema, {
      defaultSgIds: new Set(['sg-09b6d7fd7f1364328']),
      siblingClientVpnEndpointVpcs: {
        Endpoint: 'vpc-07c0e7826547bd2a7',
        'cvpn-endpoint-0eb61aeb3a584e71a': 'vpc-07c0e7826547bd2a7',
      },
    });
    expect(byPath(findings, 'VpcId')).toEqual([
      expect.objectContaining({ tier: 'atDefault', actual: 'vpc-07c0e7826547bd2a7' }),
    ]);
    expect(byPath(findings, 'SecurityGroupIds')).toEqual([
      expect.objectContaining({ tier: 'atDefault', actual: ['sg-09b6d7fd7f1364328'] }),
    ]);
    expect(findings.filter((f) => f.tier === 'undeclared')).toEqual([]);
  });

  it('(classify) an out-of-band VPC move (live VpcId ≠ derived) SURFACES', () => {
    const live = { ...associatedLive(), VpcId: 'vpc-0feedfacefeedface0' };
    const findings = classifyResource(endpointResource, live, schema, {
      defaultSgIds: new Set(['sg-09b6d7fd7f1364328']),
      siblingClientVpnEndpointVpcs: { Endpoint: 'vpc-07c0e7826547bd2a7' },
    });
    expect(byPath(findings, 'VpcId')).toEqual([
      expect.objectContaining({ tier: 'undeclared', actual: 'vpc-0feedfacefeedface0' }),
    ]);
  });

  it('(classify) a VpcId with NO declared association (out-of-band association echo) SURFACES', () => {
    const findings = classifyResource(endpointResource, associatedLive(), schema, {
      defaultSgIds: new Set(['sg-09b6d7fd7f1364328']),
      siblingClientVpnEndpointVpcs: {},
    });
    expect(byPath(findings, 'VpcId')).toEqual([expect.objectContaining({ tier: 'undeclared' })]);
  });

  it('(classify) a null derivation (imported subnet) folds fail-open', () => {
    const findings = classifyResource(endpointResource, associatedLive(), schema, {
      defaultSgIds: new Set(['sg-09b6d7fd7f1364328']),
      siblingClientVpnEndpointVpcs: { Endpoint: null },
    });
    expect(byPath(findings, 'VpcId')).toEqual([expect.objectContaining({ tier: 'atDefault' })]);
  });

  it('(classify) an out-of-band SG SWAP (single non-default SG) SURFACES', () => {
    const live = { ...associatedLive(), SecurityGroupIds: ['sg-0rogue0000000000a'] };
    const findings = classifyResource(endpointResource, live, schema, {
      defaultSgIds: new Set(['sg-09b6d7fd7f1364328']),
      siblingClientVpnEndpointVpcs: { Endpoint: 'vpc-07c0e7826547bd2a7' },
    });
    expect(byPath(findings, 'SecurityGroupIds')).toEqual([
      expect.objectContaining({ tier: 'undeclared' }),
    ]);
  });

  it('(classify) an out-of-band SG APPEND (default + extra) SURFACES', () => {
    const live = {
      ...associatedLive(),
      SecurityGroupIds: ['sg-09b6d7fd7f1364328', 'sg-0rogue0000000000a'],
    };
    const findings = classifyResource(endpointResource, live, schema, {
      defaultSgIds: new Set(['sg-09b6d7fd7f1364328']),
      siblingClientVpnEndpointVpcs: { Endpoint: 'vpc-07c0e7826547bd2a7' },
    });
    expect(byPath(findings, 'SecurityGroupIds')).toEqual([
      expect.objectContaining({ tier: 'undeclared' }),
    ]);
  });

  it('(classify) the SG gate fails OPEN when the default-SG prefetch is unavailable', () => {
    const findings = classifyResource(endpointResource, associatedLive(), schema, {
      siblingClientVpnEndpointVpcs: { Endpoint: 'vpc-07c0e7826547bd2a7' },
    });
    expect(byPath(findings, 'SecurityGroupIds')).toEqual([
      expect.objectContaining({ tier: 'atDefault' }),
    ]);
  });
});

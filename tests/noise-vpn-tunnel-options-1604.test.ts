// #1604 — a BAREST static VPNConnection (no VpnTunnelOptionsSpecifications declared)
// reads back both tunnels' AWS-materialized options and first-run FP'd, live-proven on
// vpnroute-min (us-east-1, 2026-07-14). The fold is a SHAPE gate, not value-independent:
// tunnel options are OOB-mutable (`modify-vpn-tunnel-options`) and security-relevant, so
// only the pristine-creation shape (random link-local inside CIDRs, empty phase/IKE
// restriction lists, logging off) folds — a logging enable, an algorithm restriction, or
// any extra member (lifetime knob, DPD action) breaks the gate and surfaces.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { Finding, SchemaInfo } from '../src/types.js';

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

const tier = (findings: Finding[], t: string) =>
  findings
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();

const declared = {
  Type: 'ipsec.1',
  CustomerGatewayId: 'cgw-0123456789abcdef0',
  VpnGatewayId: 'vgw-0123456789abcdef0',
  StaticRoutesOnly: true,
};

const pristineTunnel = (cidr: string) => ({
  Phase1EncryptionAlgorithms: [],
  Phase1IntegrityAlgorithms: [],
  Phase1DHGroupNumbers: [],
  Phase2EncryptionAlgorithms: [],
  Phase2IntegrityAlgorithms: [],
  Phase2DHGroupNumbers: [],
  IKEVersions: [],
  TunnelInsideCidr: cidr,
  LogOptions: { CloudwatchLogOptions: { BgpLogEnabled: false, LogEnabled: false } },
});

const mk = (tunnels: unknown) =>
  classifyResource(
    {
      logicalId: 'HuntVpn',
      resourceType: 'AWS::EC2::VPNConnection',
      physicalId: 'vpn-0123456789abcdef0',
      declared,
    },
    { ...declared, VpnTunnelOptionsSpecifications: tunnels },
    emptySchema
  );

describe('#1604 barest VPNConnection tunnel-options shape gate', () => {
  it('the pristine creation echo (both tunnels) folds to atDefault', () => {
    const f = mk([pristineTunnel('169.254.61.176/30'), pristineTunnel('169.254.61.164/30')]);
    expect(tier(f, 'undeclared')).toEqual([]);
    expect(tier(f, 'atDefault')).toContain('VpnTunnelOptionsSpecifications');
  });

  it('an out-of-band tunnel-logging enable breaks the gate and surfaces', () => {
    const logging = {
      ...pristineTunnel('169.254.61.176/30'),
      LogOptions: {
        CloudwatchLogOptions: {
          BgpLogEnabled: false,
          LogEnabled: true,
          LogGroupArn: 'arn:aws:logs:us-east-1:111122223333:log-group:vpn',
        },
      },
    };
    const f = mk([logging, pristineTunnel('169.254.61.164/30')]);
    expect(tier(f, 'undeclared')).toEqual(['VpnTunnelOptionsSpecifications']);
  });

  it('an out-of-band algorithm restriction / extra knob surfaces', () => {
    const restricted = {
      ...pristineTunnel('169.254.61.176/30'),
      Phase1EncryptionAlgorithms: [{ Value: 'AES256' }],
    };
    expect(tier(mk([restricted, pristineTunnel('169.254.61.164/30')]), 'undeclared')).toEqual([
      'VpnTunnelOptionsSpecifications',
    ]);
    const knob = { ...pristineTunnel('169.254.61.176/30'), Phase1LifetimeSeconds: 14400 };
    expect(tier(mk([knob, pristineTunnel('169.254.61.164/30')]), 'undeclared')).toEqual([
      'VpnTunnelOptionsSpecifications',
    ]);
  });

  it('a non-link-local inside CIDR (user-shaped value) surfaces', () => {
    expect(tier(mk([pristineTunnel('10.0.0.0/30')]), 'undeclared')).toEqual([
      'VpnTunnelOptionsSpecifications',
    ]);
  });
});

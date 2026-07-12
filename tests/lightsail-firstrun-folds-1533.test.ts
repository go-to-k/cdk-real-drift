// #1533: a barest Lightsail Instance first-ran two [Potential Drift] entries (live
// 2026-07-12, us-east-1, CdkrdHuntMiscBarest20712c): the constant Linux default firewall
// (Networking: inbound tcp 22 + 80 from anywhere) and the AWS-placed AvailabilityZone.
// The Networking pin is equality-gated so an out-of-band `open-instance-public-ports`
// (a rogue port) still surfaces; the AZ folds value-independent (AWS-placed, create-only,
// the RDS/Neptune AvailabilityZone twin).
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

const pathsByTier = (findings: Finding[], tier: string) =>
  findings
    .filter((f) => f.tier === tier)
    .map((f) => f.path)
    .sort();

const port = (p: number) => ({
  FromPort: p,
  AccessDirection: 'inbound',
  CidrListAliases: [],
  ToPort: p,
  Ipv6Cidrs: ['::/0'],
  AccessFrom: 'Anywhere (0.0.0.0/0 and ::/0)',
  Protocol: 'tcp',
  AccessType: 'public',
  Cidrs: ['0.0.0.0/0'],
  CommonName: '',
});

describe('#1533 Lightsail Instance first-run folds', () => {
  const res: DesiredResource = {
    logicalId: 'Ls',
    resourceType: 'AWS::Lightsail::Instance',
    physicalId: 'cdkrd-hunt-ls-0712c',
    declared: {
      InstanceName: 'cdkrd-hunt-ls-0712c',
      BlueprintId: 'amazon_linux_2023',
      BundleId: 'nano_3_0',
    },
  };
  const live = (ports: number[]) => ({
    InstanceName: 'cdkrd-hunt-ls-0712c',
    BlueprintId: 'amazon_linux_2023',
    BundleId: 'nano_3_0',
    KeyPairName: 'LightsailDefaultKeyPair',
    AvailabilityZone: 'us-east-1a',
    Networking: { Ports: ports.map(port), MonthlyTransfer: {} },
  });

  it('folds the default firewall and the AWS-placed AZ on a clean first run', () => {
    const f = classifyResource(res, live([22, 80]), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
    for (const p of ['Networking', 'AvailabilityZone', 'KeyPairName']) {
      expect(pathsByTier(f, 'atDefault')).toContain(p);
    }
  });

  it('surfaces an out-of-band opened port (equality gate keeps the security detection)', () => {
    const f = classifyResource(res, live([22, 80, 8080]), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual(['Networking']);
  });
});

// #1102 F3 — AWS::EC2::ClientVpnEndpoint TagSpecifications is the EC2 create-time tag INPUT shape
// ([{ResourceType, Tags}]). The live resource carries its tags under `Tags` (where the Cloud
// Control read returns them); TagSpecifications is never echoed back, so without the readGap
// denylist classify's removed-collection branch false-flags [CFn-Declared Drift] TagSpecifications
// on every tagged endpoint (live-observed on a clean deploy, us-east-1, 2026-07-10).
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, SchemaInfo } from '../src/types.js';

// No writeOnly on TagSpecifications, so it survives schema-strip into the declared model — the
// condition under which the removed-collection branch would fire.
const schema: SchemaInfo = {
  readOnly: new Set(['ClientVpnEndpointId']),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: ['ClientVpnEndpointId'],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};
const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'Cvpn',
  resourceType: 'AWS::EC2::ClientVpnEndpoint',
  physicalId: 'cvpn-endpoint-0123456789abcdef0',
  declared,
});

describe('#1102 F3 ClientVpnEndpoint TagSpecifications readGap denylist', () => {
  it('a declared TagSpecifications absent from the live read stays readGap, not declared drift', () => {
    const findings = classifyResource(
      mk({
        ClientCidrBlock: '10.0.0.0/22',
        TagSpecifications: [
          { ResourceType: 'client-vpn-endpoint', Tags: [{ Key: 'team', Value: 'net' }] },
        ],
      }),
      // the live model carries tags under Tags; TagSpecifications is never returned
      { ClientCidrBlock: '10.0.0.0/22' },
      schema
    );
    expect(findings.some((f) => f.tier === 'declared' && f.path === 'TagSpecifications')).toBe(
      false
    );
    expect(findings.some((f) => f.tier === 'readGap' && f.path === 'TagSpecifications')).toBe(true);
  });
});

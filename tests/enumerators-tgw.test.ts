// Transit Gateway child enumerator pure-diff coverage — the 2026-08-03 audit found it
// was the ONLY CHILD_ENUMERATORS entry with no dedicated unit test (its live proof ran
// in the 2026-07-13 hunt but was not committed as a fixture assertion). These pin the
// filters that keep the enumerator honest: vpc-kind-only + gone-state drops for
// attachments, and the auto-created default association/propagation route-table drop.
import { describe, expect, it } from 'vite-plus/test';
import {
  diffTransitGatewayAttachmentChildren,
  diffTransitGatewayRouteTableChildren,
} from '../src/read/child-enumerators.js';

describe('diffTransitGatewayAttachmentChildren', () => {
  it('flags only undeclared vpc attachments in a live state', () => {
    const added = diffTransitGatewayAttachmentChildren({
      declaredAttachmentIds: ['tgw-attach-declared'],
      liveAttachments: [
        { id: 'tgw-attach-declared', resourceType: 'vpc', state: 'available' },
        { id: 'tgw-attach-oob', resourceType: 'vpc', state: 'available', label: 'oob vpc' },
        // other CFn types — never this enumerator's finding
        { id: 'tgw-attach-vpn', resourceType: 'vpn', state: 'available' },
        { id: 'tgw-attach-peer', resourceType: 'peering', state: 'available' },
        // leaving/gone husks
        { id: 'tgw-attach-dead', resourceType: 'vpc', state: 'deleted' },
        { id: 'tgw-attach-dying', resourceType: 'vpc', state: 'deleting' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::EC2::TransitGatewayAttachment',
        identifier: 'tgw-attach-oob',
        label: 'oob vpc',
        live: { Id: 'tgw-attach-oob' },
      },
    ]);
  });
});

describe('diffTransitGatewayRouteTableChildren', () => {
  it('drops the auto-created default table and declared/gone entries', () => {
    const added = diffTransitGatewayRouteTableChildren({
      declaredRouteTableIds: ['tgw-rtb-declared'],
      liveRouteTables: [
        { id: 'tgw-rtb-default', isDefaultAssociation: true, isDefaultPropagation: true },
        { id: 'tgw-rtb-declared', state: 'available' },
        { id: 'tgw-rtb-oob', state: 'available' },
        { id: 'tgw-rtb-gone', state: 'deleting' },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::EC2::TransitGatewayRouteTable',
        identifier: 'tgw-rtb-oob',
        label: 'tgw-rtb-oob',
        live: { TransitGatewayRouteTableId: 'tgw-rtb-oob' },
      },
    ]);
  });
});

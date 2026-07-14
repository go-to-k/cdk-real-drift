// CDK app for the cdk-real-drift vpnroute-min integration test. Two probes:
//   - AWS::EC2::VPNConnectionRoute — the top remaining composite-primaryIdentifier
//     candidate ([DestinationCidrBlock, VpnConnectionId]) with zero corpus coverage:
//     if the CFn physical id is only one segment, the CC read ValidationException-
//     skips it (a silent read-gap; check the `info:` footer for `skipped=`), which
//     would need a CC_IDENTIFIER_ADAPTERS entry. A clean read is the inverse
//     determination (Ref is already the full composite).
//   - the BAREST static VPNConnection: harvest12 DECLARES VpnTunnelOptionsSpecifications,
//     so the undeclared tunnel-options echo (AWS materializes both tunnels' inside
//     CIDRs / PSKs at creation) is unexercised — a first-run FP probe.
// The customer gateway IP is TEST-NET-2 documentation space (no real peer needed;
// the VPN never connects, which costs nothing extra and detects nothing less).
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import {
  CfnCustomerGateway,
  CfnVPNConnection,
  CfnVPNConnectionRoute,
  CfnVPNGateway,
} from "aws-cdk-lib/aws-ec2";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714VpnRoute");

const cgw = new CfnCustomerGateway(stack, "HuntCgw", {
  type: "ipsec.1",
  ipAddress: "198.51.100.7",
  bgpAsn: 65000,
});

const vgw = new CfnVPNGateway(stack, "HuntVgw", {
  type: "ipsec.1",
});

const vpn = new CfnVPNConnection(stack, "HuntVpn", {
  type: "ipsec.1",
  customerGatewayId: cgw.ref,
  vpnGatewayId: vgw.ref,
  staticRoutesOnly: true,
});

new CfnVPNConnectionRoute(stack, "HuntVpnRoute", {
  destinationCidrBlock: "203.0.113.0/24",
  vpnConnectionId: vpn.ref,
});

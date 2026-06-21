// CDK app for the cdk-real-drift Global Accelerator false-positive test. Global
// Accelerator is a common front door for low-latency / failover traffic, and none
// of AWS::GlobalAccelerator::Accelerator / ::Listener / ::EndpointGroup has been
// exercised. The listener carries a PortRanges array + protocol + ClientAffinity,
// and the endpoint group carries the health-check defaults (interval / threshold /
// protocol / traffic-dial) AWS materializes — the KNOWN_DEFAULTS / nested-default
// surface. The endpoint group has no endpoints (valid; we only read config). A
// freshly deployed + recorded stack with NO out-of-band change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import {
  Accelerator,
  ClientAffinity,
  ConnectionProtocol,
} from "aws-cdk-lib/aws-globalaccelerator";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegGlobalAcceleratorRich");

const accel = new Accelerator(stack, "Accel", {
  acceleratorName: "cdkrd-accel",
  enabled: true,
});

const listener = accel.addListener("Listener", {
  portRanges: [
    { fromPort: 80, toPort: 80 },
    { fromPort: 443, toPort: 443 },
  ],
  protocol: ConnectionProtocol.TCP,
  clientAffinity: ClientAffinity.SOURCE_IP,
});

listener.addEndpointGroup("Group", {
  region: "us-east-1",
});

app.synth();

// cdk-real-drift GlobalAccelerator Listener PortRanges reorder test.
// A GlobalAccelerator::Listener's `PortRanges` is an ARRAY of {FromPort, ToPort}
// with NO identity field (so cdkrd's keyed canonicalizer leaves it), so a positional
// compare false-flags every shifted range if GA returns them in a different order
// than declared. The ranges are declared in DESCENDING order (443 before 80) to
// reveal any sort-on-read. A freshly deployed + recorded listener with NO out-of-band
// change MUST be CLEAN (either GA preserves the order, or the per-type fold aligns
// the set).
import { App, Stack } from "aws-cdk-lib";
import { Accelerator, Listener } from "aws-cdk-lib/aws-globalaccelerator";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegGlobalAccelPortRangeReorder");

const accel = new Accelerator(stack, "Accel", {
  acceleratorName: "cdkrd-portrange-reorder",
});

new Listener(stack, "Listener", {
  accelerator: accel,
  // Deliberately DESCENDING so a sort-on-read (ascending) reorder is revealed.
  portRanges: [
    { fromPort: 443, toPort: 443 },
    { fromPort: 80, toPort: 80 },
    { fromPort: 8080, toPort: 8090 },
  ],
});

app.synth();

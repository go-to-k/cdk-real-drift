// CDK app for the cdk-real-drift cloudmap-http false-positive integration test.
// AWS Cloud Map (AWS::ServiceDiscovery::HttpNamespace + ::Service) is a CC read
// gap — Cloud Control GetResource throws UnsupportedActionException for the whole
// ServiceDiscovery family, so before the SDK_OVERRIDES readers these resources were
// `skipped` (invisible to drift detection). With the GetNamespace / GetService
// overrides a clean `record`->`check` is a strong false-positive oracle for the
// projection, and the Service's mutable Description is the detect/revert subject.
import { App, Stack } from "aws-cdk-lib";
import { CfnHttpNamespace, CfnService } from "aws-cdk-lib/aws-servicediscovery";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCloudmapHttp");

const ns = new CfnHttpNamespace(stack, "Namespace", {
  name: "cdkrd-cloudmap-http",
  description: "cdkrd cloud map http namespace",
});

new CfnService(stack, "Service", {
  name: "cdkrd-cloudmap-service",
  namespaceId: ns.attrId,
  description: "cdkrd cloud map http service",
  type: "HTTP",
});

app.synth();

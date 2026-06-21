// CDK app for the cdk-real-drift VPC Lattice false-positive test. VPC Lattice is a
// newer but increasingly common application-networking layer, and neither
// AWS::VpcLattice::ServiceNetwork nor ::Service has been exercised. Both carry an
// AuthType enum and AWS materializes read-only DnsEntry / Arn / status fields plus a
// CreatedAt/LastUpdatedAt pair — the generated/read-only surface. A freshly deployed
// + recorded stack with NO out-of-band change MUST report CLEAN.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnService, CfnServiceNetwork } from "aws-cdk-lib/aws-vpclattice";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegVpcLatticeRich");

new CfnServiceNetwork(stack, "Sn", {
  name: "cdkrd-lattice-sn",
  authType: "AWS_IAM",
});

const svc = new CfnService(stack, "Svc", {
  name: "cdkrd-lattice-svc",
  authType: "AWS_IAM",
});

Tags.of(svc).add("team", "platform");

app.synth();

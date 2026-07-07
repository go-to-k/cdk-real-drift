// CDK app for the cdk-real-drift transfer-server-rich false-positive integration test.
// AWS Transfer Family (AWS::Transfer::Server) is a common managed SFTP/FTPS endpoint.
// A server folds a large set of AWS-assigned first-run defaults that the template
// never declares — SecurityPolicyName (AWS assigns the current default policy),
// State, ServerId/Arn, EndpointType, ProtocolDetails, S3StorageOptions
// (DirectoryListingOptimization), and the SERVICE_MANAGED identity model. A clean
// `record`->`check` (and a `check` BEFORE record) is a strong false-positive oracle
// for those undeclared first-run defaults.
import { App, Stack } from "aws-cdk-lib";
import { Role, ServicePrincipal, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { CfnServer } from "aws-cdk-lib/aws-transfer";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegTransferServerRich");

// Logging role so the server writes structured CloudWatch logs (a common config).
const loggingRole = new Role(stack, "LoggingRole", {
  assumedBy: new ServicePrincipal("transfer.amazonaws.com"),
});
loggingRole.addToPolicy(
  new PolicyStatement({
    actions: [
      "logs:CreateLogStream",
      "logs:DescribeLogStreams",
      "logs:CreateLogGroup",
      "logs:PutLogEvents",
    ],
    resources: ["*"],
  }),
);

new CfnServer(stack, "Server", {
  identityProviderType: "SERVICE_MANAGED",
  endpointType: "PUBLIC",
  protocols: ["SFTP"],
  loggingRole: loggingRole.roleArn,
  // securityPolicyName intentionally omitted -> AWS assigns the current default
  // policy (an undeclared first-run default that must fold to atDefault).
});

app.synth();

// CDK app for the cdk-real-drift amplify-codeconnections-rich false-positive
// integration test. Zero-coverage CI/CD + frontend-hosting types:
// AWS::Amplify::App (CustomRules order + EnvironmentVariables name/value pairs —
// both reorder-FP probes), AWS::Amplify::Branch, and
// AWS::CodeStarConnections::Connection (a GitHub connection stays PENDING until a
// human completes the handshake — deploy/read/delete all work, which is exactly
// how real pipelines hold it pre-handshake). A clean `record`->`check` is the FP
// oracle.
import { App, Stack } from "aws-cdk-lib";
import { CfnApp, CfnBranch } from "aws-cdk-lib/aws-amplify";
import { CfnConnection } from "aws-cdk-lib/aws-codestarconnections";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAmplifyConnRich");

const amplifyApp = new CfnApp(stack, "AmplifyApp", {
  name: "cdkrd-hunt-amplify",
  description: "cdkrd amplify rich hunt fixture",
  platform: "WEB",
  customRules: [
    { source: "/docs/<*>", target: "/documentation/<*>", status: "301" },
    { source: "/<*>", target: "/index.html", status: "404-200" },
  ],
  environmentVariables: [
    { name: "STAGE", value: "hunt" },
    { name: "API_URL", value: "https://example.invalid/api" },
  ],
  enableBranchAutoDeletion: false,
});

new CfnBranch(stack, "MainBranch", {
  appId: amplifyApp.attrAppId,
  branchName: "main",
  description: "cdkrd hunt main branch",
  enableAutoBuild: false,
  enablePullRequestPreview: false,
  stage: "PRODUCTION",
  environmentVariables: [{ name: "BRANCH_FLAG", value: "on" }],
});

new CfnConnection(stack, "GithubConnection", {
  connectionName: "cdkrd-hunt-conn",
  providerType: "GitHub",
});

app.synth();

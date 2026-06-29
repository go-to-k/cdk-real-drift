// CDK app for the cdk-real-drift Bedrock AgentCore false-positive integration test.
// Bedrock AgentCore is a brand-new service family cdkrd had never exercised. All its
// types are Cloud-Control readable (FULLY_MUTABLE, read handler present) but entirely
// uncovered by corpus/fixtures. This fixture deploys the four LIGHTWEIGHT types (no
// ECR container / no VPC required) so a clean read can be classified end-to-end:
//   - Memory               — Name + EventExpiryDuration (+ AWS-injected status/defaults).
//   - WorkloadIdentity     — Name only (minimal; AWS mints a WorkloadIdentityArn).
//   - CodeInterpreterCustom — Name + NetworkConfiguration { NetworkMode: PUBLIC }.
//   - BrowserCustom        — Name + NetworkConfiguration { NetworkMode: PUBLIC }.
// A freshly deployed + recorded stack with NO out-of-band change MUST report CLEAN —
// this surfaces any AgentCore-specific default-fold / read-gap (e.g. a service default
// AWS materializes that the template never declared).
import { App, Stack } from "aws-cdk-lib";
import {
  CfnBrowserCustom,
  CfnCodeInterpreterCustom,
  CfnMemory,
  CfnWorkloadIdentity,
} from "aws-cdk-lib/aws-bedrockagentcore";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAgentCore");

new CfnMemory(stack, "Memory", {
  name: "cdkrd_agentcore_memory",
  description: "cdkrd agentcore-rich fixture memory",
  eventExpiryDuration: 30, // days
});

new CfnWorkloadIdentity(stack, "WorkloadIdentity", {
  name: "cdkrd_agentcore_workload",
});

new CfnCodeInterpreterCustom(stack, "CodeInterpreter", {
  name: "cdkrd_agentcore_codeint",
  description: "cdkrd agentcore-rich fixture code interpreter",
  networkConfiguration: { networkMode: "PUBLIC" },
});

new CfnBrowserCustom(stack, "Browser", {
  name: "cdkrd_agentcore_browser",
  description: "cdkrd agentcore-rich fixture browser",
  networkConfiguration: { networkMode: "PUBLIC" },
});

app.synth();

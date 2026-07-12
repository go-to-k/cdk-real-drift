// CDK app for the cdk-real-drift case-idents2-min false-positive integration test.
// Mixed-case identifier echo probes — the exact analog of the proven RDS
// parameter/option-group lowercase-echo FP family (#1531), on siblings with
// ZERO CASE_INSENSITIVE_PATHS coverage today. Live determinations (2026-07-13):
// - AWS::Redshift::ClusterParameterGroup ParameterGroupName: raw API accepts
//   mixed case and stores lowercase ("CdkrdHunt-RsCpg" -> "cdkrdhunt-rscpg").
// - AWS::ElastiCache::User: raw API lowercases UserId (UserName KEEPS case),
//   but the CFn/CC handler REJECTS a mixed-case UserId client-side
//   (InvalidRequest) — unreachable via CloudFormation, so no FP risk. Same for
//   AWS::MemoryDB::ParameterGroup names. NOT probed via CFn.
// - AWS::Batch::JobDefinition Type enum case: "Container" (vs canonical
//   "container") passes the handler; probes the enum re-case echo.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnJobDefinition } from "aws-cdk-lib/aws-batch";
import { CfnClusterParameterGroup } from "aws-cdk-lib/aws-redshift";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0713CaseIdents2");

new CfnClusterParameterGroup(stack, "HuntRsCpg", {
  parameterGroupName: "CdkrdHunt-RsCpg",
  parameterGroupFamily: "redshift-1.0",
  description: "cdkrd hunt mixed-case redshift cluster parameter group",
});

new CfnJobDefinition(stack, "HuntJobDef", {
  type: "Container",
  jobDefinitionName: "CdkrdHunt-JobDef",
  containerProperties: {
    image: "public.ecr.aws/amazonlinux/amazonlinux:2023",
    vcpus: 1,
    memory: 2048,
    command: ["true"],
  },
});

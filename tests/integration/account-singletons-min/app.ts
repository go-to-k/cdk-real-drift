// CDK app for the cdk-real-drift account-singletons-min false-positive integration test.
// BAREST-possible account/registry-level singleton types with ZERO corpus/fixture
// coverage: AWS::Logs::AccountPolicy (data-protection), AWS::ECR::RegistryPolicy,
// AWS::ECR::ReplicationConfiguration. All three are singletons the runner
// pre-checks as ABSENT before deploying (verify.sh aborts if the account already
// carries any of them — never fight over a real one).
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Aws, Stack, Tags } from "aws-cdk-lib";
import { CfnRegistryPolicy, CfnReplicationConfiguration } from "aws-cdk-lib/aws-ecr";
import { CfnAccountPolicy } from "aws-cdk-lib/aws-logs";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0713bAcctSingletons");

new CfnAccountPolicy(stack, "HuntLogsPolicy", {
  policyName: "cdkrd-hunt-data-protection",
  policyType: "DATA_PROTECTION_POLICY",
  scope: "ALL",
  policyDocument: JSON.stringify({
    Name: "cdkrd-hunt-data-protection",
    Version: "2021-06-01",
    Statement: [
      {
        Sid: "audit-policy",
        DataIdentifier: ["arn:aws:dataprotection::aws:data-identifier/EmailAddress"],
        Operation: { Audit: { FindingsDestination: {} } },
      },
      {
        Sid: "redact-policy",
        DataIdentifier: ["arn:aws:dataprotection::aws:data-identifier/EmailAddress"],
        Operation: { Deidentify: { MaskConfig: {} } },
      },
    ],
  }),
});

new CfnRegistryPolicy(stack, "HuntRegistryPolicy", {
  policyText: {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "cdkrd-hunt-replication",
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${Aws.ACCOUNT_ID}:root` },
        Action: ["ecr:CreateRepository", "ecr:ReplicateImage"],
        Resource: `arn:aws:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/*`,
      },
    ],
  },
});

new CfnReplicationConfiguration(stack, "HuntReplication", {
  replicationConfiguration: {
    rules: [
      {
        destinations: [{ region: "us-west-2", registryId: Aws.ACCOUNT_ID }],
        repositoryFilters: [{ filter: "cdkrd-hunt", filterType: "PREFIX_MATCH" }],
      },
    ],
  },
});

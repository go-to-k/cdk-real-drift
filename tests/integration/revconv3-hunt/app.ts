// Revert-convergence probe batch 4 (real AWS): seven cheap common types whose
// folded MUTABLE default has never been convergence-proven — does the CC
// handler reconcile a bare `remove` back to the default, or silently no-op
// (the #1571 class)? The API shape is not a predictor; only the live test
// answers, per-property. Candidates mined offline from KNOWN_DEFAULTS minus
// REVERT_SET_DEFAULT_PATHS coverage:
// - SQS Queue SqsManagedSseEnabled (true)
// - Athena WorkGroup State (ENABLED)
// - DynamoDB Table DeletionProtectionEnabled (false)
// - StepFunctions StateMachine LoggingConfiguration (whole-object OFF)
// - ApiGateway RestApi DisableExecuteApiEndpoint (false)
// - Cognito UserPoolClient RefreshTokenValidity (30; full-PUT update API)
// - Scheduler Schedule State (ENABLED; full-PUT update API)
// (SSM Parameter Tier was excluded: AWS cannot downgrade Advanced->Standard,
// so the revert is server-side irreversible — not a convergence probe.)
// The barest Athena WorkGroup + Cognito UserPoolClient here also double as
// first-run FP probes (rich-only coverage until now).
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnRestApi } from "aws-cdk-lib/aws-apigateway";
import { CfnWorkGroup } from "aws-cdk-lib/aws-athena";
import { CfnUserPool, CfnUserPoolClient } from "aws-cdk-lib/aws-cognito";
import { AttributeType, CfnTable } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnLogGroup } from "aws-cdk-lib/aws-logs";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { CfnQueue } from "aws-cdk-lib/aws-sqs";
import { CfnStateMachine } from "aws-cdk-lib/aws-stepfunctions";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714RevConv3");

new CfnQueue(stack, "Conv3Queue", {});

new CfnWorkGroup(stack, "Conv3WorkGroup", { name: "cdkrd-hunt0714-wg" });

new CfnTable(stack, "Conv3Table", {
  keySchema: [{ attributeName: "pk", keyType: "HASH" }],
  attributeDefinitions: [{ attributeName: "pk", attributeType: AttributeType.STRING }],
  billingMode: "PAY_PER_REQUEST",
});

// StepFunctions: the role needs log-delivery perms so the out-of-band
// "enable logging" mutation is accepted by UpdateStateMachine.
const sfnRole = new Role(stack, "Conv3SfnRole", {
  assumedBy: new ServicePrincipal("states.amazonaws.com"),
});
sfnRole.addToPolicy(
  new PolicyStatement({
    actions: [
      "logs:CreateLogDelivery",
      "logs:GetLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies",
      "logs:DescribeLogGroups",
    ],
    resources: ["*"],
  }),
);
new CfnLogGroup(stack, "Conv3SfnLogs", {});
const sm = new CfnStateMachine(stack, "Conv3Sfn", {
  roleArn: sfnRole.roleArn,
  definitionString: JSON.stringify({
    StartAt: "Done",
    States: { Done: { Type: "Pass", End: true } },
  }),
});
sm.node.addDependency(sfnRole.node.defaultChild!);

new CfnRestApi(stack, "Conv3RestApi", { name: "cdkrd-hunt0714-rest" });

const pool = new CfnUserPool(stack, "Conv3Pool", {});
new CfnUserPoolClient(stack, "Conv3PoolClient", { userPoolId: pool.ref });

// Scheduler: barest schedule targeting the queue (never fires anything useful).
const schedQueue = new CfnQueue(stack, "Conv3SchedQueue", {});
const schedRole = new Role(stack, "Conv3SchedRole", {
  assumedBy: new ServicePrincipal("scheduler.amazonaws.com"),
});
schedRole.addToPolicy(
  new PolicyStatement({ actions: ["sqs:SendMessage"], resources: [schedQueue.attrArn] }),
);
const schedule = new CfnSchedule(stack, "Conv3Schedule", {
  flexibleTimeWindow: { mode: "OFF" },
  scheduleExpression: "rate(12 hours)",
  target: { arn: schedQueue.attrArn, roleArn: schedRole.roleArn },
});
schedule.node.addDependency(schedRole);

app.synth();

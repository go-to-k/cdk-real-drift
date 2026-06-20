// CDK app for the cdk-real-drift "niche but requested" false-positive test.
// Bundles property-rich types that lacked a dedicated clean-check fixture, each a
// distinct normalization stress:
//   - ECR Repository:        JSON-string LifecyclePolicy + scan/encryption config
//   - Step Functions:        DefinitionString JSON + tracing config
//   - WAFv2 WebACL (regional): deeply nested Rules / VisibilityConfig / DefaultAction
//   - EventBridge Rule:      rich EventPattern (nested detail)
// A freshly deployed + recorded stack with NO out-of-band change MUST report CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Repository, TagMutability } from "aws-cdk-lib/aws-ecr";
import { Rule } from "aws-cdk-lib/aws-events";
import { CfnWebACL } from "aws-cdk-lib/aws-wafv2";
import { DefinitionBody, Pass, StateMachine, Wait, WaitTime } from "aws-cdk-lib/aws-stepfunctions";
import { Duration } from "aws-cdk-lib";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegNicheFp");

new Repository(stack, "Images", {
  imageScanOnPush: true,
  imageTagMutability: TagMutability.IMMUTABLE,
  emptyOnDelete: true,
  removalPolicy: RemovalPolicy.DESTROY,
  lifecycleRules: [
    { description: "expire untagged", tagStatus: undefined, maxImageAge: Duration.days(14) },
    { description: "keep last 10 tagged", tagPrefixList: ["v"], maxImageCount: 10 },
  ],
});

new StateMachine(stack, "Flow", {
  tracingEnabled: true,
  definitionBody: DefinitionBody.fromChainable(
    new Pass(stack, "Start").next(new Wait(stack, "Pause", { time: WaitTime.duration(Duration.seconds(1)) })),
  ),
});

new CfnWebACL(stack, "Acl", {
  scope: "REGIONAL",
  defaultAction: { allow: {} },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: "cdkrdNicheAcl",
    sampledRequestsEnabled: true,
  },
  rules: [
    {
      name: "AWSCommon",
      priority: 0,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: "AWS",
          name: "AWSManagedRulesCommonRuleSet",
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "cdkrdCommon",
        sampledRequestsEnabled: true,
      },
    },
  ],
});

new Rule(stack, "OrderRule", {
  description: "cdkrd niche-fp order events",
  eventPattern: {
    source: ["cdkrd.shop"],
    detailType: ["order.placed"],
    detail: { status: ["NEW", "PENDING"], amount: [{ numeric: [">", 100] }] },
  },
});

app.synth();

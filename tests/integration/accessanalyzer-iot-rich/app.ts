// CDK app for the cdk-real-drift accessanalyzer-iot-rich false-positive integration
// test. Exercises three free/instant types cdkrd has never read live:
//   - AWS::AccessAnalyzer::Analyzer — ACCOUNT external-access analyzer with two
//     ArchiveRules: a RuleName-keyed object array whose Filter elements carry
//     property/eq/contains shapes AWS may reorder or re-case.
//   - AWS::IoT::TopicRule — TopicRulePayload nests Sql/AwsIotSqlVersion/Actions;
//     RuleDisabled is the mutable knob the detect path can flip via
//     iot:DisableTopicRule. Action is a discriminated-union-ish object (Sns).
//   - AWS::IoT::Policy — a non-IAM policy document (iot:* actions, client ARNs):
//     runs the policy canonicalization path on an IoT-shaped document.
import { App, Stack } from "aws-cdk-lib";
import { CfnAnalyzer } from "aws-cdk-lib/aws-accessanalyzer";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnPolicy, CfnTopicRule } from "aws-cdk-lib/aws-iot";
import { Topic } from "aws-cdk-lib/aws-sns";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAnalyzerIot");

new CfnAnalyzer(stack, "Analyzer", {
  type: "ACCOUNT",
  analyzerName: "cdkrd-hunt-analyzer",
  archiveRules: [
    {
      ruleName: "ArchiveNonPublic",
      filter: [{ property: "isPublic", eq: ["false"] }],
    },
    {
      ruleName: "ArchiveKnownPrincipal",
      filter: [
        { property: "principal.AWS", contains: ["999988887777"] },
        { property: "resourceType", eq: ["AWS::S3::Bucket"] },
      ],
    },
  ],
});

const topic = new Topic(stack, "AlertTopic");
const role = new Role(stack, "IotRole", {
  assumedBy: new ServicePrincipal("iot.amazonaws.com"),
});
role.addToPolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["sns:Publish"],
    resources: [topic.topicArn],
  }),
);

new CfnTopicRule(stack, "Rule", {
  ruleName: "cdkrd_hunt_rule",
  topicRulePayload: {
    sql: "SELECT * FROM 'cdkrd/hunt'",
    awsIotSqlVersion: "2016-03-23",
    ruleDisabled: false,
    description: "cdkrd hunt fixture rule",
    actions: [{ sns: { targetArn: topic.topicArn, roleArn: role.roleArn, messageFormat: "RAW" } }],
  },
});

new CfnPolicy(stack, "IotPolicy", {
  policyName: "cdkrd-hunt-iot-policy",
  policyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["iot:Connect"],
        Resource: [`arn:aws:iot:${stack.region}:${stack.account}:client/cdkrd-hunt-*`],
      },
      {
        Effect: "Allow",
        Action: ["iot:Publish", "iot:Subscribe"],
        Resource: [`arn:aws:iot:${stack.region}:${stack.account}:topic/cdkrd/hunt`],
      },
    ],
  },
});

app.synth();

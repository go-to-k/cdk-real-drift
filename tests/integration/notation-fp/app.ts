// CDK app for the cdk-real-drift CloudFormation-notation false-positive test.
// Real-world templates wire resource properties through intrinsics; cdkrd reads the
// ORIGINAL deployed template (intrinsics intact) and must resolve them to the same
// value AWS actually applied. This fixture drives several common intrinsics through
// L1 resources via escape hatches:
//   - Fn::FindInMap (CfnMapping)         -> SNS DisplayName + a queue tag prefix
//   - Fn::Sub (map form, nested var)     -> queue tag value
//   - Fn::If (CfnCondition)              -> queue DelaySeconds
//   - Fn::Select + Fn::Split             -> queue MessageRetentionPeriod source
// A freshly deployed + recorded stack with NO out-of-band change MUST report CLEAN;
// a mis-resolved intrinsic would surface as a false declared drift.
import { App, CfnCondition, CfnMapping, Fn, Stack, Token } from "aws-cdk-lib";
import { CfnTopic } from "aws-cdk-lib/aws-sns";
import { CfnQueue } from "aws-cdk-lib/aws-sqs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegNotationFp");

const cfg = new CfnMapping(stack, "Cfg", {
  mapping: {
    settings: { display: "cdkrd-notation", retention: "60.120.240" },
  },
});

const isUsEast = new CfnCondition(stack, "IsUsEast", {
  expression: Fn.conditionEquals(stack.region, "us-east-1"),
});

new CfnTopic(stack, "Topic", {
  displayName: cfg.findInMap("settings", "display"),
});

new CfnQueue(stack, "Queue", {
  // Fn::If on a region condition -> 45 in us-east-1, else 15.
  delaySeconds: Fn.conditionIf(isUsEast.logicalId, 45, 15) as unknown as number,
  // Fn::Select(1, Fn::Split(".", "60.120.240")) -> "120" -> Number.
  messageRetentionPeriod: Token.asNumber(Fn.select(1, Fn.split(".", cfg.findInMap("settings", "retention")))),
  tags: [
    {
      key: "name",
      // Fn::Sub map form with a nested Fn::FindInMap variable.
      value: Fn.sub("${prefix}-queue", { prefix: cfg.findInMap("settings", "display") }),
    },
  ],
});

app.synth();

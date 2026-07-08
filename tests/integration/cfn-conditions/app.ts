// CDK app for the cdk-real-drift resource-level Condition hunt (the raw-CFn
// multi-env staple: `Condition:` on a resource so one template serves dev/prod).
// A condition-FALSE resource is never created, so it has no physical id — the
// template-adapter pushed it anyway and classifyRead tagged it `skipped: no
// physical id` on EVERY check, permanent footer noise a user cannot act on
// (indistinguishable from a real read gap) that also kept `check --strict` red.
// A condition-TRUE resource and an `Fn::If` property selection must classify clean.
import { App, CfnCondition, CfnParameter, Fn, Stack } from "aws-cdk-lib";
import { CfnTopic } from "aws-cdk-lib/aws-sns";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCfnConditions");

const isProd = new CfnParameter(stack, "IsProd", {
  type: "String",
  allowedValues: ["true", "false"],
  default: "false",
});
const prodCond = new CfnCondition(stack, "ProdCond", {
  expression: Fn.conditionEquals(isProd.valueAsString, "true"),
});
const devCond = new CfnCondition(stack, "DevCond", {
  expression: Fn.conditionEquals(isProd.valueAsString, "false"),
});

// Created only in prod — with the default parameter this resource does NOT exist.
const prodOnly = new CfnTopic(stack, "ProdOnlyTopic", {
  displayName: "prod-only",
});
prodOnly.cfnOptions.condition = prodCond;

// Created in dev (condition TRUE) — must read + classify clean.
const devOnly = new CfnTopic(stack, "DevOnlyTopic", {
  displayName: "dev-only",
});
devOnly.cfnOptions.condition = devCond;

// Always created, with an Fn::If-selected property — resolver must pick the
// FALSE branch ("dev-name") and classify clean.
new CfnTopic(stack, "AlwaysTopic", {
  displayName: Fn.conditionIf(prodCond.logicalId, "prod-name", "dev-name").toString(),
});

app.synth();

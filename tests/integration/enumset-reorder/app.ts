// CDK app for the cdk-real-drift enumset-reorder integration test.
//
// The set-reorder false-positive vein, scalar-ENUM edition. cdkrd's generic
// canonicalizeIdArraysDeep folds id/ARN, AZ-name, and HTTP-method scalar sets, but a
// plain enum/string set (a list of fixed keyword values AWS treats as unordered yet
// echoes in ITS canonical order) is only covered by the per-type UNORDERED_ARRAY_PROPS
// allowlist — so any common type with such a set that no fixture has exercised is an
// unguarded gap. The CodeDeploy AutoRollbackConfiguration.Events FP (#364) was exactly
// this class.
//
// Each resource below declares a multi-element scalar enum SET in a deliberately
// NON-sorted order (a sorted declaration would hide a reorder). All are cheap/instant
// — no NAT, no running task, no stateful provisioning:
//   - ECS TaskDefinition.RequiresCompatibilities  ['FARGATE','EC2']  (every ECS user)
//   - Cognito UserPool.UsernameAttributes (sign-in alias set; declared non-sorted —
//     'phone_number' before 'email'). AutoVerifiedAttributes is avoided because
//     verifying phone_number demands an SMS config; UsernameAttributes does not.
//   - Route53 HealthCheck.HealthCheckConfig.Regions (a region-name set the AZ regex
//     does NOT match, so the generic fold leaves it untouched)
import { App, Stack } from "aws-cdk-lib";
import { CfnTaskDefinition } from "aws-cdk-lib/aws-ecs";
import { CfnUserPool } from "aws-cdk-lib/aws-cognito";
import { CfnHealthCheck } from "aws-cdk-lib/aws-route53";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegEnumsetReorder");

// ECS TaskDefinition — RequiresCompatibilities is a scalar enum set; declared
// FARGATE-before-EC2 (non-sorted: 'E' < 'F').
new CfnTaskDefinition(stack, "TaskDef", {
  family: "cdkrd-enumset",
  requiresCompatibilities: ["FARGATE", "EC2"],
  networkMode: "awsvpc",
  cpu: "256",
  memory: "512",
  containerDefinitions: [
    {
      name: "app",
      image: "public.ecr.aws/amazonlinux/amazonlinux:latest",
      essential: true,
    },
  ],
});

// Cognito UserPool — UsernameAttributes is a scalar enum set (allowed sign-in
// aliases); declared non-sorted ('phone_number' before 'email').
new CfnUserPool(stack, "UserPool", {
  userPoolName: "cdkrd-enumset",
  usernameAttributes: ["phone_number", "email"],
});

// Route53 HealthCheck — Regions is a set of region-name enums (where the Route53
// health checkers run); declared non-sorted. Region names lack the hex/AZ suffix so
// the generic id/AZ fold leaves them untouched.
new CfnHealthCheck(stack, "HealthCheck", {
  healthCheckConfig: {
    type: "HTTP",
    fullyQualifiedDomainName: "example.com",
    port: 80,
    resourcePath: "/",
    requestInterval: 30,
    failureThreshold: 3,
    regions: ["us-west-2", "us-east-1", "eu-west-1"],
  },
});

app.synth();

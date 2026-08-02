// CDK app for the cdk-real-drift enum-added2-hunt integration test (2026-08-03 hunt).
// Live end-to-end proof of the five NEWEST child enumerators (#1720 / #1721), which
// landed with unit tests only — no fixture, no corpus, no added-direction live run:
//   - AWS::SSM::MaintenanceWindow        -> MaintenanceWindowTarget / MaintenanceWindowTask
//   - AWS::CodeDeploy::Application       -> DeploymentGroup
//   - AWS::ElasticBeanstalk::Application -> ApplicationVersion / ConfigurationTemplate
//   - AWS::ApplicationAutoScaling::ScalableTarget -> ScalingPolicy
//   - AWS::GuardDuty::Detector           -> Filter (separate stack: a detector is an
//     account singleton, so its create can fail independently of the rest)
// Each parent carries one DECLARED child where cheap, so the "declared children are
// NOT flagged" half runs too (#1722's adjacent-FP lesson). The CodeDeploy deployment
// group deliberately leaves DeploymentStyle / DeploymentConfigName UNDECLARED — the
// first check probes the #1723 folds live, and verify.sh then OOB-mutates
// DeploymentConfigName to probe detection + revert convergence of that fold.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnScalableTarget, CfnScalingPolicy } from "aws-cdk-lib/aws-applicationautoscaling";
import { CfnApplication as CfnCodeDeployApplication, CfnDeploymentGroup } from "aws-cdk-lib/aws-codedeploy";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import {
  CfnApplication as CfnEbApplication,
  CfnConfigurationTemplate,
} from "aws-cdk-lib/aws-elasticbeanstalk";
import { CfnDetector, CfnFilter } from "aws-cdk-lib/aws-guardduty";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Bucket } from "aws-cdk-lib/aws-s3";
import {
  CfnMaintenanceWindow,
  CfnMaintenanceWindowTarget,
  CfnMaintenanceWindowTask,
} from "aws-cdk-lib/aws-ssm";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");

// Solution stack names rot as platforms retire; verify.sh resolves the current
// Docker/AL2023 one at run time and threads it in via `-c ss=...`.
const solutionStack =
  (app.node.tryGetContext("ss") as string | undefined) ??
  "64bit Amazon Linux 2023 v4.13.3 running Docker";

const stack = new Stack(app, "CdkrdHunt0803EnumAdded");

// ── SSM MaintenanceWindow + declared Target + declared Task ────────────────
const window = new CfnMaintenanceWindow(stack, "Window", {
  name: "cdkrd-hunt-mw-0803",
  allowUnassociatedTargets: false,
  cutoff: 1,
  duration: 2,
  schedule: "rate(7 days)",
});
const target = new CfnMaintenanceWindowTarget(stack, "Target", {
  windowId: window.ref,
  resourceType: "INSTANCE",
  targets: [{ key: "tag:cdkrd", values: ["hunt-0803"] }],
});
new CfnMaintenanceWindowTask(stack, "Task", {
  windowId: window.ref,
  taskType: "RUN_COMMAND",
  taskArn: "AWS-RunShellScript",
  priority: 1,
  targets: [{ key: "WindowTargetIds", values: [target.ref] }],
  maxConcurrency: "1",
  maxErrors: "1",
});

// ── CodeDeploy Application + declared barest DeploymentGroup ────────────────
const cdApp = new CfnCodeDeployApplication(stack, "CdApp", {
  applicationName: "cdkrd-hunt-cd-0803",
  computePlatform: "Server",
});
const cdRole = new Role(stack, "CdServiceRole", {
  assumedBy: new ServicePrincipal("codedeploy.amazonaws.com"),
  managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSCodeDeployRole")],
});
// Barest Server deployment group: DeploymentStyle / DeploymentConfigName stay
// undeclared (the #1723 fold surface + the OOB mutate/revert probe target).
new CfnDeploymentGroup(stack, "CdGroup", {
  applicationName: cdApp.ref,
  deploymentGroupName: "cdkrd-hunt-dg-0803",
  serviceRoleArn: cdRole.roleArn,
});

// ── Elastic Beanstalk Application + declared ConfigurationTemplate ─────────
const ebApp = new CfnEbApplication(stack, "EbApp", {
  applicationName: "cdkrd-hunt-eb-0803",
});
const ebTemplate = new CfnConfigurationTemplate(stack, "EbTemplate", {
  applicationName: ebApp.applicationName!,
  solutionStackName: solutionStack,
  optionSettings: [
    {
      namespace: "aws:elasticbeanstalk:environment",
      optionName: "EnvironmentType",
      value: "SingleInstance",
    },
  ],
});
ebTemplate.addDependency(ebApp);

// Bundle bucket for the OOB create-application-version probe (verify.sh uploads a
// dummy zip here). DESTROY, no autoDeleteObjects (its custom resource is always
// skipped=1 and breaks the zero-skip assert; delstack force-deletes non-empty).
new Bucket(stack, "EbBundleBucket", {
  bucketName: "cdkrd-hunt-ebbundle-0803-x9z7q",
  removalPolicy: RemovalPolicy.DESTROY,
});

// ── DynamoDB provisioned table + ScalableTarget + declared ScalingPolicy ───
const ddbTable = new Table(stack, "HuntTable", {
  partitionKey: { name: "pk", type: AttributeType.STRING },
  billingMode: BillingMode.PROVISIONED,
  readCapacity: 1,
  writeCapacity: 1,
  removalPolicy: RemovalPolicy.DESTROY,
});
const scalingRole = new Role(stack, "ScalingRole", {
  assumedBy: new ServicePrincipal("application-autoscaling.amazonaws.com"),
});
const scalableTarget = new CfnScalableTarget(stack, "ScaleTarget", {
  serviceNamespace: "dynamodb",
  resourceId: `table/${ddbTable.tableName}`,
  scalableDimension: "dynamodb:table:ReadCapacityUnits",
  minCapacity: 1,
  maxCapacity: 2,
  roleArn: scalingRole.roleArn,
});
new CfnScalingPolicy(stack, "ScalePolicy", {
  policyName: "cdkrd-hunt-declared-pol-0803",
  policyType: "TargetTrackingScaling",
  scalingTargetId: scalableTarget.ref,
  targetTrackingScalingPolicyConfiguration: {
    predefinedMetricSpecification: { predefinedMetricType: "DynamoDBReadCapacityUtilization" },
    targetValue: 70,
  },
});
// Second, POLICY-LESS target: the OOB put-scaling-policy probe lands here. DynamoDB
// dimensions allow only ONE TargetTracking policy per metric spec and reject
// CustomizedMetricSpecification outright, so the OOB policy needs its own dimension.
new CfnScalableTarget(stack, "WriteScaleTarget", {
  serviceNamespace: "dynamodb",
  resourceId: `table/${ddbTable.tableName}`,
  scalableDimension: "dynamodb:table:WriteCapacityUnits",
  minCapacity: 1,
  maxCapacity: 2,
  roleArn: scalingRole.roleArn,
});

// ── GuardDuty Detector + declared Filter (own stack — account singleton) ───
const gdStack = new Stack(app, "CdkrdHunt0803GdEnum");
const detector = new CfnDetector(gdStack, "HuntDetector", { enable: true });
new CfnFilter(gdStack, "HuntFilter", {
  detectorId: detector.ref,
  name: "cdkrd-hunt-declared-filter-0803",
  findingCriteria: { criterion: { severity: { Gte: 7 } } },
});

app.synth();

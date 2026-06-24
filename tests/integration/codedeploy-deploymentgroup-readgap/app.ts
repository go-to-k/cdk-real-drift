// CDK app for the cdk-real-drift codedeploy-deploymentgroup-readgap integration test.
//
// AWS::CodeDeploy::DeploymentGroup is a daily-driver CI/CD type with NO golden-corpus
// coverage. Its CloudFormation `Ref` returns only the bare DeploymentGroupName, but
// Cloud Control's primaryIdentifier is the COMPOSITE [ApplicationName,
// DeploymentGroupName] (parent-first) — so without a CC_IDENTIFIER_ADAPTERS entry CC
// GetResource ValidationException-skips the group on every check (a silent read-gap:
// undeclared drift on it is invisible). This fixture proves the gap is closed
// (parent-first `ApplicationName|DeploymentGroupName`, the SubscriptionFilter /
// LifecycleHook pattern).
//
// It also doubles as a set-like-reorder false-positive probe: TriggerEvents and
// AutoRollbackConfiguration.Events are scalar enum SETS declared NON-sorted, and the
// AlarmConfiguration.Alarms object array is declared out of Name order — AWS may
// re-emit any of them in a different order.
//
// Cheap: an EC2/on-prem (Server) deployment group needs no instances, no NAT, no
// stateful provisioning — just the application, a service role, an SNS trigger
// target, and two CloudWatch alarms.
import { App, Duration, Stack } from "aws-cdk-lib";
import {
  CfnApplication,
  CfnDeploymentGroup,
} from "aws-cdk-lib/aws-codedeploy";
import { Alarm, Metric } from "aws-cdk-lib/aws-cloudwatch";
import {
  ManagedPolicy,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Topic } from "aws-cdk-lib/aws-sns";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCodeDeployDeploymentGroupReadgap");

const application = new CfnApplication(stack, "App", {
  computePlatform: "Server",
});

const serviceRole = new Role(stack, "ServiceRole", {
  assumedBy: new ServicePrincipal("codedeploy.amazonaws.com"),
  managedPolicies: [
    ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSCodeDeployRole"),
  ],
});

const triggerTopic = new Topic(stack, "TriggerTopic");

const makeAlarm = (id: string, label: string) =>
  new Alarm(stack, id, {
    alarmName: `${label}-${stack.stackName}`,
    metric: new Metric({
      namespace: "CdkRealDrift/CodeDeploy",
      metricName: `${label}Metric`,
      period: Duration.minutes(5),
    }),
    threshold: 1,
    evaluationPeriods: 1,
  });

// declared out of Name order on purpose (zeta before alpha) — a reorder probe for
// the Alarms object array
const zetaAlarm = makeAlarm("ZetaAlarm", "zeta");
const alphaAlarm = makeAlarm("AlphaAlarm", "alpha");

new CfnDeploymentGroup(stack, "Group", {
  applicationName: application.ref,
  serviceRoleArn: serviceRole.roleArn,
  deploymentGroupName: "cdkrd-readgap-dg",
  // a MUTABLE declared property — the false-negative (out-of-band-change) probe
  deploymentConfigName: "CodeDeployDefault.OneAtATime",
  deploymentStyle: {
    deploymentType: "IN_PLACE",
    deploymentOption: "WITHOUT_TRAFFIC_CONTROL",
  },
  // scalar enum SET, declared NON-sorted (Failure, Success, Start) — reorder probe
  triggerConfigurations: [
    {
      triggerName: "deploy-events",
      triggerTargetArn: triggerTopic.topicArn,
      triggerEvents: [
        "DeploymentFailure",
        "DeploymentSuccess",
        "DeploymentStart",
      ],
    },
  ],
  // scalar enum SET, declared NON-sorted — reorder probe
  autoRollbackConfiguration: {
    enabled: true,
    events: ["DEPLOYMENT_STOP_ON_ALARM", "DEPLOYMENT_FAILURE"],
  },
  alarmConfiguration: {
    enabled: true,
    alarms: [
      { name: zetaAlarm.alarmName },
      { name: alphaAlarm.alarmName },
    ],
  },
  // an EC2 tag set (no live instances required for the group to exist) — also a
  // set-like nested array
  ec2TagSet: {
    ec2TagSetList: [
      {
        ec2TagGroup: [
          { key: "App", value: "cdkrd", type: "KEY_AND_VALUE" },
          { key: "Tier", value: "web", type: "KEY_AND_VALUE" },
        ],
      },
    ],
  },
});

app.synth();

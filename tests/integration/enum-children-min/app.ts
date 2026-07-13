// CDK app for the cdk-real-drift enum-children-min integration test (#1540).
// Declares the five parents whose out-of-band-added children the new
// CHILD_ENUMERATORS entries must surface — with one DECLARED child per family
// where cheap (ScheduledAction, LifecycleHook, Glue Table), so the enumerators'
// "declared children are NOT flagged" half is exercised too:
// - AWS::AutoScaling::AutoScalingGroup (desired 0 — no instance cost) with a
//   declared ScheduledAction + LifecycleHook; OOB adds probed by verify.sh.
// - AWS::EC2::VPC (no NAT declared; OOB NAT gateway + flow log probed).
// - AWS::Cognito::UserPool (no domain declared; OOB hosted-UI domain probed).
// - AWS::Glue::Database with one declared Table (OOB table probed).
// - AWS::EC2::TransitGateway (no attachments declared; OOB VPC attachment +
//   route table probed; the AWS-default TGW route table must NOT surface).
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Aws, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnAutoScalingGroup, CfnLifecycleHook, CfnScheduledAction } from "aws-cdk-lib/aws-autoscaling";
import { CfnLaunchTemplate, CfnTransitGateway, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { CfnDatabase, CfnTable } from "aws-cdk-lib/aws-glue";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0713cEnumChildren");

const vpc = new Vpc(stack, "HuntVpc", { maxAzs: 2, natGateways: 0 });

// Flow-log destination for the OOB create-flow-logs probe (bucket only; the
// flow log itself is deliberately NOT declared).
new Bucket(stack, "HuntFlowLogBucket", {
  bucketName: "cdkrd-hunt-flowlog-x9z7q",
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

const lt = new CfnLaunchTemplate(stack, "HuntLt", {
  launchTemplateData: {
    instanceType: "t4g.nano",
    imageId: "{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64}}",
  },
});

const asg = new CfnAutoScalingGroup(stack, "HuntAsg", {
  minSize: "0",
  maxSize: "1",
  desiredCapacity: "0",
  vpcZoneIdentifier: vpc.selectSubnets({ subnetType: SubnetType.PUBLIC }).subnetIds,
  launchTemplate: { launchTemplateId: lt.ref, version: lt.attrLatestVersionNumber },
});

new CfnScheduledAction(stack, "HuntDeclaredSched", {
  autoScalingGroupName: asg.ref,
  recurrence: "0 3 * * *",
  minSize: 0,
  maxSize: 1,
});

new CfnLifecycleHook(stack, "HuntDeclaredHook", {
  autoScalingGroupName: asg.ref,
  lifecycleTransition: "autoscaling:EC2_INSTANCE_LAUNCHING",
  heartbeatTimeout: 120,
  defaultResult: "CONTINUE",
});

new UserPool(stack, "HuntPool", {
  removalPolicy: RemovalPolicy.DESTROY,
});

const db = new CfnDatabase(stack, "HuntGlueDb", {
  catalogId: Aws.ACCOUNT_ID,
  databaseInput: { name: "cdkrd_hunt_enum_db" },
});

new CfnTable(stack, "HuntDeclaredTable", {
  catalogId: Aws.ACCOUNT_ID,
  databaseName: "cdkrd_hunt_enum_db",
  tableInput: {
    name: "cdkrd_hunt_declared_table",
    storageDescriptor: {
      columns: [{ name: "id", type: "string" }],
      location: "s3://cdkrd-hunt-flowlog-x9z7q/decl/",
    },
  },
}).addDependency(db);

new CfnTransitGateway(stack, "HuntTgw", {
  description: "cdkrd hunt enum-children TGW",
});

// CDK app for the cdk-real-drift added-pack-hunt integration test (2026-08-03 hunt).
// Live added-direction proof for six OLDER child enumerators that shipped with unit
// tests only (audit 2026-08-03) — each parent is declared WITHOUT the child, and
// verify.sh creates the child out of band:
//   - AWS::S3::Bucket            -> BucketPolicy   (put-bucket-policy)
//   - AWS::SQS::Queue            -> QueuePolicy    (set-queue-attributes Policy)
//   - AWS::SecretsManager::Secret-> ResourcePolicy (put-resource-policy)
//   - AWS::Route53::HostedZone   -> RecordSet      (change-resource-record-sets)
//   - AWS::EC2::NetworkAcl       -> NetworkAclEntry (create-network-acl-entry;
//     notRevertable by design (#1405) — detection asserted, manual removal)
//   - AWS::Glue::Database        -> Table          (glue create-table)
// All children but the NACL entry are then deleted via `revert --remove-unrecorded`
// (the delete-kind plan path, incl. the Route53 SDK deleter #1431).
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnNetworkAcl, CfnVPC } from "aws-cdk-lib/aws-ec2";
import { CfnDatabase } from "aws-cdk-lib/aws-glue";
import { PublicHostedZone } from "aws-cdk-lib/aws-route53";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Queue } from "aws-cdk-lib/aws-sqs";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0803AddedPack");

new Bucket(stack, "PolicylessBucket", {
  bucketName: "cdkrd-hunt-addedpack-0803-x9z7q",
  removalPolicy: RemovalPolicy.DESTROY,
});

new Queue(stack, "PolicylessQueue", { queueName: "cdkrd-hunt-addedpack-0803" });

new Secret(stack, "PolicylessSecret", {
  secretName: "cdkrd-hunt-addedpack-0803",
  removalPolicy: RemovalPolicy.DESTROY,
});

// Non-reserved placeholder domain (`example.com` / `.test` / `.example` are
// AWS-reserved for hosted zones). Not authoritative — never resolved.
new PublicHostedZone(stack, "Zone", { zoneName: "cdkrd-hunt-0803-x9z7q.com" });

// Dedicated NACL (not the VPC default) so the OOB entry lands on a DECLARED
// parent. A bare CfnVPC suffices — a NACL needs no subnets.
const vpc = new CfnVPC(stack, "HuntVpc", { cidrBlock: "10.99.0.0/24" });
new CfnNetworkAcl(stack, "HuntNacl", { vpcId: vpc.ref });

new CfnDatabase(stack, "HuntGlueDb", {
  catalogId: stack.account,
  databaseInput: { name: "cdkrd_hunt_addedpack_0803" },
});

app.synth();

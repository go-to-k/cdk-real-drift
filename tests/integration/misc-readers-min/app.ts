// CDK app for the cdk-real-drift misc-readers-min false-positive integration test.
// BAREST-possible configs of zero-coverage SDK-override readers:
// - AWS::IAM::AccessKey (#716): reader exists, never exercised by any fixture.
// - AWS::LakeFormation::Resource: DescribeResource-based reader, zero coverage.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnAccessKey, User } from "aws-cdk-lib/aws-iam";
import { CfnResource as LakeFormationCfnResource } from "aws-cdk-lib/aws-lakeformation";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0713MiscReaders");

const user = new User(stack, "HuntUser", {
  userName: "cdkrd-hunt-accesskey-user",
});

new CfnAccessKey(stack, "HuntAccessKey", {
  userName: user.userName,
});

const bucket = new Bucket(stack, "HuntLfBucket", {
  bucketName: "cdkrd-hunt-lf-bucket-x9z7q",
  removalPolicy: RemovalPolicy.DESTROY,
});

new LakeFormationCfnResource(stack, "HuntLfResource", {
  resourceArn: bucket.bucketArn,
  useServiceLinkedRole: true,
});

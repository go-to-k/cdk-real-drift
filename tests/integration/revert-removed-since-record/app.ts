// CDK app for the cdk-real-drift "revert a removed-since-record value" integration
// test (real AWS, AWS-mutating). A minimal S3 bucket with NO declared tags: verify.sh
// sets an undeclared bucket tag out of band, records it, then deletes it out of band
// and reverts — proving a recorded UNDECLARED value that disappears can be RESTORED by
// `revert` (it previously failed with "no physical id": the synthesized
// removed-since-record finding carried no physical id). The bucket stays empty so
// destroy needs no autoDeleteObjects custom resource (no /aws/lambda log-group orphan).
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegRevertRemoved");

new Bucket(stack, "Data", { removalPolicy: RemovalPolicy.DESTROY });

app.synth();

// Minimal CDK app for the cdk-real-drift `added` (out-of-band resource) integ test.
// A REST API with ONE declared method (POST /scoring). verify.sh then adds an ANY
// method on the ROOT `/` resource out of band (via the AWS CLI) — a whole resource
// not in the template — and asserts cdkrd reports it under [Added (Out-of-Band)].
import { App, Stack } from "aws-cdk-lib";
import { RestApi } from "aws-cdk-lib/aws-apigateway";

const app = new App();
const stack = new Stack(app, "CdkrdIntegApigwAdded");
const api = new RestApi(stack, "Api", { deployOptions: { stageName: "prod" } });
api.root.addResource("scoring").addMethod("POST");
app.synth();

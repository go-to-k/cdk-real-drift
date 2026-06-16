// Minimal CDK app for the cdk-real-drift `added` (out-of-band resource) integ test.
// A REST API with a declared method on a child resource (POST /scoring) AND a declared
// method on the ROOT `/` resource (GET /). verify.sh then adds an ANY method on root
// out of band (via the AWS CLI) — a whole resource not in the template — and asserts
// cdkrd reports EXACTLY that one under [Added Resource] (added=1). The declared
// GET / is the false-positive guard: its ResourceId is `GetAtt RootResourceId`, which
// must re-resolve to the live root id so the declared root method is NOT flagged added.
import { App, Stack } from "aws-cdk-lib";
import { RestApi } from "aws-cdk-lib/aws-apigateway";

const app = new App();
const stack = new Stack(app, "CdkrdIntegApigwAdded");
const api = new RestApi(stack, "Api", { deployOptions: { stageName: "prod" } });
api.root.addMethod("GET"); // declared method on root — must NOT false-positive as added
api.root.addResource("scoring").addMethod("POST");
app.synth();

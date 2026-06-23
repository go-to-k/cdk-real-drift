// KMS key exercising rich config the existing KMS corpus (a basic DataKey) does not:
// automatic key rotation (with an explicit rotation period), a multi-region key, and
// an explicit key policy (a JSON policy document — a shape-coercion candidate). KMS is
// a daily-driver type; clean record->check is the FP oracle. (delstack schedules key
// deletion; the sweep accounts for keys pending deletion.)
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { AccountRootPrincipal, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegKmsRich");

const key = new Key(stack, "RotatedKey", {
  enableKeyRotation: true,
  rotationPeriod: Duration.days(180),
  multiRegion: true,
  description: "cdkrd kms-rich rotated multi-region key",
  removalPolicy: RemovalPolicy.DESTROY,
});

key.addToResourcePolicy(
  new PolicyStatement({
    sid: "AllowAccountAdmin",
    principals: [new AccountRootPrincipal()],
    actions: ["kms:Describe*", "kms:Get*", "kms:List*"],
    resources: ["*"],
  }),
);

app.synth();

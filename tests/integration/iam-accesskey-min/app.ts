// CDK app for the cdk-real-drift iam-accesskey-min false-positive integration
// test. BAREST-possible IAM AccessKey — the SDK override reader
// (readIamAccessKey, #716) was added from a live FN report and has ZERO corpus
// cases and ZERO fixtures, so its barest first-run path (undeclared Status
// defaulting to Active) has never been exercised live. A first `check`
// (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnAccessKey, CfnUser } from "aws-cdk-lib/aws-iam";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegIamAccessKeyMin");

const user = new CfnUser(stack, "HuntUser", {
  userName: "cdkrd-hunt-accesskey-user",
});

new CfnAccessKey(stack, "HuntAccessKey", {
  userName: user.ref,
});

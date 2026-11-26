// Fixture for #1958: one Lambda whose code is a CDK S3 asset. CODE_VERSION picks the
// asset directory, so a redeploy with a different version is a LEGIT code deploy (new
// asset key, new CodeSha256) that the #1606 stale-source void folds — and verify.sh then
// swaps the code out of band to prove the swap is still caught.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";

const version = process.env.CODE_VERSION ?? "v1";
const dir = join(tmpdir(), "cdkrd-integ-1958", version);
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, "index.js"),
  `exports.handler = async () => ({ statusCode: 200, body: "${version}" });\n`
);

const app = new App();
const stack = new Stack(app, "CdkrdInteg1958LambdaSwap");
new Function(stack, "SwapFn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromAsset(dir),
  description: "cdk-real-drift #1958 code-swap-after-redeploy fixture",
});
app.synth();

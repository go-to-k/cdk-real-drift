// R103 fixture: a CloudFront Distribution materializes many NESTED config defaults
// the template never declared (Origins[].CustomOriginConfig.HTTPPort=80 / HTTPSPort=443
// / OriginReadTimeout=30, PriceClass, DefaultCacheBehavior.AllowedMethods, ...). The
// CloudFront CFn schema annotates these as `default`, so cdkrd folds the matching live
// values as `atDefault` (informational) instead of drowning the report in `undeclared`.
// HttpOrigin → a CustomOriginConfig carrying the schema-defaulted ports/timeout.
import { App, Stack } from "aws-cdk-lib";
import { Distribution, ViewerProtocolPolicy } from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";

const app = new App();
const stack = new Stack(app, "CdkrdIntegCfAtDefault");

new Distribution(stack, "Cdn", {
  defaultBehavior: {
    origin: new HttpOrigin("example.com"),
    viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
  },
  comment: "cdkrd cf atDefault fixture",
});

app.synth();

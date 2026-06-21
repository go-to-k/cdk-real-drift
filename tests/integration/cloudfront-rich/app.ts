// CDK app for the cdk-real-drift cloudfront-rich FP + detect integration test.
// CloudFront Distribution (read NATIVELY via Cloud Control) nests identity-keyed
// arrays (Origins[].Id, CacheBehaviors[].PathPattern) inside DistributionConfig — a
// bug-prone NESTED-array surface. The mutable Comment is the declared detect/revert
// subject; the verify-detect script also adds an out-of-band ORIGIN to probe whether a
// live-only nested-array element is caught (the differentiator at depth). HTTP origins
// keep the stack self-contained (no S3 bucket needed).
import { App, Stack } from "aws-cdk-lib";
import { AllowedMethods, Distribution, PriceClass, ViewerProtocolPolicy } from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCloudfrontRich");

new Distribution(stack, "Cdn", {
  comment: "cdkrd cloudfront rich",
  priceClass: PriceClass.PRICE_CLASS_100,
  defaultBehavior: {
    origin: new HttpOrigin("origin1.example.com"),
    viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
  },
  additionalBehaviors: {
    "/api/*": {
      origin: new HttpOrigin("origin2.example.com"),
      viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
    },
  },
});

app.synth();

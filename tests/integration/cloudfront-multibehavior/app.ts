// CDK app for the cdk-real-drift CloudFront multi-behavior false-positive integ test.
// UNTESTED structural gap: `DistributionConfig.CacheBehaviors` is an object array whose
// elements are keyed by `PathPattern` — NOT a standard IDENTITY_FIELD (Key/Id/
// AttributeName/IndexName/Name) — and it is absent from every UNORDERED_* table. The
// existing cloudfront-rich fixture declares only ONE additional behavior, so a reorder
// of the CacheBehaviors array has never been exercised. Distributions with several
// path-pattern behaviors are an everyday CloudFront pattern (static assets / API /
// images on different origins). If AWS returns CacheBehaviors in a different order than
// declared, a positional diff would false-flag declared drift on every check. This
// fixture declares THREE behaviors across two origins to surface that ordering risk.
import { App, Stack } from "aws-cdk-lib";
import {
  AllowedMethods,
  Distribution,
  PriceClass,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCloudfrontMulti");

const apiOrigin = new HttpOrigin("api.example.com");
const imgOrigin = new HttpOrigin("img.example.com");

new Distribution(stack, "Cdn", {
  comment: "cdkrd cloudfront multi-behavior",
  priceClass: PriceClass.PRICE_CLASS_100,
  defaultBehavior: {
    origin: new HttpOrigin("origin.example.com"),
    viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
  },
  additionalBehaviors: {
    "/api/*": {
      origin: apiOrigin,
      viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: AllowedMethods.ALLOW_ALL,
    },
    "/images/*": {
      origin: imgOrigin,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      compress: true,
    },
    "/static/*": {
      origin: imgOrigin,
      viewerProtocolPolicy: ViewerProtocolPolicy.ALLOW_ALL,
    },
  },
});

app.synth();

// CloudFront corpus fixture (R75): the single most CONFIG-DENSE resource type
// — DistributionConfig nests origins, behaviors, cache/origin-request policy
// refs, restrictions, certificates, HTTP versions, and CloudFront materializes
// service defaults for most of what a template omits. The corpus has only
// hand-written CloudFront seeds; this records the real thing. Two behaviors +
// two origins so the Id-keyed Origins sort and the method enum-set sort both
// run against live data. Slow type (deploy/destroy minutes each) — kept OUT of
// the harvest fixtures so their fast loop stays fast.
import { App, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  AllowedMethods,
  CachedMethods,
  CachePolicy,
  Distribution,
  HttpVersion,
  PriceClass,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkrdIntegCloudfront");

const assets = new Bucket(stack, "Assets", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
});

new Distribution(stack, "Cdn", {
  defaultBehavior: {
    origin: S3BucketOrigin.withOriginAccessControl(assets),
    viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
    cachedMethods: CachedMethods.CACHE_GET_HEAD,
    cachePolicy: CachePolicy.CACHING_OPTIMIZED,
    compress: true,
  },
  additionalBehaviors: {
    "/api/*": {
      origin: new HttpOrigin("api.example.com", {
        readTimeout: Duration.seconds(20),
      }),
      viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy: CachePolicy.CACHING_DISABLED,
    },
  },
  priceClass: PriceClass.PRICE_CLASS_100,
  httpVersion: HttpVersion.HTTP2_AND_3,
  defaultRootObject: "index.html",
  errorResponses: [
    {
      httpStatus: 404,
      responseHttpStatus: 200,
      responsePagePath: "/index.html",
      ttl: Duration.minutes(5),
    },
  ],
  comment: "cdkrd cloudfront corpus fixture",
});

app.synth();

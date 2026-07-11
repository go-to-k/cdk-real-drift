// CDK app for the cdk-real-drift cloudfront-min false-positive integration
// test. BAREST-possible CloudFront Distribution — every existing corpus case
// DECLARES PriceClass and HttpVersion, so their undeclared-default echoes
// (PriceClass_All / http1.1) have never been exercised and have no fold.
// Also leaves CustomOriginConfig ports, Comment, Restrictions, Logging,
// ViewerCertificate, DefaultRootObject, WebACLId undeclared.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnDistribution } from "aws-cdk-lib/aws-cloudfront";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegCloudFrontMin");

new CfnDistribution(stack, "HuntMinDist", {
  distributionConfig: {
    enabled: true,
    defaultCacheBehavior: {
      targetOriginId: "origin1",
      viewerProtocolPolicy: "allow-all",
      // CachingOptimized managed cache policy
      cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
    },
    origins: [
      {
        id: "origin1",
        domainName: "example.org",
        customOriginConfig: { originProtocolPolicy: "https-only" },
      },
    ],
  },
});

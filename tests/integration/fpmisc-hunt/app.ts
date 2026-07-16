// Declared-tier FP probes predicted by the offline allowlist-gap audit (real AWS).
// DETERMINATIONS (live, 2026-07-17, us-east-1): first check CLEAN on all three — each
// service echoes the declared value VERBATIM, so none needs an allowlist entry:
// - WAFv2::RegexPatternSet.RegularExpressionList: semantically a SET, but WAFv2
//   preserves a non-sorted 3-element list's order/content exactly (no
//   UNORDERED_ARRAY_PROPS gap). Pinned by the RegexSetUnsorted corpus case.
// - CloudFront::ResponseHeadersPolicy CORS AllowHeaders/ExposeHeaders: CloudFront is
//   case- AND order-preserving (unlike the folded ApiGwV2/Lambda-Url header sets in
//   CASE_INSENSITIVE_ARRAY_PATHS — no entry needed). Pinned by the RhpCors corpus case.
// - ECS::TaskDefinition networkMode "host": register-only (free, no instances);
//   folds clean like bridge/awsvpc.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnResponseHeadersPolicy } from "aws-cdk-lib/aws-cloudfront";
import { CfnTaskDefinition } from "aws-cdk-lib/aws-ecs";
import { CfnRegexPatternSet } from "aws-cdk-lib/aws-wafv2";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const rev = app.node.tryGetContext("rev");
if (rev) Tags.of(app).add("cdkrd:rev", String(rev));

const s = new Stack(app, "CdkrdHunt0717FpMisc");

// Deliberately NON-sorted regex list — if WAFv2 stores it sorted/reordered, the
// declared tier FPs on order.
new CfnRegexPatternSet(s, "RegexSet", {
  scope: "REGIONAL",
  regularExpressionList: ["zzz.*", "aaa[0-9]+", "mmm-.*"],
});

// Mixed-case, non-sorted CORS header sets.
new CfnResponseHeadersPolicy(s, "RhpCors", {
  responseHeadersPolicyConfig: {
    name: "CdkrdHunt0717RhpCors",
    corsConfig: {
      accessControlAllowCredentials: false,
      accessControlAllowHeaders: {
        items: ["X-Zebra-Header", "authorization", "Content-Type"],
      },
      accessControlAllowMethods: { items: ["POST", "GET"] },
      accessControlAllowOrigins: { items: ["https://example.com"] },
      accessControlExposeHeaders: {
        items: ["X-Zulu-Expose", "content-length", "ETag"],
      },
      originOverride: false,
    },
  },
});

// host-mode EC2 task definition — register-only, no cluster/instances needed.
new CfnTaskDefinition(s, "HostTaskDef", {
  family: "cdkrd-hunt0717-host",
  requiresCompatibilities: ["EC2"],
  networkMode: "host",
  containerDefinitions: [
    {
      name: "app",
      image: "public.ecr.aws/docker/library/busybox:latest",
      memory: 128,
    },
  ],
});

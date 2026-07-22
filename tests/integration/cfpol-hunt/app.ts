// Declared-tier reorder probe (real AWS): CloudFront CachePolicy folds only
// HeadersConfig.Headers as an unordered nested set (noise.ts
// UNORDERED_NESTED_OBJECT_ARRAY_PATHS) — the sibling CookiesConfig.Cookies and
// QueryStringsConfig.QueryStrings whitelists share the identical set semantic
// but are unguarded, and OriginRequestPolicy / ResponseHeadersPolicy have no
// entries at all. Every existing corpus case is single-element, so a reorder
// can't surface offline. This deploys multi-element, deliberately unsorted
// lists on all three policy types and asserts the first check is CLEAN.
import { App, Stack, Tags } from "aws-cdk-lib";
import {
  CfnCachePolicy,
  CfnOriginRequestPolicy,
  CfnResponseHeadersPolicy,
} from "aws-cdk-lib/aws-cloudfront";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0722CfPol");

new CfnCachePolicy(stack, "HuntCachePolicy", {
  cachePolicyConfig: {
    name: "cdkrd-hunt0722-cache-policy",
    minTtl: 0,
    maxTtl: 86400,
    defaultTtl: 3600,
    parametersInCacheKeyAndForwardedToOrigin: {
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: false,
      headersConfig: {
        headerBehavior: "whitelist",
        headers: ["x-cdkrd-zz", "x-cdkrd-aa", "x-cdkrd-mm"],
      },
      cookiesConfig: {
        cookieBehavior: "whitelist",
        cookies: ["zz-cookie", "aa-cookie", "mm-cookie"],
      },
      queryStringsConfig: {
        queryStringBehavior: "whitelist",
        queryStrings: ["zz", "aa", "mm"],
      },
    },
  },
});

new CfnOriginRequestPolicy(stack, "HuntOrp", {
  originRequestPolicyConfig: {
    name: "cdkrd-hunt0722-orp",
    headersConfig: {
      headerBehavior: "whitelist",
      headers: ["x-cdkrd-zz", "x-cdkrd-aa", "x-cdkrd-mm"],
    },
    cookiesConfig: {
      cookieBehavior: "whitelist",
      cookies: ["zz-cookie", "aa-cookie", "mm-cookie"],
    },
    queryStringsConfig: {
      queryStringBehavior: "whitelist",
      queryStrings: ["zz", "aa", "mm"],
    },
  },
});

new CfnResponseHeadersPolicy(stack, "HuntRhp", {
  responseHeadersPolicyConfig: {
    name: "cdkrd-hunt0722-rhp",
    corsConfig: {
      accessControlAllowCredentials: false,
      accessControlAllowHeaders: { items: ["X-Cdkrd-Zz", "X-Cdkrd-Aa", "X-Cdkrd-Mm"] },
      accessControlAllowMethods: { items: ["POST", "GET", "DELETE"] },
      accessControlAllowOrigins: {
        items: ["https://zz.example.com", "https://aa.example.com"],
      },
      originOverride: true,
    },
    customHeadersConfig: {
      items: [
        { header: "x-cdkrd-custom-zz", value: "zz", override: true },
        { header: "x-cdkrd-custom-aa", value: "aa", override: false },
      ],
    },
  },
});

app.synth();

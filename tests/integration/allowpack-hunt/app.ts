// 2026-08-10 hunt: predicted allowlist-gap FPs (Round-0 offline audit) — each
// resource declares the exact shape whose live echo is suspected to diverge
// from the declared value by a pure normalization cdkrd does not fold yet:
//  - S3 LifecycleConfiguration DATE-valued rules (ExpirationDate /
//    TransitionDate): no ISO-8601/timestamp normalization exists anywhere in
//    normalize/; the live read may re-serialize the midnight-UTC date.
//    Rider: NotificationConfiguration EventBridgeEnabled (absent from the
//    declared-key corpus inventory entirely).
//  - SNS Topic DeliveryPolicy: a PARTIAL healthyRetryPolicy is expanded by the
//    service into the full document (the JSON_STRING_DEFAULT_FILLS class,
//    which has a single CE CostCategory entry).
//  - Route53 RecordSetGroup: the whole RecordSet fold family (case, trailing
//    dot, ResourceRecords reorder) keys on AWS::Route53::RecordSet only —
//    RecordSetGroup nests the same objects under RecordSets.* and none match.
//  - WAFv2 WebACL / RuleGroup FieldToMatch.SingleHeader.Name declared in mixed
//    case: WAF stores header names LOWERCASED (proven for the sibling
//    LoggingConfiguration RedactedFields entry; the WebACL/RuleGroup statement
//    paths have no entry and are variable-depth).
// First `check` (pre-record) must show ZERO [Potential Drift].
//  - RDS OptionGroup EngineName / DBParameterGroup Family declared in mixed
//    case: the CC handler ACCEPTS "MySQL" / "MySQL8.4" and stores lowercased
//    (stackless CC probe 2026-08-10) — the #1712 owning-prop entries cover the
//    *name* identifiers only, not these enum-ish props.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnDBParameterGroup, CfnOptionGroup } from "aws-cdk-lib/aws-rds";
import { CfnHostedZone, CfnRecordSetGroup } from "aws-cdk-lib/aws-route53";
import { CfnBucket } from "aws-cdk-lib/aws-s3";
import { CfnTopic } from "aws-cdk-lib/aws-sns";
import { CfnRuleGroup, CfnWebACL } from "aws-cdk-lib/aws-wafv2";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0810Allow");

// --- S3 lifecycle date rules + EventBridge notification ---
const bucket = new CfnBucket(stack, "Bucket", {
  lifecycleConfiguration: {
    rules: [
      {
        id: "date-expire",
        status: "Enabled",
        prefix: "archive/",
        expirationDate: new Date("2027-01-01T00:00:00Z"),
        transitions: [{ storageClass: "GLACIER", transitionDate: new Date("2026-12-01T00:00:00Z") }],
      },
    ],
  },
  notificationConfiguration: {
    eventBridgeConfiguration: { eventBridgeEnabled: true },
  },
});
bucket.applyRemovalPolicy(RemovalPolicy.DESTROY);

// --- SNS topic with a PARTIAL DeliveryPolicy (service fills the rest) ---
new CfnTopic(stack, "Topic", {
  topicName: "cdkrd-0810a-topic",
  deliveryPolicy: {
    http: {
      defaultHealthyRetryPolicy: { numRetries: 5 },
    },
  },
});

// --- Route53 hosted zone + RecordSetGroup (mixed case, no trailing dot, multi-value) ---
const zone = new CfnHostedZone(stack, "Zone", {
  name: "cdkrd-fphunt-a0810.com.",
});
new CfnRecordSetGroup(stack, "Records", {
  hostedZoneId: zone.attrId,
  recordSets: [
    {
      // mixed case + NO trailing dot — Route53 stores lowercased + dotted
      name: "MiXeD-Case.cdkrd-fphunt-a0810.com",
      type: "A",
      ttl: "300",
      resourceRecords: ["192.0.2.1"],
    },
    {
      // multi-value TXT declared non-sorted — reorder probe
      name: "txt.cdkrd-fphunt-a0810.com.",
      type: "TXT",
      ttl: "300",
      resourceRecords: ['"zulu"', '"alpha"', '"mike"'],
    },
  ],
});

// --- WAFv2 WebACL + RuleGroup with mixed-case header names ---
new CfnWebACL(stack, "WebAcl", {
  name: "cdkrd-0810a-acl",
  scope: "REGIONAL",
  defaultAction: { allow: {} },
  visibilityConfig: {
    cloudWatchMetricsEnabled: false,
    metricName: "cdkrd0810aAcl",
    sampledRequestsEnabled: false,
  },
  rules: [
    {
      name: "hdr",
      priority: 0,
      action: { block: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: false,
        metricName: "cdkrd0810aHdr",
        sampledRequestsEnabled: false,
      },
      statement: {
        byteMatchStatement: {
          fieldToMatch: { singleHeader: { Name: "User-Agent" } },
          positionalConstraint: "CONTAINS",
          searchString: "cdkrd-hunt",
          textTransformations: [{ priority: 0, type: "NONE" }],
        },
      },
    },
  ],
});
new CfnRuleGroup(stack, "RuleGroup", {
  name: "cdkrd-0810a-rg",
  scope: "REGIONAL",
  capacity: 25,
  visibilityConfig: {
    cloudWatchMetricsEnabled: false,
    metricName: "cdkrd0810aRg",
    sampledRequestsEnabled: false,
  },
  rules: [
    {
      name: "qarg",
      priority: 0,
      action: { count: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: false,
        metricName: "cdkrd0810aQarg",
        sampledRequestsEnabled: false,
      },
      statement: {
        byteMatchStatement: {
          fieldToMatch: { singleQueryArgument: { Name: "SessionId" } },
          positionalConstraint: "EXACTLY",
          searchString: "x",
          textTransformations: [{ priority: 0, type: "NONE" }],
        },
      },
    },
  ],
});

// --- RDS mixed-case EngineName / Family (stored lowercased) ---
new CfnOptionGroup(stack, "Og", {
  optionGroupName: "cdkrd-0810a-og",
  engineName: "MySQL",
  majorEngineVersion: "8.4",
  optionGroupDescription: "cdkrd 0810 allowpack",
});
new CfnDBParameterGroup(stack, "Dpg", {
  dbParameterGroupName: "cdkrd-0810a-dpg",
  family: "MySQL8.4",
  description: "cdkrd 0810 allowpack",
});

app.synth();

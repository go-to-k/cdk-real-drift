// cdk-real-drift SNS Topic DataProtectionPolicy false-positive test.
// A DataProtectionPolicy is a JSON document; AWS may echo it with reordered keys,
// reordered statements, or a generated/normalized field — exactly the JSON-doc shape
// that historically hides a canonicalization false positive. A freshly deployed +
// recorded topic with NO out-of-band change MUST be CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnTopic, Topic } from "aws-cdk-lib/aws-sns";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSnsDataProtectionRich");

const topic = new Topic(stack, "Topic", { displayName: "cdkrd-dpp" });

// DataProtectionPolicy is only on the L1 — set it via the escape hatch.
(topic.node.defaultChild as CfnTopic).dataProtectionPolicy = {
  Name: "cdkrd-dpp",
  Description: "cdkrd data-protection-policy test",
  Version: "2021-06-01",
  Statement: [
    {
      Sid: "DenyInboundEmail",
      DataDirection: "Inbound",
      Principal: ["*"],
      DataIdentifier: ["arn:aws:dataprotection::aws:data-identifier/EmailAddress"],
      Operation: { Deny: {} },
    },
  ],
};

app.synth();

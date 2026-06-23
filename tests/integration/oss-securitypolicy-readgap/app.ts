// cdk-real-drift OpenSearch Serverless SecurityPolicy read-gap test.
// AWS::OpenSearchServerless::SecurityPolicy primaryIdentifier is the COMPOSITE
// [Type, Name], but its CFn physical id (Ref) is the bare Name — so Cloud Control
// GetResource rejects the bare id (ValidationException) and the policy is silently
// `skipped` (read-gap: undeclared drift on it is invisible). The fix derives the
// `${Type}|${Name}` composite from the declared Type prop. It is one of the cheapest
// possible deploys (a single JSON-policy resource — no collection/VPC/instance). After
// the CC_IDENTIFIER_ADAPTERS fix it reads, so a fresh deploy + record + check is CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnSecurityPolicy } from "aws-cdk-lib/aws-opensearchserverless";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegOssSecurityPolicyReadGap");

new CfnSecurityPolicy(stack, "EncryptionPolicy", {
  name: "cdkrd-readgap-enc",
  type: "encryption",
  description: "cdkrd oss security-policy read-gap test",
  policy: JSON.stringify({
    Rules: [{ ResourceType: "collection", Resource: ["collection/cdkrd-readgap-*"] }],
    AWSOwnedKey: true,
  }),
});

app.synth();

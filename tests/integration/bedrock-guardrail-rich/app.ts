// CDK app for the cdk-real-drift Bedrock Guardrail false-positive test. Guardrails
// are an increasingly common GenAI-safety primitive, and AWS::Bedrock::Guardrail has
// not been exercised. It is a deep nest of policy-config ARRAYS — content filters,
// denied topics, word + managed-word lists, and PII entities — each element of which
// AWS materializes with extra defaulted sub-fields (InputAction / InputEnabled /
// OutputAction / OutputEnabled / Modalities) that the template never declares. That
// undeclared-nested-default surface is exactly where false positives hide. A freshly
// deployed + recorded guardrail with NO out-of-band change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnGuardrail } from "aws-cdk-lib/aws-bedrock";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegBedrockGuardrailRich");

new CfnGuardrail(stack, "Guardrail", {
  name: "cdkrd-guardrail",
  description: "cdk-real-drift integ guardrail",
  blockedInputMessaging: "Your input was blocked by the guardrail.",
  blockedOutputsMessaging: "The response was blocked by the guardrail.",
  contentPolicyConfig: {
    filtersConfig: [
      { type: "HATE", inputStrength: "HIGH", outputStrength: "HIGH" },
      { type: "VIOLENCE", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
    ],
  },
  wordPolicyConfig: {
    wordsConfig: [{ text: "badword" }],
    managedWordListsConfig: [{ type: "PROFANITY" }],
  },
  topicPolicyConfig: {
    topicsConfig: [
      {
        name: "Investments",
        definition: "Specific advice on whether to buy or sell securities.",
        type: "DENY",
        examples: ["Should I buy this stock?"],
      },
    ],
  },
  sensitiveInformationPolicyConfig: {
    piiEntitiesConfig: [{ type: "EMAIL", action: "ANONYMIZE" }],
  },
});

app.synth();

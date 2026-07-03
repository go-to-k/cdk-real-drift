// Integration fixture for #564: Lex Bot BotLocales STRUCTURAL revert (create/delete whole
// intents). A bot with two user intents (OrderFlowers, Greeting) + a custom slot type + the
// built-in FallbackIntent. The verify script deletes a whole intent out of band (revert must
// RECREATE it) and adds a whole intent out of band (revert must DELETE it), never touching
// FallbackIntent. Also the corpus-harvest source for a fully-reconstructed BotLocales
// (AWS__Lex__Bot.Bot.json) — a clean-deploy #527 reader regression guard.
import { App, Stack } from "aws-cdk-lib";
import { CfnBot } from "aws-cdk-lib/aws-lex";
import { Role, ServicePrincipal, PolicyStatement, Effect } from "aws-cdk-lib/aws-iam";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegLexStructural");

const role = new Role(stack, "BotRole", {
  assumedBy: new ServicePrincipal("lexv2.amazonaws.com"),
});
role.addToPolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["polly:SynthesizeSpeech", "comprehend:DetectSentiment"],
    resources: ["*"],
  }),
);

new CfnBot(stack, "Bot", {
  name: "cdkrd-integ-lex-structural",
  roleArn: role.roleArn,
  // NOTE: CDK L1 does NOT PascalCase this nested prop; CloudFormation requires the raw
  // `ChildDirected` key (`childDirected` fails early validation). strip-types drops the type
  // annotation at runtime, so the raw-cased object passes through to the template.
  dataPrivacy: { ChildDirected: false } as unknown as CfnBot.DataPrivacyProperty,
  idleSessionTtlInSeconds: 300,
  autoBuildBotLocales: true,
  botLocales: [
    {
      localeId: "en_US",
      nluConfidenceThreshold: 0.4,
      slotTypes: [
        {
          name: "FlowerType",
          valueSelectionSetting: { resolutionStrategy: "ORIGINAL_VALUE" },
          slotTypeValues: [
            { sampleValue: { value: "roses" } },
            { sampleValue: { value: "lilies" } },
          ],
        },
      ],
      intents: [
        {
          name: "OrderFlowers",
          sampleUtterances: [
            { utterance: "I want to order flowers" },
            { utterance: "Order some flowers" },
          ],
        },
        {
          name: "Greeting",
          sampleUtterances: [{ utterance: "hello" }, { utterance: "hi there" }],
        },
        {
          name: "FallbackIntent",
          parentIntentSignature: "AMAZON.FallbackIntent",
        },
      ],
    },
  ],
});

app.synth();

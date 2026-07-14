// Composite-primaryIdentifier read-gap probe (real AWS): types whose registry
// schema declares a MULTI-segment primaryIdentifier and that are NOT in
// CC_IDENTIFIER_ADAPTERS / SDK_OVERRIDES. If a type's CFn physical id is only
// the bare child segment, Cloud Control GetResource rejects it and the
// resource is silently `skipped` (the #344 SubscriptionFilter class). One
// cheap stack deploys them all; the first `check`'s footer tells which (if
// any) need an adapter:
// - ServiceCatalog::PortfolioPrincipalAssociation  [PortfolioId, PrincipalARN]
// - ServiceCatalog::TagOptionAssociation           [TagOptionId, ResourceId]
// - ServiceCatalogAppRegistry::AttributeGroupAssociation [ApplicationArn, AttributeGroupArn]
// - OpenSearchServerless::AccessPolicy             [Type, Name]
// - EC2::SecurityGroupVpcAssociation               [GroupId, VpcId]
// - Lex::BotVersion [BotId, BotVersion] + Lex::BotAlias [BotAliasId, BotId]
import { App, Stack, Tags } from "aws-cdk-lib";
import {
  CfnSecurityGroup,
  CfnSecurityGroupVpcAssociation,
  CfnVPC,
} from "aws-cdk-lib/aws-ec2";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnBot, CfnBotAlias, CfnBotVersion } from "aws-cdk-lib/aws-lex";
import { CfnAccessPolicy } from "aws-cdk-lib/aws-opensearchserverless";
import {
  CfnPortfolio,
  CfnPortfolioPrincipalAssociation,
  CfnTagOption,
  CfnTagOptionAssociation,
} from "aws-cdk-lib/aws-servicecatalog";
import {
  CfnApplication,
  CfnAttributeGroup,
  CfnAttributeGroupAssociation,
} from "aws-cdk-lib/aws-servicecatalogappregistry";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0714CcPi");

// --- ServiceCatalog: portfolio + principal association + tag option assoc
const portfolio = new CfnPortfolio(stack, "Portfolio", {
  displayName: "cdkrd-hunt-ccpi",
  providerName: "cdkrd",
});
const principalRole = new Role(stack, "PrincipalRole", {
  assumedBy: new ServicePrincipal("servicecatalog.amazonaws.com"),
});
new CfnPortfolioPrincipalAssociation(stack, "PrincipalAssoc", {
  portfolioId: portfolio.ref,
  principalArn: principalRole.roleArn,
  principalType: "IAM",
});
const tagOption = new CfnTagOption(stack, "TagOption", {
  key: "cdkrd-hunt",
  value: "ccpi",
});
new CfnTagOptionAssociation(stack, "TagOptionAssoc", {
  tagOptionId: tagOption.ref,
  resourceId: portfolio.ref,
});

// --- AppRegistry: application + attribute group + association
const application = new CfnApplication(stack, "AppRegApp", {
  name: "cdkrd-hunt-ccpi",
});
const attrGroup = new CfnAttributeGroup(stack, "AttrGroup", {
  name: "cdkrd-hunt-ccpi",
  attributes: { env: "hunt" },
});
// GetAtt references (not the name strings) so CFn orders the association
// after both parents — the name form deployed first and 404ed on the race.
new CfnAttributeGroupAssociation(stack, "AttrGroupAssoc", {
  application: application.attrId,
  attributeGroup: attrGroup.attrId,
});

// --- OpenSearch Serverless data access policy (no collection needed)
new CfnAccessPolicy(stack, "AossAccessPolicy", {
  name: "cdkrd-hunt-ccpi",
  type: "data",
  policy: JSON.stringify([
    {
      Rules: [
        {
          ResourceType: "collection",
          Resource: ["collection/cdkrd-hunt-*"],
          Permission: ["aoss:DescribeCollectionItems"],
        },
      ],
      Principal: [`arn:aws:iam::${stack.account}:root`],
    },
  ]),
});

// --- EC2 SecurityGroupVpcAssociation (SG in VPC A associated into VPC B)
const vpcA = new CfnVPC(stack, "VpcA", { cidrBlock: "10.62.0.0/24" });
const vpcB = new CfnVPC(stack, "VpcB", { cidrBlock: "10.63.0.0/24" });
const sg = new CfnSecurityGroup(stack, "Sg", {
  groupDescription: "cdkrd hunt ccpi",
  vpcId: vpcA.ref,
});
new CfnSecurityGroupVpcAssociation(stack, "SgVpcAssoc", {
  groupId: sg.attrGroupId,
  vpcId: vpcB.ref,
});

// --- Lex: minimal bot + a numbered version + an alias pinned to it
const botRole = new Role(stack, "BotRole", {
  assumedBy: new ServicePrincipal("lexv2.amazonaws.com"),
});
const bot = new CfnBot(stack, "Bot", {
  name: "cdkrd-hunt-ccpi-bot",
  roleArn: botRole.roleArn,
  // CFn requires the raw `ChildDirected` casing (see lex-structural).
  dataPrivacy: { ChildDirected: false } as unknown as CfnBot.DataPrivacyProperty,
  idleSessionTtlInSeconds: 300,
  autoBuildBotLocales: true,
  botLocales: [
    {
      localeId: "en_US",
      nluConfidenceThreshold: 0.4,
      intents: [
        {
          name: "Greeting",
          sampleUtterances: [{ utterance: "hello" }],
        },
        { name: "FallbackIntent", parentIntentSignature: "AMAZON.FallbackIntent" },
      ],
    },
  ],
});
const botVersion = new CfnBotVersion(stack, "BotVersion", {
  botId: bot.attrId,
  botVersionLocaleSpecification: [
    {
      localeId: "en_US",
      botVersionLocaleDetails: { sourceBotVersion: "DRAFT" },
    },
  ],
});
new CfnBotAlias(stack, "BotAlias", {
  botAliasName: "hunt",
  botId: bot.attrId,
  botVersion: botVersion.attrBotVersion,
});

app.synth();

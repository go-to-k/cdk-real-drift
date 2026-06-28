// CDK app for the cdk-real-drift Cognito attachment read-gap test.
//
// AWS::Cognito::UserPoolRiskConfigurationAttachment and
// AWS::Cognito::UserPoolUICustomizationAttachment both have a COMPOSITE Cloud
// Control primaryIdentifier [UserPoolId, ClientId], but their CloudFormation Ref
// (physical id) is a synthetic string that is NEITHER segment nor the pipe form.
// Without a CC_IDENTIFIER_ADAPTERS entry, Cloud Control GetResource rejects the
// bare physical id with a ValidationException, so cdkrd silently SKIPS the
// resource — any out-of-band drift on it is invisible (a false negative).
//
// This fixture deploys both attachments against a real user pool + client so the
// read-gap can be reproduced (check shows skipped=) and the adapter fix verified
// (check reads them; a freshly recorded stack is CLEAN; an out-of-band mutation is
// detected).
import { App, Stack } from "aws-cdk-lib";
import {
  CfnUserPool,
  CfnUserPoolClient,
  CfnUserPoolDomain,
  CfnUserPoolRiskConfigurationAttachment,
  CfnUserPoolUICustomizationAttachment,
} from "aws-cdk-lib/aws-cognito";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCognitoAttachmentReadgap");

// PLUS tier enables threat protection, required by RiskConfigurationAttachment.
const pool = new CfnUserPool(stack, "Pool", {
  userPoolName: "cdkrd-attach-pool",
  userPoolTier: "PLUS",
  userPoolAddOns: { advancedSecurityMode: "AUDIT" },
});

const client = new CfnUserPoolClient(stack, "Client", {
  userPoolId: pool.ref,
  clientName: "cdkrd-attach-client",
  generateSecret: false,
  explicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
});

// UICustomizationAttachment requires an existing hosted-UI domain on the pool.
const domain = new CfnUserPoolDomain(stack, "Domain", {
  userPoolId: pool.ref,
  domain: "cdkrd-attach-x7q2z9",
});

new CfnUserPoolRiskConfigurationAttachment(stack, "RiskConfig", {
  userPoolId: pool.ref,
  clientId: client.ref,
  compromisedCredentialsRiskConfiguration: {
    actions: { eventAction: "BLOCK" },
  },
  accountTakeoverRiskConfiguration: {
    actions: {
      lowAction: { eventAction: "NO_ACTION", notify: false },
      mediumAction: { eventAction: "NO_ACTION", notify: false },
      highAction: { eventAction: "NO_ACTION", notify: false },
    },
  },
});

const ui = new CfnUserPoolUICustomizationAttachment(stack, "UICustomization", {
  userPoolId: pool.ref,
  clientId: client.ref,
  css: ".banner-customizable { background-color: #112233; }",
});
ui.addDependency(domain);

app.synth();

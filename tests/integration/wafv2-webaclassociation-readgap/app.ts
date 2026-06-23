// CDK app for the cdk-real-drift wafv2-webaclassociation-readgap integration test.
// AWS::WAFv2::WebACLAssociation has a COMPOSITE Cloud Control primaryIdentifier
// [ResourceArn, WebACLArn]. A regional WebACL associated with a protected resource
// (here a Cognito user pool — the cheapest associatable target, no ALB/NAT) is a
// common WAF setup. This probes whether a declared association is a CC read-gap
// (ValidationException skip) like the other composite-identifier types, and the live
// read confirms the exact composite order for any needed CC_IDENTIFIER_ADAPTERS entry.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { CfnWebACL, CfnWebACLAssociation } from "aws-cdk-lib/aws-wafv2";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegWafv2WebaclassociationReadgap");

const acl = new CfnWebACL(stack, "Acl", {
  scope: "REGIONAL",
  defaultAction: { allow: {} },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: "cdkrdReadgapAcl",
    sampledRequestsEnabled: true,
  },
});

const pool = new UserPool(stack, "Pool", {
  removalPolicy: RemovalPolicy.DESTROY,
});

new CfnWebACLAssociation(stack, "Assoc", {
  resourceArn: pool.userPoolArn,
  webAclArn: acl.attrArn,
});

app.synth();

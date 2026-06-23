// CDK app for the cdk-real-drift cognito-userpooldomain-rich integration test.
// AWS::Cognito::UserPoolDomain is a common type (every hosted-UI / OAuth flow needs
// one) with NO golden-corpus coverage yet. It is Cloud Control-readable via a
// composite-id adapter (UserPoolId + Domain), so a clean record->check is a
// false-positive oracle and its live read harvests a fresh corpus case. A
// Cognito-hosted (prefix) domain needs no ACM certificate and is cheap. The prefix
// is a distinctive placeholder to avoid the global-uniqueness collision (same
// convention as the Route53 placeholder-domain fixtures).
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { UserPool } from "aws-cdk-lib/aws-cognito";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCognitoUserpooldomainRich");

const pool = new UserPool(stack, "Pool", {
  removalPolicy: RemovalPolicy.DESTROY,
});

pool.addDomain("Domain", {
  cognitoDomain: { domainPrefix: "cdkrd-fphunt-x9z7q" },
});

app.synth();

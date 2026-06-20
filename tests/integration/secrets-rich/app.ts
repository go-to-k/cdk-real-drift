// CDK app for the cdk-real-drift richly-configured Secrets Manager secret
// false-positive test. Secrets are deployed by a large fraction of CDK apps; the
// existing coverage is only incidental (harvest corpus / readgap), never a
// deploy-verified FP integ for the production shape. This one exercises the
// GenerateSecretString block (a structured object CFn uses to MINT the value, whose
// live SecretString is then opaque/NoEcho — a normalization edge cdkrd must not
// false-positive on), a customer-managed KmsKeyId (intrinsic ref), and a
// Description. A freshly deployed + recorded secret with NO out-of-band change MUST
// report CLEAN.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { Key } from "aws-cdk-lib/aws-kms";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSecretsRich");

const key = new Key(stack, "SecretKey", {
  enableKeyRotation: true,
  removalPolicy: RemovalPolicy.DESTROY,
});

const secret = new Secret(stack, "DbCreds", {
  description: "rich secret fixture for cdk-real-drift",
  encryptionKey: key,
  generateSecretString: {
    secretStringTemplate: JSON.stringify({ username: "admin" }),
    generateStringKey: "password",
    excludeCharacters: '"@/\\',
    passwordLength: 24,
  },
  removalPolicy: RemovalPolicy.DESTROY,
});
Tags.of(secret).add("team", "platform");
Tags.of(secret).add("cost-center", "1234");

app.synth();

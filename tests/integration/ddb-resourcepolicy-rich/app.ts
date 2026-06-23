// cdk-real-drift DynamoDB Table ResourcePolicy false-positive test.
// A DynamoDB resource-based policy is a JSON document AWS may echo with reordered
// keys/statements, a generated Sid, or an expanded principal ARN — the JSON-doc shape
// that historically hides a canonicalization false positive. A freshly deployed +
// recorded table with NO out-of-band change MUST be CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { AttributeType, Table } from "aws-cdk-lib/aws-dynamodb";
import {
  AccountRootPrincipal,
  PolicyDocument,
  PolicyStatement,
} from "aws-cdk-lib/aws-iam";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegDdbResourcePolicyRich");

new Table(stack, "Table", {
  partitionKey: { name: "pk", type: AttributeType.STRING },
  removalPolicy: RemovalPolicy.DESTROY,
  resourcePolicy: new PolicyDocument({
    statements: [
      new PolicyStatement({
        sid: "AllowAccountRead",
        actions: ["dynamodb:GetItem", "dynamodb:Query"],
        principals: [new AccountRootPrincipal()],
        resources: ["*"],
      }),
    ],
  }),
});

app.synth();

// CDK app for the cdk-real-drift CloudWatch Logs DataProtectionPolicy /
// FieldIndexPolicies false-positive test. A LogGroup is one of the most common
// resources, and a DataProtectionPolicy is a JSON document (audit + de-identify
// statements) that AWS may re-serialize / reorder on store — the same JSON-doc
// reformatting class that policy canonicalization handles for IAM, but on a
// NON-IAM JSON property that has its own shape. FieldIndexPolicies is a second
// JSON array AWS may echo back reformatted. A freshly deployed + recorded log
// group with NO out-of-band change MUST report CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnLogGroup } from "aws-cdk-lib/aws-logs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegLogsDataProtectionRich");

const logGroup = new CfnLogGroup(stack, "Lg", {
  logGroupName: "/cdkrd/integ/dataprotection-rich",
  retentionInDays: 7,
  // A data-protection policy: audit + de-identify EmailAddress/PhoneNumber. AWS
  // stores this JSON and echoes it back, potentially reformatted/reordered.
  dataProtectionPolicy: {
    Name: "cdkrd-data-protection",
    Description: "mask PII in logs",
    Version: "2021-06-01",
    Statement: [
      {
        Sid: "audit",
        DataIdentifier: [
          "arn:aws:dataprotection::aws:data-identifier/EmailAddress",
          "arn:aws:dataprotection::aws:data-identifier/PhoneNumber-US",
        ],
        Operation: {
          Audit: {
            FindingsDestination: {},
          },
        },
      },
      {
        Sid: "deidentify",
        DataIdentifier: [
          "arn:aws:dataprotection::aws:data-identifier/EmailAddress",
          "arn:aws:dataprotection::aws:data-identifier/PhoneNumber-US",
        ],
        Operation: {
          Deidentify: {
            MaskConfig: {},
          },
        },
      },
    ],
  },
  // Field index policies — a second JSON array AWS may echo reformatted.
  fieldIndexPolicies: [
    {
      Fields: ["requestId", "eventName", "userIdentity.arn"],
    },
  ],
});
logGroup.applyRemovalPolicy(RemovalPolicy.DESTROY);

app.synth();

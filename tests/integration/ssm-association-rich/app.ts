// CDK app for the cdk-real-drift SSM Association false-positive test. State Manager
// Associations are a common fleet-management primitive, and AWS::SSM::Association has
// not been exercised. The interesting surface is its nested config: a Targets array,
// a ScheduleExpression, MaxConcurrency / MaxErrors (stringly-typed numbers), and
// ComplianceSeverity — each its own normalization edge. The association points at a
// built-in document and a tag target that matches no instances (it never runs, which
// is fine — we only read its config). A freshly deployed + recorded association with
// NO out-of-band change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnAssociation } from "aws-cdk-lib/aws-ssm";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSsmAssociationRich");

new CfnAssociation(stack, "Assoc", {
  name: "AWS-UpdateSSMAgent",
  associationName: "cdkrd-assoc",
  scheduleExpression: "rate(7 days)",
  targets: [{ key: "tag:cdkrd", values: ["true"] }],
  maxConcurrency: "1",
  maxErrors: "1",
  complianceSeverity: "MEDIUM",
});

app.synth();

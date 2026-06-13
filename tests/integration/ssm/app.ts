// CDK app for the cdk-real-drift SSM false-positive integration test (R88).
// Tricky declared property: SSM Document Content — declared as an OBJECT in the
// template, but AWS returns it as a JSON STRING with keys in a different order
// (R75 object<->JSON-string structural equality). Plus a plain StringParameter.
import { App, Stack } from "aws-cdk-lib";
import { CfnDocument, StringParameter } from "aws-cdk-lib/aws-ssm";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSsm");

new StringParameter(stack, "Param", {
  parameterName: "/cdkrd-integ/ssm/p1",
  stringValue: "hello-world",
});

new CfnDocument(stack, "Doc", {
  name: "cdkrd-integ-doc",
  documentType: "Command",
  content: {
    schemaVersion: "2.2",
    description: "cdk-real-drift integ document",
    mainSteps: [
      {
        action: "aws:runShellScript",
        name: "run",
        inputs: { runCommand: ["echo hello"] },
      },
    ],
  },
});

app.synth();

// CDK app for the cdk-real-drift ResourceGroups::Group false-positive test.
// AWS::ResourceGroups::Group is a common way to group resources by tag/stack. Its
// ResourceQuery.Query is a STRUCTURED OBJECT in the CloudFormation template, but
// services frequently store such query/definition blobs as a JSON STRING and echo
// them back stringified — the object<->JSON-string divergence class. If Cloud
// Control returns Query as a string (or with reordered TagFilters/Values), a naive
// diff false-flags it. A freshly deployed + recorded group with NO out-of-band
// change MUST report CLEAN.
import { App, Stack } from "aws-cdk-lib";
import { CfnGroup } from "aws-cdk-lib/aws-resourcegroups";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegResourceGroupsRich");

new CfnGroup(stack, "Group", {
  name: "cdkrd-integ-group",
  description: "cdkrd resource group probe",
  resourceQuery: {
    type: "TAG_FILTERS_1_0",
    query: {
      resourceTypeFilters: ["AWS::AllSupported"],
      tagFilters: [
        { key: "env", values: ["prod", "staging"] },
        { key: "team", values: ["platform"] },
      ],
    },
  },
});

app.synth();

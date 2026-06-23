// cdk-real-drift Redshift ClusterParameterGroup Parameters reorder test.
// A Redshift::ClusterParameterGroup's `Parameters` is an ARRAY of {ParameterName,
// ParameterValue} keyed by ParameterName (NOT one of cdkrd's IDENTITY_FIELDS), so a
// positional compare false-flags every shifted parameter if AWS returns them in a
// different order than declared. The parameters are declared in NON-alphabetical
// order (require_ssl before enable_user_activity_logging) to reveal any sort-on-read.
// A freshly deployed + recorded group with NO out-of-band change MUST be CLEAN
// (either AWS preserves the order, or the per-type fold aligns the set).
import { App, Stack } from "aws-cdk-lib";
import { CfnClusterParameterGroup } from "aws-cdk-lib/aws-redshift";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegRedshiftParamGroupReorder");

new CfnClusterParameterGroup(stack, "ParamGroup", {
  description: "cdkrd redshift param-group reorder test",
  parameterGroupFamily: "redshift-1.0",
  // Deliberately NON-alphabetical so a sort-by-ParameterName reorder is revealed.
  parameters: [
    { parameterName: "require_ssl", parameterValue: "true" },
    { parameterName: "enable_user_activity_logging", parameterValue: "true" },
    { parameterName: "max_concurrency_scaling_clusters", parameterValue: "1" },
  ],
});

app.synth();

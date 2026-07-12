// Barest-config bundle of cheap, fast, Cloud-Control-readable resource types
// that have ZERO golden-corpus cases and ZERO fixtures, for the cdk-real-drift
// first-run FP hunt: Rbin::Rule (whose CC primaryIdentifier is the ARN — if
// the CFn physical id is the short rule id, the read may be silently skipped),
// NetworkManager::GlobalNetwork (zero required props = maximal undeclared
// surface), and ServiceCatalogAppRegistry::Application. Each is declared with
// only what CFn requires so the first `check` (before `record`) exposes any
// fold gaps.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnGlobalNetwork } from "aws-cdk-lib/aws-networkmanager";
import { CfnRule } from "aws-cdk-lib/aws-rbin";
import { CfnApplication } from "aws-cdk-lib/aws-servicecatalogappregistry";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntMiscBarest0712c");

new CfnRule(stack, "RbinRule", {
  resourceType: "EBS_SNAPSHOT",
  retentionPeriod: { retentionPeriodValue: 7, retentionPeriodUnit: "DAYS" },
});

new CfnGlobalNetwork(stack, "GlobalNetwork", {});

new CfnApplication(stack, "AppRegistryApp", {
  name: "cdkrd-hunt-appreg-0712c",
});

app.synth();

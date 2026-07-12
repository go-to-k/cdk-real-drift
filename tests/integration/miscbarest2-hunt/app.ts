// Barest-config bundle #2 for the cdk-real-drift first-run FP hunt — all zero-corpus,
// CC-readable types: NetworkManager Site/Device/Link (COMPOSITE primaryIdentifier
// [GlobalNetworkId, <child>Id] with NO CC_IDENTIFIER_ADAPTERS entry — if the CFn physical
// id is a bare child id or ARN, the read should skip, a composite-id read-gap finding),
// DataBrew Dataset/Recipe/Project, and a Lightsail Instance. Each declares only what CFn
// requires so the first `check` (before `record`) exposes fold gaps.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnBucket } from "aws-cdk-lib/aws-s3";
import { CfnDataset, CfnRecipe } from "aws-cdk-lib/aws-databrew";
import { CfnInstance } from "aws-cdk-lib/aws-lightsail";
import { CfnDevice, CfnGlobalNetwork, CfnLink, CfnSite } from "aws-cdk-lib/aws-networkmanager";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHuntMiscBarest20712c");

// --- NetworkManager (free, instant) ---
const gn = new CfnGlobalNetwork(stack, "Gn", {});
const site = new CfnSite(stack, "Site", { globalNetworkId: gn.attrId });
new CfnDevice(stack, "Device", { globalNetworkId: gn.attrId, siteId: site.attrSiteId });
new CfnLink(stack, "Link", {
  globalNetworkId: gn.attrId,
  siteId: site.attrSiteId,
  bandwidth: { downloadSpeed: 50, uploadSpeed: 10 },
});

// --- DataBrew (free until a job runs; a Project is NOT included — CreateProject
// validates that the dataset's S3 object actually exists, a deploy-time finding
// recorded here: barest Dataset/Recipe do no such validation) ---
const bucket = new CfnBucket(stack, "Bucket");
new CfnDataset(stack, "Dataset", {
  name: "cdkrd-hunt-dataset-0712c",
  input: { s3InputDefinition: { bucket: bucket.ref, key: "input.csv" } },
});
new CfnRecipe(stack, "Recipe", {
  name: "cdkrd-hunt-recipe-0712c",
  steps: [{ action: { operation: "UPPER_CASE", parameters: { sourceColumn: "col1" } } }],
});

// --- Lightsail (nano bundle, cents/hour) ---
new CfnInstance(stack, "Ls", {
  instanceName: "cdkrd-hunt-ls-0712c",
  blueprintId: "amazon_linux_2023",
  bundleId: "nano_3_0",
});

app.synth();

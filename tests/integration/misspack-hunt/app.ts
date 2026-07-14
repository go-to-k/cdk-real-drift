// Barest-form first-run FP probe: nine alive, cheap, CC-readable resource types
// with ZERO corpus/fixture coverage (probed via describe-type: all single
// primaryIdentifier + read handler). Most other uncovered types are dead
// services (QLDB/CodeCommit/MediaStore/Evidently), account singletons
// (Macie/Inspector), or too expensive (ACMPCA/FSx/EKS nodegroups) — this pack
// is the surviving tail:
// - EMR::SecurityConfiguration (barest: config JSON only, Name undeclared)
// - SageMaker::ModelPackageGroup (name only) + SageMaker::Pipeline (Fail-step
//   definition + role — barest MLOps pair)
// - Transfer::Workflow (one DELETE step; Description undeclared)
// - Location::APIKey (required Restrictions only; ExpireTime/NoExpiry undeclared)
// - SES::DedicatedIpPool (pool name only — ScalingMode undeclared probes the
//   STANDARD default fold; a pool without leased IPs is free)
// - XRay::ResourcePolicy (name + document; BypassPolicyLockoutCheck write-only)
// - Backup::RestoreTestingPlan (required selection/schedule only)
// Stack A carries the no-dependency simple types; stack B the SageMaker pair,
// so one create-time validation failure cannot roll back the whole probe.
// (S3ObjectLambda::AccessPoint was in the pack but is CLOSED to new customers
// — "available only to existing customers", live-determined 2026-07-15 — so
// it joins the dead-service exclusion list, not the fixture.)
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnRestoreTestingPlan } from "aws-cdk-lib/aws-backup";
import { CfnSecurityConfiguration } from "aws-cdk-lib/aws-emr";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnAPIKey } from "aws-cdk-lib/aws-location";
import { CfnModelPackageGroup, CfnPipeline } from "aws-cdk-lib/aws-sagemaker";
import { CfnDedicatedIpPool } from "aws-cdk-lib/aws-ses";
import { CfnWorkflow } from "aws-cdk-lib/aws-transfer";
import { CfnResourcePolicy } from "aws-cdk-lib/aws-xray";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
// `-c rev=2` threads a neutral tag update through every resource — the
// post-update echo probe (redeploy with rev=2, re-check; see hunt-bugs skill).
const rev = app.node.tryGetContext("rev");
if (rev) Tags.of(app).add("cdkrd:rev", String(rev));

// ---------------------------------------------------------------- stack A
const a = new Stack(app, "CdkrdHunt0715MissA");

new CfnSecurityConfiguration(a, "EmrSecConfig", {
  securityConfiguration: {
    EncryptionConfiguration: {
      EnableInTransitEncryption: false,
      EnableAtRestEncryption: false,
    },
  },
});

new CfnWorkflow(a, "TransferWorkflow", {
  // deleteStepDetails is untyped (`any`) in the L1 — keys pass through to the
  // template verbatim, so they must be CFn-cased (lowercase `name` fails early
  // validation with "Unsupported property [name]").
  steps: [{ type: "DELETE", deleteStepDetails: { Name: "del" } }],
});

new CfnAPIKey(a, "LocationKey", {
  keyName: "cdkrd-hunt-0715-key",
  // NoExpiry/ExpireTime cannot BOTH stay undeclared — the service rejects the
  // barest form ("At least one of the following fields must be set", live
  // 2026-07-15), so NoExpiry is part of the minimal config.
  noExpiry: true,
  restrictions: {
    allowActions: ["geo:GetMap*"],
    allowResources: [`arn:aws:geo:us-east-1:${a.account}:map/*`],
  },
});

new CfnDedicatedIpPool(a, "SesPool", {
  poolName: "cdkrd-hunt-0715-pool",
});

new CfnResourcePolicy(a, "XrayPolicy", {
  policyName: "cdkrd-hunt-0715-xray",
  policyDocument: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "sns.amazonaws.com" },
        Action: ["xray:PutTraceSegments", "xray:GetSamplingRules"],
        Resource: "*",
      },
    ],
  }),
});

new CfnRestoreTestingPlan(a, "RestorePlan", {
  restoreTestingPlanName: "cdkrd_hunt_0715_rtp",
  scheduleExpression: "cron(0 5 ? * MON *)",
  recoveryPointSelection: {
    algorithm: "LATEST_WITHIN_WINDOW",
    includeVaults: ["*"],
    recoveryPointTypes: ["SNAPSHOT"],
  },
});

// ---------------------------------------------------------------- stack B
const b = new Stack(app, "CdkrdHunt0715MissB");

new CfnModelPackageGroup(b, "MpGroup", {
  modelPackageGroupName: "cdkrd-hunt-0715-mpg",
});

const smRole = new Role(b, "SmRole", {
  assumedBy: new ServicePrincipal("sagemaker.amazonaws.com"),
});

new CfnPipeline(b, "SmPipeline", {
  pipelineName: "cdkrd-hunt-0715-pipeline",
  roleArn: smRole.roleArn,
  pipelineDefinition: {
    PipelineDefinitionBody: JSON.stringify({
      Version: "2020-12-01",
      Metadata: {},
      Parameters: [],
      Steps: [{ Name: "NoOp", Type: "Fail", Arguments: { ErrorMessage: "noop" } }],
    }),
  },
});


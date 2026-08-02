// CDK app for the cdk-real-drift lakeformation-hunt false-positive integration
// test. Proves the CONTEXT_ARN_DEFAULTS LakeFormation PrincipalPermissions row
// live — it was mirrored off the Tag sibling with no deploy of its own
// (2026-08-02 hunt, variant-audit finding, the #1664 mirrored-row class):
//   AWS::LakeFormation::PrincipalPermissions Catalog -> '{accountId}'
// Barest shape: PrincipalPermissions omits Catalog and grants DESCRIBE on a
// throwaway Glue database to a throwaway in-stack role.
// (AWS::LakeFormation::Tag was probed 2026-08-02 and CANNOT be created by a
// non-data-lake-admin principal — "Insufficient Lake Formation permission(s):
// Required Create LF Tag on Catalog" — so its CatalogId row stays claim-only;
// making the deploy principal an LF admin is an account-level settings change a
// hunt must not make.)
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Aws, Stack, Tags } from "aws-cdk-lib";
import { CfnDatabase } from "aws-cdk-lib/aws-glue";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnPrincipalPermissions } from "aws-cdk-lib/aws-lakeformation";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegLakeFormationHunt");

const db = new CfnDatabase(stack, "HuntLfDb", {
  catalogId: Aws.ACCOUNT_ID,
  databaseInput: { name: "cdkrd_hunt_lf_db" },
});

const grantee = new Role(stack, "HuntLfRole", {
  assumedBy: new ServicePrincipal("glue.amazonaws.com"),
});

const perms = new CfnPrincipalPermissions(stack, "HuntLfPerms", {
  principal: { dataLakePrincipalIdentifier: grantee.roleArn },
  resource: { database: { catalogId: Aws.ACCOUNT_ID, name: "cdkrd_hunt_lf_db" } },
  permissions: ["DESCRIBE"],
  permissionsWithGrantOption: [],
});
perms.addDependency(db);

app.synth();

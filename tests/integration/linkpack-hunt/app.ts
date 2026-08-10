// 2026-08-11 hunt wave 2 — cheap association/link-shaped probes in one stack:
// - Glue resource link (#1749 live witness): a declared TARGET database + table and a
//   declared RESOURCE-LINK database pointing at it. GetTables on the link proxies to
//   the target's tables, so pre-fix the link's child enumeration false-flags t1 as
//   `added` (with a destructive delete offer); post-fix the check must be clean.
// - ECS ClusterCapacityProviderAssociations declaring [FARGATE_SPOT, FARGATE]
//   (deliberately unsorted): the sibling Cluster.CapacityProviders was live-proven
//   sorted-echo (#1491) against the same attachment API, and this type is absent from
//   UNORDERED_ARRAY_PROPS — reorder-FP probe.
// - AppSync MERGED API + SourceApiAssociation: the GraphQLApi child enumerator has no
//   ApiType branch — probes whether a merged API's live child inventory (data sources
//   merged in from the source) false-flags as `added`.
// - RDS GlobalCluster HEADLESS barest (no member clusters — free, fast): first-run FP
//   probe of the undeclared defaults observed on the #1750 CC probe echo
//   (EngineVersion, StorageEncrypted, DeletionProtection, EngineLifecycleSupport).
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import {
  CfnDataSource,
  CfnGraphQLApi,
  CfnGraphQLSchema,
  CfnSourceApiAssociation,
} from "aws-cdk-lib/aws-appsync";
import { CfnCluster, CfnClusterCapacityProviderAssociations } from "aws-cdk-lib/aws-ecs";
import { CfnDatabase, CfnTable } from "aws-cdk-lib/aws-glue";
import { PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnGlobalCluster } from "aws-cdk-lib/aws-rds";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const rev = app.node.tryGetContext("rev");
if (rev) Tags.of(app).add("cdkrd:rev", String(rev));

const s = new Stack(app, "CdkrdHunt0811LinkPack");

// --- Glue resource link (#1749 witness) ---
const targetDb = new CfnDatabase(s, "TargetDb", {
  catalogId: s.account,
  databaseInput: { name: "cdkrd_hunt_0811_link_target" },
});
const targetTable = new CfnTable(s, "TargetTable", {
  catalogId: s.account,
  databaseName: "cdkrd_hunt_0811_link_target",
  tableInput: {
    name: "t1",
    tableType: "EXTERNAL_TABLE",
    storageDescriptor: {
      columns: [{ name: "c1", type: "string" }],
      location: "s3://example-nonexistent/x",
    },
  },
});
targetTable.addDependency(targetDb);
const linkDb = new CfnDatabase(s, "LinkDb", {
  catalogId: s.account,
  databaseInput: {
    name: "cdkrd_hunt_0811_link",
    targetDatabase: { catalogId: s.account, databaseName: "cdkrd_hunt_0811_link_target" },
  },
});
linkDb.addDependency(targetDb);

// --- ECS ClusterCapacityProviderAssociations reorder probe ---
const cluster = new CfnCluster(s, "EcsCluster", { clusterName: "cdkrd-hunt-0811-ccpa" });
new CfnClusterCapacityProviderAssociations(s, "Ccpa", {
  cluster: cluster.ref,
  capacityProviders: ["FARGATE_SPOT", "FARGATE"], // deliberately unsorted
  defaultCapacityProviderStrategy: [],
});

// --- AppSync merged API probe ---
const srcApi = new CfnGraphQLApi(s, "SrcApi", {
  name: "cdkrd-hunt-0811-src",
  authenticationType: "API_KEY",
});
const srcSchema = new CfnGraphQLSchema(s, "SrcSchema", {
  apiId: srcApi.attrApiId,
  definition: "type Query { hello: String }",
});
const srcDs = new CfnDataSource(s, "SrcDs", {
  apiId: srcApi.attrApiId,
  name: "NoneDs",
  type: "NONE",
});
srcDs.addDependency(srcSchema);

const mergeRole = new Role(s, "MergeRole", {
  assumedBy: new ServicePrincipal("appsync.amazonaws.com"),
  inlinePolicies: {
    merge: new PolicyDocument({
      statements: [
        new PolicyStatement({
          actions: ["appsync:SourceGraphQL", "appsync:StartSchemaMerge"],
          resources: [`${srcApi.attrArn}/*`, srcApi.attrArn],
        }),
      ],
    }),
  },
});
const mergedApi = new CfnGraphQLApi(s, "MergedApi", {
  name: "cdkrd-hunt-0811-merged",
  authenticationType: "API_KEY",
  apiType: "MERGED",
  mergedApiExecutionRoleArn: mergeRole.roleArn,
});
const assoc = new CfnSourceApiAssociation(s, "SrcAssoc", {
  mergedApiIdentifier: mergedApi.attrApiId,
  sourceApiIdentifier: srcApi.attrApiId,
});
assoc.node.addDependency(srcSchema);

// --- RDS GlobalCluster headless barest ---
const gc = new CfnGlobalCluster(s, "HeadlessGc", {
  globalClusterIdentifier: "cdkrd-hunt-0811-gc",
  engine: "aurora-postgresql",
});
gc.applyRemovalPolicy(RemovalPolicy.DESTROY);

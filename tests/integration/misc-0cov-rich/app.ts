// CDK app for the cdk-real-drift misc-0cov-rich false-positive integration test.
// A grab bag of cheap, fast, zero-coverage common types:
// - AWS::EC2::KeyPair (imported PublicKeyMaterial is writeOnly — import so AWS
//   stores NO private key in SSM Parameter Store, nothing to orphan)
// - AWS::RAM::ResourceShare (org/multi-account staple)
// - AWS::FIS::ExperimentTemplate (Actions/Targets are free-form MAPS keyed by
//   user-chosen names — a map-shape probe; aws:fis:wait needs no real targets)
// - AWS::VerifiedPermissions::PolicyStore (Schema.CedarJson is a JSON-STRING
//   prop — the object<->string normalization FP class)
// - AWS::Cassandra::Keyspace + Table (Table has a COMPOSITE primaryIdentifier
//   KeyspaceName|TableName — a CC_IDENTIFIER_ADAPTERS read-gap probe)
// - AWS::EMRServerless::Application (no InitialCapacity, so zero idle cost)
// A clean `record`->`check` is the FP oracle.
import { App, Stack } from "aws-cdk-lib";
import { CfnKeyspace, CfnTable } from "aws-cdk-lib/aws-cassandra";
import { CfnKeyPair } from "aws-cdk-lib/aws-ec2";
import { CfnApplication } from "aws-cdk-lib/aws-emrserverless";
import { CfnExperimentTemplate } from "aws-cdk-lib/aws-fis";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnResourceShare } from "aws-cdk-lib/aws-ram";
import { CfnPolicyStore } from "aws-cdk-lib/aws-verifiedpermissions";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegMisc0CovRich");

new CfnKeyPair(stack, "HuntKeyPair", {
  keyName: "cdkrd-hunt-keypair",
  keyType: "ed25519",
  publicKeyMaterial:
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJPRfhD3vb5rmS6P4rVU65OFl8aLIHppMwCNy0+r49tT cdkrd-hunt",
});

new CfnResourceShare(stack, "HuntShare", {
  name: "cdkrd-hunt-share",
  allowExternalPrincipals: false,
});

const fisRole = new Role(stack, "FisRole", {
  assumedBy: new ServicePrincipal("fis.amazonaws.com"),
});

new CfnExperimentTemplate(stack, "HuntExperiment", {
  description: "cdkrd hunt wait-only experiment",
  roleArn: fisRole.roleArn,
  stopConditions: [{ source: "none" }],
  targets: {},
  actions: {
    justWait: {
      actionId: "aws:fis:wait",
      parameters: { duration: "PT1M" },
    },
  },
  tags: { Name: "cdkrd-hunt-experiment" },
});

new CfnPolicyStore(stack, "HuntPolicyStore", {
  description: "cdkrd hunt policy store",
  validationSettings: { mode: "STRICT" },
  schema: {
    cedarJson: JSON.stringify({
      CdkrdHunt: {
        entityTypes: {
          User: { shape: { type: "Record", attributes: {} } },
          Doc: { shape: { type: "Record", attributes: {} } },
        },
        actions: {
          view: {
            appliesTo: { principalTypes: ["User"], resourceTypes: ["Doc"] },
          },
        },
      },
    }),
  },
});

const keyspace = new CfnKeyspace(stack, "HuntKeyspace", {
  keyspaceName: "cdkrd_hunt_ks",
});

const table = new CfnTable(stack, "HuntTable", {
  keyspaceName: keyspace.keyspaceName as string,
  tableName: "hunt_table",
  partitionKeyColumns: [{ columnName: "id", columnType: "text" }],
  clusteringKeyColumns: [
    { column: { columnName: "sk", columnType: "int" }, orderBy: "ASC" },
  ],
  regularColumns: [{ columnName: "payload", columnType: "text" }],
  billingMode: { mode: "ON_DEMAND" },
  pointInTimeRecoveryEnabled: false,
  defaultTimeToLive: 0,
});
table.addDependency(keyspace);

new CfnApplication(stack, "HuntEmrApp", {
  name: "cdkrd-hunt-emrsl",
  releaseLabel: "emr-7.0.0",
  type: "SPARK",
  autoStartConfiguration: { enabled: true },
  autoStopConfiguration: { enabled: true, idleTimeoutMinutes: 5 },
  maximumCapacity: { cpu: "4 vCPU", memory: "16 GB" },
});

app.synth();

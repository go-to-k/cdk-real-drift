// Barest-form first-run FP probe (2026-08-11 hunt): common CC-readable types whose
// undeclared-default surface has never been deployed barest — every existing
// corpus case DECLARES the axis props these leave open (audit evidence per type):
// Stack A (no cross-resource deps):
// - ElastiCache::ServerlessCache engine=redis, name only (the one corpus case is
//   valkey with MajorEngineVersion declared; MajorEngineVersion/FullEngineVersion/
//   CacheUsageLimits/default-VPC subnet+SG echoes all unprobed)
// - Transfer::Server with ZERO properties (corpus declares EndpointType/
//   IdentityProviderType/Protocols — the undeclared SFTP/SERVICE_MANAGED/PUBLIC
//   defaults are unprobed)
// - CloudTrail::EventDataStore was in the pack but is CLOSED to new customers
//   ("CloudTrail Lake is no longer accepting new customers", live CREATE_FAILED
//   2026-08-11) — it joins the dead-service exclusion list (QLDB / CodeCommit /
//   S3ObjectLambda / Cognito Sync class), not the fixture.
// - Batch::JobDefinition Type=multinode (both corpus cases are Type=container —
//   the NodeProperties union branch is unread)
// - SSM::Document DocumentType=Automation (both corpus cases are Command)
// - Cognito::UserPoolIdentityProvider ProviderType=SAML with inline metadata
//   (corpus has only Google; SAML enriches ProviderDetails with computed
//   SSORedirectBindingURI/SLORedirectBindingURI/ActiveEncryptionCertificate)
// Stack B (dependency types):
// - EFS::AccessPoint barest, FileSystemId only (corpus case declares
//   RootDirectory; the materialized RootDirectory {Path:"/"} default is unprobed)
// - SNS::Subscription Protocol=firehose (corpus protocols: email/sqs/lambda only)
// - KMS::ReplicaKey (zero coverage; primary MRK is CLI-created in us-west-2 by
//   verify.sh and threaded in via -c primaryKeyArn=...; the resource is skipped
//   when the context is absent so a bare synth still works)
// - SNS::Topic with an INLINE `Subscription` property (raw-CFn/L1 shape): the
//   SNS child enumerator builds its declared-set from AWS::SNS::Subscription
//   resources only, so an inline-declared subscription is suspected to false-flag
//   as `added` (the #1729 twin-declaration-shape class) — live probe.
import { App, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { CfnJobDefinition } from "aws-cdk-lib/aws-batch";
import { CfnUserPool, CfnUserPoolIdentityProvider } from "aws-cdk-lib/aws-cognito";
import { CfnAccessPoint, CfnFileSystem } from "aws-cdk-lib/aws-efs";
import { CfnServerlessCache } from "aws-cdk-lib/aws-elasticache";
import { CfnDeliveryStream } from "aws-cdk-lib/aws-kinesisfirehose";
import { CfnReplicaKey } from "aws-cdk-lib/aws-kms";
import { PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { CfnSubscription, CfnTopic } from "aws-cdk-lib/aws-sns";
import { CfnQueue, CfnQueuePolicy } from "aws-cdk-lib/aws-sqs";
import { CfnDocument } from "aws-cdk-lib/aws-ssm";
import { CfnServer } from "aws-cdk-lib/aws-transfer";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
// `-c rev=2` threads a neutral tag update through every resource — the
// post-update echo probe (redeploy with rev=2, re-check; see hunt-bugs skill).
const rev = app.node.tryGetContext("rev");
if (rev) Tags.of(app).add("cdkrd:rev", String(rev));

// ---------------------------------------------------------------- stack A
const a = new Stack(app, "CdkrdHunt0811BarestA");

new CfnServerlessCache(a, "RedisServerless", {
  engine: "redis",
  serverlessCacheName: "cdkrd-hunt-0811-redis",
  // SubnetIds/SecurityGroupIds deliberately undeclared → default VPC + default SG
  // echoes probe the DEFAULT_SG/SUBNET_LIST gates on this type.
});

new CfnServer(a, "TransferBarest", {});

new CfnJobDefinition(a, "MultinodeJd", {
  type: "multinode",
  jobDefinitionName: "cdkrd-hunt-0811-multinode",
  nodeProperties: {
    mainNode: 0,
    numNodes: 2,
    nodeRangeProperties: [
      {
        targetNodes: "0:",
        container: {
          image: "public.ecr.aws/amazonlinux/amazonlinux:latest",
          resourceRequirements: [
            { type: "VCPU", value: "1" },
            { type: "MEMORY", value: "1024" },
          ],
        },
      },
    ],
  },
});

new CfnDocument(a, "AutomationDoc", {
  documentType: "Automation",
  content: {
    schemaVersion: "0.3",
    mainSteps: [{ name: "sleep", action: "aws:sleep", inputs: { Duration: "PT5S" } }],
  },
});

const pool = new CfnUserPool(a, "IdpPool", {
  userPoolName: "cdkrd-hunt-0811-idp-pool",
});
// Throwaway self-signed cert (public half only; key discarded at generation) —
// Cognito requires valid IDPSSODescriptor metadata with a signing cert.
const samlCert =
  "MIIDEzCCAfugAwIBAgIUd23PixfCQqbN8bNqptEqE+9GNsMwDQYJKoZIhvcNAQELBQAwGTEXMBUGA1UEAwwOY2RrcmQtaHVudC1pZHAwHhcNMjYwODEwMTc1ODI0WhcNMjYwOTA5MTc1ODI0WjAZMRcwFQYDVQQDDA5jZGtyZC1odW50LWlkcDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMIRGjNNMo4aLwcGxCPEbN2GOpNel9TyHo1BsRax9FIZApdSa22mXs9o2UObdqYuVfvSMC83sxTDLxqTiYTy672yS7JLaVhOHUdi8dONyCMf2W9CPmg49iLEq5285It4LzYoKVgAWkk4qF6BHTHn2WU9j1pVJb+nte078L3CPqwC0208RSbsVSTrn3QSVcloaZNOKP+p045444mWKt9hc4Kn0nM73BZRhqNL/Mkgy6zptY4FFKtw2593rvnmOoM2O5dXrL2hG/DGSPAIWRjAFNZYctikC2ldPloxR7sfe5E3L2ELl5NXLbnpShSBThsuIpD7FHerqwq6LF7ptEPY1xMCAwEAAaNTMFEwHQYDVR0OBBYEFHWmzjhTgKum0G+1bvI57hKw5I/sMB8GA1UdIwQYMBaAFHWmzjhTgKum0G+1bvI57hKw5I/sMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBABoJmw5e2ptW0s3jjLJbr4VnIrbFQ5ieSemHC8VhujphYv7vPr5iLnqkM1QZrjRGWXDAB9PSIAZVPTw3S67AAIK6KRJxFdYr8xnKChsjzdjhqW3fkxRVefMP3Nxn8fx6rO9Hf50hXsU8Gbmzrh77uLECH+DI/KpiSui8wvZikNsbQ1WyEneP0yakj/C7VDmHHFP5FKHeHGh04eVygxPf89ctWHe9okm3KDbSkRmQMnwpLKF2Tvk1J5KIZFvkR6y+w8nh81N702lh1in/BSbXFp8aiGO1liQJTy4Duf3X6PrZOMwF30HrvYeACALjtwxt8tZL4epW2KsHVsozEJxrm38=";
const samlMetadata = [
  '<?xml version="1.0"?>',
  '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="urn:cdkrd-hunt-0811-idp">',
  '<md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">',
  '<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">',
  `<ds:X509Data><ds:X509Certificate>${samlCert}</ds:X509Certificate></ds:X509Data>`,
  "</ds:KeyInfo></md:KeyDescriptor>",
  '<md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>',
  '<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://example.com/sso"/>',
  "</md:IDPSSODescriptor></md:EntityDescriptor>",
].join("");

new CfnUserPoolIdentityProvider(a, "SamlIdp", {
  userPoolId: pool.ref,
  providerName: "cdkrd-hunt-saml",
  providerType: "SAML",
  providerDetails: { MetadataFile: samlMetadata },
});

// ---------------------------------------------------------------- stack B
const b = new Stack(app, "CdkrdHunt0811BarestB");

const efsFs = new CfnFileSystem(b, "Fs", {});
efsFs.applyRemovalPolicy(RemovalPolicy.DESTROY);

// EFS AccessPoint barest: FileSystemId only — probes the materialized
// RootDirectory {Path:"/"} (and any PosixUser/ClientToken echoes) undeclared.
new CfnAccessPoint(b, "Ap", { fileSystemId: efsFs.ref });

const topic = new CfnTopic(b, "Topic", { topicName: "cdkrd-hunt-0811-topic" });

// Inline-subscription topic (the #1729-class probe): the subscription is declared
// INSIDE the Topic resource, not as an AWS::SNS::Subscription sibling.
const inlineQ = new CfnQueue(b, "InlineQ", { queueName: "cdkrd-hunt-0811-inlineq" });
const inlineTopic = new CfnTopic(b, "InlineSubTopic", {
  topicName: "cdkrd-hunt-0811-inline",
  subscription: [{ protocol: "sqs", endpoint: inlineQ.attrArn }],
});
new CfnQueuePolicy(b, "InlineQPolicy", {
  queues: [inlineQ.ref],
  policyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "sns.amazonaws.com" },
        Action: "sqs:SendMessage",
        Resource: inlineQ.attrArn,
        Condition: { ArnEquals: { "aws:SourceArn": inlineTopic.ref } },
      },
    ],
  },
});

const fhBucket = new Bucket(b, "FhBucket", {
  removalPolicy: RemovalPolicy.DESTROY,
});

const fhRole = new Role(b, "FhRole", {
  assumedBy: new ServicePrincipal("firehose.amazonaws.com"),
  inlinePolicies: {
    s3: new PolicyDocument({
      statements: [
        new PolicyStatement({
          actions: ["s3:AbortMultipartUpload", "s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:PutObject"],
          resources: [fhBucket.bucketArn, `${fhBucket.bucketArn}/*`],
        }),
      ],
    }),
  },
});

const fh = new CfnDeliveryStream(b, "Firehose", {
  deliveryStreamName: "cdkrd-hunt-0811-fh",
  s3DestinationConfiguration: {
    bucketArn: fhBucket.bucketArn,
    roleArn: fhRole.roleArn,
  },
});
fh.node.addDependency(fhRole);

const snsSubRole = new Role(b, "SnsSubRole", {
  assumedBy: new ServicePrincipal("sns.amazonaws.com"),
  inlinePolicies: {
    fh: new PolicyDocument({
      statements: [
        new PolicyStatement({
          actions: ["firehose:DescribeDeliveryStream", "firehose:ListDeliveryStreams", "firehose:ListTagsForDeliveryStream", "firehose:PutRecord", "firehose:PutRecordBatch"],
          resources: [fh.attrArn],
        }),
      ],
    }),
  },
});

new CfnSubscription(b, "FhSub", {
  topicArn: topic.ref,
  protocol: "firehose",
  endpoint: fh.attrArn,
  subscriptionRoleArn: snsSubRole.roleArn,
});

const primaryKeyArn = app.node.tryGetContext("primaryKeyArn");
if (primaryKeyArn) {
  const rk = new CfnReplicaKey(b, "ReplicaKey", {
    primaryKeyArn,
    keyPolicy: {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "root",
          Effect: "Allow",
          Principal: { AWS: `arn:aws:iam::${b.account}:root` },
          Action: "kms:*",
          Resource: "*",
        },
      ],
    },
  });
  rk.applyRemovalPolicy(RemovalPolicy.DESTROY);
}

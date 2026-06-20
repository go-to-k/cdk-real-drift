// CDK app for the cdk-real-drift richly-configured Glue job false-positive test.
// Glue jobs are a daily driver for every data / ETL team, yet existing coverage is
// only the harvest snapshot corpus — never a deploy-verified FP integ. The headline
// hunting ground here is DefaultArguments: a FREE-FORM string->string map (arbitrary
// user keys like "--enable-metrics", "--job-bookmark-option") — exactly the
// free-form-map class where cdkrd has historically re-serialized / reordered values
// and produced false positives. It also exercises Command (nested {Name,
// ScriptLocation, PythonVersion}), ExecutionProperty (MaxConcurrentRuns), a Role
// intrinsic ref, GlueVersion / WorkerType / NumberOfWorkers / Timeout / MaxRetries
// scalars, and Tags. A freshly deployed + recorded job with NO out-of-band change
// MUST report CLEAN — most importantly the DefaultArguments map must round-trip
// verbatim.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnJob } from "aws-cdk-lib/aws-glue";
import { Role, ServicePrincipal, ManagedPolicy } from "aws-cdk-lib/aws-iam";
import { Bucket } from "aws-cdk-lib/aws-s3";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegGlueRich");

const scripts = new Bucket(stack, "Scripts", {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

const role = new Role(stack, "GlueRole", {
  assumedBy: new ServicePrincipal("glue.amazonaws.com"),
  managedPolicies: [
    ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSGlueServiceRole"),
  ],
});

new CfnJob(stack, "Job", {
  name: "cdkrd-integ-glue-rich",
  role: role.roleArn,
  glueVersion: "4.0",
  workerType: "G.1X",
  numberOfWorkers: 2,
  timeout: 10,
  maxRetries: 1,
  description: "cdkrd glue-rich test job",
  command: {
    name: "glueetl",
    pythonVersion: "3",
    scriptLocation: scripts.s3UrlForObject("scripts/etl.py"),
  },
  executionProperty: { maxConcurrentRuns: 1 },
  // Free-form string->string map with arbitrary user keys: the FP hunting ground.
  defaultArguments: {
    "--job-language": "python",
    "--enable-metrics": "true",
    "--enable-continuous-cloudwatch-log": "true",
    "--job-bookmark-option": "job-bookmark-enable",
    "--TempDir": scripts.s3UrlForObject("tmp/"),
  },
  tags: { team: "platform", "cost-center": "1234" },
});

app.synth();

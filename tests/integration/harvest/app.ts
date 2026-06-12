// Corpus-harvest fixture (R71): one stack of CHEAP, FAST-create/delete resource
// types the corpus had never seen live. Purpose: every `check` against it is a
// golden-corpus recording session (CDKRD_CORPUS_DIR), converting one AWS round
// trip into permanent offline regression coverage per type — and a fresh deploy
// must classify with ZERO declared drift across all of them (an FP test in
// itself). Everything here is free or fractions of a cent for the minutes the
// stack lives; nothing lingers after destroy.
import { App, Aws, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnApi } from "aws-cdk-lib/aws-apigatewayv2";
import { MockIntegration, PassthroughBehavior, RestApi } from "aws-cdk-lib/aws-apigateway";
import { CfnWorkGroup } from "aws-cdk-lib/aws-athena";
import { Alarm, ComparisonOperator, Dashboard, Metric, TextWidget } from "aws-cdk-lib/aws-cloudwatch";
import { BuildSpec, Project } from "aws-cdk-lib/aws-codebuild";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { CfnEIP } from "aws-cdk-lib/aws-ec2";
import { Repository } from "aws-cdk-lib/aws-ecr";
import { EventBus, Rule, Schedule } from "aws-cdk-lib/aws-events";
import { CfnDatabase, CfnTable } from "aws-cdk-lib/aws-glue";
import { User } from "aws-cdk-lib/aws-iam";
import { FilterPattern, LogGroup, MetricFilter, RetentionDays } from "aws-cdk-lib/aws-logs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Activity, Pass, StateMachine } from "aws-cdk-lib/aws-stepfunctions";

const app = new App();
const stack = new Stack(app, "CdkrdIntegHarvest");

new Table(stack, "Sessions", {
  partitionKey: { name: "pk", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  removalPolicy: RemovalPolicy.DESTROY,
});

new EventBus(stack, "Bus");
new Rule(stack, "Tick", {
  schedule: Schedule.rate(Duration.hours(1)),
  enabled: false,
});

new StateMachine(stack, "Flow", { definition: new Pass(stack, "Noop") });
new Activity(stack, "Act");

new CfnWorkGroup(stack, "Queries", {
  name: "cdkrd-harvest",
  recursiveDeleteOption: true,
});

const metric = new Metric({ namespace: "CdkrdHarvest", metricName: "Pulse" });
new Alarm(stack, "Pulse", {
  metric,
  threshold: 1,
  evaluationPeriods: 1,
  comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
});
new Dashboard(stack, "Board", {
  widgets: [[new TextWidget({ markdown: "# cdkrd harvest" })]],
});

const logs = new LogGroup(stack, "AppLogs", {
  retention: RetentionDays.ONE_DAY,
  removalPolicy: RemovalPolicy.DESTROY,
});
new MetricFilter(stack, "Errors", {
  logGroup: logs,
  filterPattern: FilterPattern.literal("ERROR"),
  metricNamespace: "CdkrdHarvest",
  metricName: "Errors",
});

new Repository(stack, "Images", {
  removalPolicy: RemovalPolicy.DESTROY,
  emptyOnDelete: true,
});

new StringParameter(stack, "Flag", { stringValue: "harvest" });

new CfnApi(stack, "HttpApi", { name: "cdkrd-harvest-http", protocolType: "HTTP" });
const rest = new RestApi(stack, "RestApi", { deploy: true });
rest.root.addMethod(
  "GET",
  new MockIntegration({
    integrationResponses: [{ statusCode: "200" }],
    passthroughBehavior: PassthroughBehavior.NEVER,
    requestTemplates: { "application/json": '{"statusCode": 200}' },
  }),
  { methodResponses: [{ statusCode: "200" }] }
);

new Project(stack, "Build", {
  buildSpec: BuildSpec.fromObject({
    version: "0.2",
    phases: { build: { commands: ["echo harvest"] } },
  }),
});

new User(stack, "Auditor", { path: "/cdkrd-harvest/" });

new CfnEIP(stack, "Ip", { domain: "vpc" });

new CfnDatabase(stack, "Catalog", {
  catalogId: Aws.ACCOUNT_ID,
  databaseInput: { name: "cdkrd_harvest_db" },
});
new CfnTable(stack, "Events", {
  catalogId: Aws.ACCOUNT_ID,
  databaseName: "cdkrd_harvest_db",
  tableInput: {
    name: "cdkrd_harvest_events",
    parameters: { classification: "json" },
    storageDescriptor: {
      columns: [{ name: "id", type: "string" }],
      location: "s3://cdkrd-harvest-placeholder/",
    },
  },
}).addDependency(stack.node.findChild("Catalog") as CfnDatabase);

app.synth();

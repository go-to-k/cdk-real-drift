// CDK app for the cdk-real-drift Application Auto Scaling false-positive test.
// DynamoDB read/write auto scaling is one of the most commonly deployed CDK
// patterns: a PROVISIONED table with target-tracking scaling on both read and
// write capacity. This emits two AWS::ApplicationAutoScaling::ScalableTarget and
// two AWS::ApplicationAutoScaling::ScalingPolicy resources, each carrying nested
// target-tracking config (PredefinedMetricSpecification, cooldowns) whose
// defaults are exactly the kind cdkrd must fold without raising a false positive.
// A freshly deployed + recorded stack with NO out-of-band change MUST be CLEAN.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAutoScaleRich");

const table = new Table(stack, "Table", {
  partitionKey: { name: "pk", type: AttributeType.STRING },
  billingMode: BillingMode.PROVISIONED,
  readCapacity: 5,
  writeCapacity: 5,
  removalPolicy: RemovalPolicy.DESTROY,
});

const readScaling = table.autoScaleReadCapacity({ minCapacity: 5, maxCapacity: 50 });
readScaling.scaleOnUtilization({ targetUtilizationPercent: 70 });

const writeScaling = table.autoScaleWriteCapacity({ minCapacity: 5, maxCapacity: 50 });
writeScaling.scaleOnUtilization({ targetUtilizationPercent: 70 });

app.synth();

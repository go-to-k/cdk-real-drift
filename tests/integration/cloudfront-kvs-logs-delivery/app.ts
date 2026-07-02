// CDK app for the cdk-real-drift CloudFront KeyValueStore + vended-logs-v2
// false-positive test. Two 0-coverage families ride one distribution:
// - AWS::CloudFront::KeyValueStore, associated to a cloudfront-js-2.0 Function
//   (the Function type is covered; the KVS + its association are not).
// - The CloudWatch Logs vended-logs v2 delivery triple (AWS::Logs::DeliverySource
//   / DeliveryDestination / Delivery) wiring CloudFront access logs into a log
//   group — an increasingly common replacement for legacy S3 access logs.
// A freshly deployed + recorded stack with NO out-of-band change MUST report
// CLEAN; any drift here is a normalization / default-folding FP on these shapes.
import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  Distribution,
  Function as CfFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  KeyValueStore,
  PriceClass,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import {
  CfnDelivery,
  CfnDeliveryDestination,
  CfnDeliverySource,
  LogGroup,
  RetentionDays,
} from "aws-cdk-lib/aws-logs";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegCfKvsLogsDel");

const kvs = new KeyValueStore(stack, "Kvs", {
  keyValueStoreName: "cdkrd-hunt-kvs",
  comment: "cdkrd hunt fixture key-value store",
});

const fn = new CfFunction(stack, "Fn", {
  functionName: "cdkrd-hunt-kvs-fn",
  runtime: FunctionRuntime.JS_2_0,
  keyValueStore: kvs,
  comment: "cdkrd hunt fixture function with a KVS association",
  code: FunctionCode.fromInline(
    "function handler(event) { return event.request; }",
  ),
});

const distribution = new Distribution(stack, "Dist", {
  comment: "cdkrd hunt fixture distribution (KVS + vended access logs)",
  priceClass: PriceClass.PRICE_CLASS_100,
  defaultBehavior: {
    origin: new HttpOrigin("example.com"),
    functionAssociations: [
      { function: fn, eventType: FunctionEventType.VIEWER_REQUEST },
    ],
  },
});

const logGroup = new LogGroup(stack, "AccessLogs", {
  retention: RetentionDays.ONE_WEEK,
  removalPolicy: RemovalPolicy.DESTROY,
});

// CloudFront standard logging v2: distribution ARN as the delivery source.
const source = new CfnDeliverySource(stack, "DeliverySource", {
  name: "cdkrd-hunt-cf-access",
  logType: "ACCESS_LOGS",
  resourceArn: `arn:aws:cloudfront::${stack.account}:distribution/${distribution.distributionId}`,
});

const destination = new CfnDeliveryDestination(stack, "DeliveryDest", {
  name: "cdkrd-hunt-cf-dest",
  outputFormat: "json",
  destinationResourceArn: logGroup.logGroupArn,
});

const delivery = new CfnDelivery(stack, "Delivery", {
  deliverySourceName: source.name,
  deliveryDestinationArn: destination.attrArn,
});
delivery.addDependency(source);

app.synth();

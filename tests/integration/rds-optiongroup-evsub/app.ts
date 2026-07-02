// CDK app for the cdk-real-drift rds-optiongroup-evsub false-positive
// integration test. Zero-corpus-coverage RDS admin staples (no DB instance —
// both are free/fast):
// - AWS::RDS::OptionGroup — MariaDB audit plugin with OptionSettings; the
//   SERVER_AUDIT_EVENTS value is a comma-joined set ("CONNECT,QUERY") the
//   service may reorder, and AWS fills every unset option setting (undeclared
//   fill probe).
// - AWS::RDS::EventSubscription — EventCategories declared NON-sorted as a
//   set-like reorder probe; Enabled=true is the mutable FN/revert target
//   (verify-detect.sh toggles it off out of band).
import { App, Stack } from "aws-cdk-lib";
import { CfnEventSubscription, CfnOptionGroup } from "aws-cdk-lib/aws-rds";
import { Topic } from "aws-cdk-lib/aws-sns";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegRdsOptEvsub");

new CfnOptionGroup(stack, "HuntOptionGroup", {
  engineName: "mariadb",
  majorEngineVersion: "10.11",
  optionGroupDescription: "cdkrd hunt mariadb audit option group",
  optionConfigurations: [
    {
      optionName: "MARIADB_AUDIT_PLUGIN",
      optionSettings: [
        { name: "SERVER_AUDIT_EVENTS", value: "CONNECT,QUERY" },
        { name: "SERVER_AUDIT_QUERY_LOG_LIMIT", value: "2048" },
      ],
    },
  ],
  tags: [{ key: "Name", value: "cdkrd-hunt-og" }],
});

const topic = new Topic(stack, "HuntEventTopic", {
  topicName: "cdkrd-hunt-rds-events",
});

new CfnEventSubscription(stack, "HuntEventSub", {
  snsTopicArn: topic.topicArn,
  sourceType: "db-instance",
  eventCategories: ["maintenance", "failure", "availability"],
  enabled: true,
  subscriptionName: "cdkrd-hunt-evsub",
});

app.synth();

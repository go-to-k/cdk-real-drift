// 2026-08-10 hunt: AmazonMQ Broker EngineType=RABBITMQ — the classify.ts
// engineStorageDefault RABBITMQ row ('EBS') is a doc-derived MIRRORED row with
// no live citation (the one corpus broker is ACTIVEMQ). Beyond StorageType,
// RabbitMQ echoes a different Logging shape (no Audit log), a different
// endpoint family (Amqp only), and possibly different AuthenticationStrategy /
// EncryptionOptions echoes — none engine-gated today.
// First `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnBroker } from "aws-cdk-lib/aws-amazonmq";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkrdHunt0810Mq");

// engine-axis validation difference (live, 2026-08-10): RabbitMQ REJECTS
// mq.t3.micro ("does not support host instance type") while ActiveMQ accepts it
// — new RabbitMQ brokers need the m5+ family.
new CfnBroker(stack, "Broker", {
  brokerName: "cdkrd-0810-rabbit",
  engineType: "RABBITMQ",
  hostInstanceType: "mq.m5.large",
  deploymentMode: "SINGLE_INSTANCE",
  publiclyAccessible: true,
  autoMinorVersionUpgrade: true,
  users: [{ username: "cdkrdhunt", password: "cdkrd-hunt-0810-pw!A1" }],
});

app.synth();

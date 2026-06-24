// cdk-real-drift AmazonMQ Broker EngineVersion read-gap RULE-OUT test.
// Amazon MQ (ActiveMQ >= 5.18) DOES expand a partial declared EngineVersion ("5.18") to
// a concrete patch version, which looked like a version-prefix false-positive candidate.
// But cdkrd does NOT false-drift: AWS::AmazonMQ::Broker's EngineVersion is WRITE-ONLY in
// the CFn schema, so cdkrd strips it from the compare and reports it honestly as a
// `readGap` ("write-only — cannot be read back"); the live model exposes the concrete
// version under the separate READ-ONLY `EngineVersionCurrent` attribute instead. So there
// is no FP to fold — EngineVersion is never compared. This fixture pins that rule-out: a
// freshly deployed + recorded broker MUST be CLEAN (EngineVersion/Users are readGaps).
import { App, Stack } from "aws-cdk-lib";
import { CfnBroker } from "aws-cdk-lib/aws-amazonmq";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAmazonMqVersionReadGap");

new CfnBroker(stack, "Broker", {
  brokerName: "cdkrd-mq-version",
  engineType: "ACTIVEMQ",
  engineVersion: "5.18", // declared PARTIAL; Amazon MQ reads it back as "5.18.4"
  hostInstanceType: "mq.t3.micro",
  deploymentMode: "SINGLE_INSTANCE",
  publiclyAccessible: true,
  autoMinorVersionUpgrade: true,
  users: [{ username: "cdkrdadmin", password: "CdkrdTestPassword123" }],
});

app.synth();

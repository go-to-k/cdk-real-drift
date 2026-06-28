// CDK app for the cdk-real-drift Events EventBusPolicy read-gap (false-negative)
// integration test. AWS::Events::EventBusPolicy has a COMPOSITE primaryIdentifier
// [EventBusName, StatementId] but the CFn physical id (Ref) is only the child
// StatementId, so a bare Cloud Control GetResource is rejected and the policy is
// silently `skipped` — an out-of-band change to who may PutEvents is then INVISIBLE
// (a missed detection). This fixture confirms the gap and pins the fix.
import { App, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnEventBus, CfnEventBusPolicy } from 'aws-cdk-lib/aws-events';
import type { Construct } from 'constructs';

class EventBusPolicyStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const bus = new CfnEventBus(this, 'Bus', { name: `${id}-bus` });

    new CfnEventBusPolicy(this, 'BusPolicy', {
      eventBusName: bus.name,
      statementId: 'AllowSelfPutEvents',
      statement: {
        Sid: 'AllowSelfPutEvents',
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${Stack.of(this).account}:root` },
        Action: 'events:PutEvents',
        Resource: bus.attrArn,
      },
    });
  }
}

const app = new App();
new EventBusPolicyStack(app, 'CdkRealDriftIntegEventBusPolicyReadgap', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

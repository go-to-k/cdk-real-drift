// CDK app for the cdk-real-drift DynamoDB GlobalTable Replicas set-reorder
// false-positive integration test. A multi-region global table declares its
// `Replicas` (an `insertionOrder:false` object array keyed by Region — not in
// IDENTITY_FIELDS) NON-sorted (us-west-2 before the us-east-1 home region); if
// Cloud Control echoes the set sorted by Region, a freshly recorded clean stack
// false-positives as declared drift.
import { App, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnGlobalTable } from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';

class DdbGlobalTableReplicasStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    new CfnGlobalTable(this, 'GT', {
      attributeDefinitions: [{ attributeName: 'pk', attributeType: 'S' }],
      keySchema: [{ attributeName: 'pk', keyType: 'HASH' }],
      billingMode: 'PAY_PER_REQUEST',
      streamSpecification: { streamViewType: 'NEW_AND_OLD_IMAGES' },
      // Replicas declared us-west-2 before us-east-1 (non-sorted by Region). The
      // home region (us-east-1) MUST be present in the list.
      replicas: [{ region: 'us-west-2' }, { region: 'us-east-1' }],
    });
  }
}

const app = new App();
new DdbGlobalTableReplicasStack(app, 'CdkRealDriftIntegDdbGlobalTableReplicas', {
  env: { region: 'us-east-1' },
});

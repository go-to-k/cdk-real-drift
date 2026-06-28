// CDK app for the cdk-real-drift ECS Service ServiceConnect writeOnly-read-gap test.
//
// AWS::ECS::Service `ServiceConnectConfiguration` is `writeOnlyProperties` — Cloud
// Control echoes the service's other props but never the ServiceConnect config (it
// lives on the active deployment). The SDK_SUPPLEMENTS reader reconstructs it from
// DescribeServices' PRIMARY deployment.
//
// desiredCount 0 so no tasks run (no image pull / NAT needed) — the config is still
// stored on the service and its deployment.
import { App, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Vpc, SubnetType } from 'aws-cdk-lib/aws-ec2';
import {
  Cluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
} from 'aws-cdk-lib/aws-ecs';
import { PrivateDnsNamespace } from 'aws-cdk-lib/aws-servicediscovery';
import type { Construct } from 'constructs';

class EcsServiceConnectStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
    });
    const namespace = new PrivateDnsNamespace(this, 'Ns', { name: 'cdkrd-sc.internal', vpc });
    const cluster = new Cluster(this, 'Cluster', { vpc });

    const taskDef = new FargateTaskDefinition(this, 'Task', { cpu: 256, memoryLimitMiB: 512 });
    taskDef.addContainer('app', {
      image: ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox:latest'),
      portMappings: [{ name: 'api', containerPort: 8080 }],
    });

    const svc = new FargateService(this, 'Svc', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 0,
      serviceConnectConfiguration: {
        namespace: namespace.namespaceArn,
        services: [{ portMappingName: 'api', dnsName: 'api', port: 8080 }],
      },
    });
    svc.applyRemovalPolicy(RemovalPolicy.DESTROY);
  }
}

const app = new App();
new EcsServiceConnectStack(app, 'CdkRealDriftIntegEcsServiceConnectReadgap', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

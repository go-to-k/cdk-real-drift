// CDK app for the cdk-real-drift apprunner-service-rich false-positive integration test.
// AWS App Runner (AWS::AppRunner::Service) is a common way to run a container without
// managing infrastructure. A service folds a very large set of AWS-assigned first-run
// defaults the template never declares — HealthCheckConfiguration (Protocol/Path/
// Interval/Timeout/HealthyThreshold/UnhealthyThreshold), NetworkConfiguration
// (Egress DEFAULT, Ingress IsPubliclyAccessible, IpAddressType), the default
// AutoScalingConfigurationArn, ServiceUrl/ServiceId/Status, and ImageConfiguration
// echoes. A clean `record`->`check` (and a `check` BEFORE record) is a strong
// false-positive oracle for those undeclared first-run defaults.
//
// Uses a public ECR sample image so the fixture needs no image build or access role.
import { App, Stack } from "aws-cdk-lib";
import { CfnService } from "aws-cdk-lib/aws-apprunner";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegAppRunnerServiceRich");

new CfnService(stack, "Service", {
  serviceName: "cdkrd-apprunner-rich",
  sourceConfiguration: {
    autoDeploymentsEnabled: false,
    imageRepository: {
      imageIdentifier: "public.ecr.aws/aws-containers/hello-app-runner:latest",
      imageRepositoryType: "ECR_PUBLIC",
      imageConfiguration: {
        port: "8000",
      },
    },
  },
  instanceConfiguration: {
    cpu: "1024",
    memory: "2048",
  },
});

app.synth();

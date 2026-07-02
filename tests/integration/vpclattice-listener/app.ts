// CDK app for the cdk-real-drift vpclattice-listener false-positive
// integration test. The corpus covers VpcLattice Service + ServiceNetwork only;
// this exercises the zero-coverage rest of the family (all cheap):
// - AWS::VpcLattice::TargetGroup — LAMBDA type (config only carries
//   LambdaEventStructureVersion; AWS fills the rest — undeclared fill probe).
// - AWS::VpcLattice::Listener — HTTP:80 with a forward default action whose
//   weight is OMITTED (service fills a default weight).
// - AWS::VpcLattice::Rule — path-prefix match + forward action; Priority is
//   the mutable FN target.
// - AWS::VpcLattice::ServiceNetworkServiceAssociation.
import { App, Stack } from "aws-cdk-lib";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import {
  CfnListener,
  CfnRule,
  CfnService,
  CfnServiceNetwork,
  CfnServiceNetworkServiceAssociation,
  CfnTargetGroup,
} from "aws-cdk-lib/aws-vpclattice";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegLatticeListener");

const fn = new LambdaFunction(stack, "HuntTargetFn", {
  runtime: Runtime.NODEJS_22_X,
  handler: "index.handler",
  code: Code.fromInline(
    "exports.handler = async () => ({ statusCode: 200, body: 'ok' });",
  ),
});

const tg = new CfnTargetGroup(stack, "HuntLambdaTg", {
  name: "cdkrd-hunt-lambda-tg",
  type: "LAMBDA",
  targets: [{ id: fn.functionArn }],
  config: { lambdaEventStructureVersion: "V2" },
});

const svc = new CfnService(stack, "HuntService", {
  name: "cdkrd-hunt-svc",
  authType: "NONE",
});

const listener = new CfnListener(stack, "HuntListener", {
  serviceIdentifier: svc.attrId,
  name: "cdkrd-hunt-listener",
  protocol: "HTTP",
  port: 80,
  defaultAction: {
    forward: {
      targetGroups: [{ targetGroupIdentifier: tg.attrId }],
    },
  },
});

new CfnRule(stack, "HuntRule", {
  listenerIdentifier: listener.attrId,
  serviceIdentifier: svc.attrId,
  name: "cdkrd-hunt-rule",
  priority: 10,
  match: {
    httpMatch: {
      pathMatch: { match: { prefix: "/api" }, caseSensitive: false },
    },
  },
  action: {
    forward: {
      targetGroups: [{ targetGroupIdentifier: tg.attrId, weight: 1 }],
    },
  },
});

const sn = new CfnServiceNetwork(stack, "HuntServiceNetwork", {
  name: "cdkrd-hunt-sn",
  authType: "NONE",
});

new CfnServiceNetworkServiceAssociation(stack, "HuntSnSvcAssoc", {
  serviceNetworkIdentifier: sn.attrId,
  serviceIdentifier: svc.attrId,
});

app.synth();

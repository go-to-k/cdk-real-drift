// CDK app for the cdk-real-drift redshift-serverless-min false-positive
// integration test. BAREST-possible Redshift Serverless pair — the SDK
// supplement readers exist (overrides.ts) but have never been exercised by a
// live deploy or a corpus case:
// - AWS::RedshiftServerless::Namespace: only NamespaceName declared —
//   DbName / IamRoles / LogExports / admin defaults are AWS-assigned.
// - AWS::RedshiftServerless::Workgroup: only WorkgroupName + NamespaceName —
//   BaseCapacity (128 RPU) / ConfigParameters / EnhancedVpcRouting /
//   PubliclyAccessible / Port defaults are AWS-assigned.
// Serverless: no cost while idle. A first `check` must show ZERO
// [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnNamespace, CfnWorkgroup } from "aws-cdk-lib/aws-redshiftserverless";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegRedshiftSlMin");

const ns = new CfnNamespace(stack, "HuntNamespace", {
  namespaceName: "cdkrd-hunt-ns",
});

const wg = new CfnWorkgroup(stack, "HuntWorkgroup", {
  workgroupName: "cdkrd-hunt-wg",
  namespaceName: "cdkrd-hunt-ns",
});
wg.addDependency(ns);

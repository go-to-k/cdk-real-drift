// CDK app for the cdk-real-drift elasticache-paramgroup false-positive integ test.
//
// An AWS::ElastiCache::ParameterGroup is a daily-common resource (every custom Redis /
// Valkey / Memcached tuning declares one), yet its Cloud Control read returns the FULL
// EFFECTIVE parameter set — all ~60 engine defaults for the family PLUS the handful the
// template actually declares. cdkrd's CC-native read therefore surfaces every inherited
// default as an `undeclared` [Not Recorded] finding: a fresh, un-mutated group produced
// 61 first-run drift lines for a template that declared a single parameter. That is a
// textbook first-run FP (the sibling RDS/Redshift/Neptune parameter groups are already
// CLEAN because their read returns only the user-MODIFIED parameters).
//
// The fix is an SDK override reader that reads `Properties` from
// `describe-cache-parameters --source user` (the modified-only set), matching the
// modified-only shape RDS returns natively. This fixture declares two non-default
// parameters so a fresh record -> check is CLEAN and an out-of-band change to a declared
// parameter is still DETECTED (the source=user read returns any console-modified param).
// A ParameterGroup provisions nothing billable and is instant — no cache cluster needed.
import { App, Stack } from "aws-cdk-lib";
import { CfnParameterGroup } from "aws-cdk-lib/aws-elasticache";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegElasticacheParamGroup");

new CfnParameterGroup(stack, "Pg", {
  cacheParameterGroupFamily: "redis7",
  description: "cdkrd integ redis7 parameter group",
  properties: {
    // Two non-default parameters the user explicitly tunes. Both are MUTABLE, so they
    // double as the FN (out-of-band change) targets.
    "maxmemory-policy": "allkeys-lru",
    timeout: "300",
  },
});

app.synth();

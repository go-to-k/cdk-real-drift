// CDK app for the cdk-real-drift netfw-min false-positive integration test.
// BAREST-possible Network Firewall building blocks (all free/instant — the
// firewall ENDPOINT itself is the only billable piece and is NOT deployed):
// - AWS::NetworkFirewall::RuleGroup STATEFUL: minimal rulesString — probes the
//   StatefulRuleOptions / RuleVariables echoes.
// - AWS::NetworkFirewall::RuleGroup STATELESS: one pass-all rule.
// - AWS::NetworkFirewall::FirewallPolicy: bare default-action-only policy —
//   probes StatefulEngineOptions / stream-exception defaults.
// A first `check` (pre-record) must show ZERO [Potential Drift].
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnFirewallPolicy, CfnRuleGroup } from "aws-cdk-lib/aws-networkfirewall";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const stack = new Stack(app, "CdkRealDriftIntegNetFwMin");

new CfnRuleGroup(stack, "HuntStatefulRg", {
  ruleGroupName: "cdkrd-hunt-stateful-rg",
  type: "STATEFUL",
  capacity: 10,
  ruleGroup: {
    rulesSource: {
      rulesString:
        'pass tcp any any -> any 443 (msg:"cdkrd hunt allow tls"; sid:1000001; rev:1;)',
    },
  },
});

new CfnRuleGroup(stack, "HuntStatelessRg", {
  ruleGroupName: "cdkrd-hunt-stateless-rg",
  type: "STATELESS",
  capacity: 10,
  ruleGroup: {
    rulesSource: {
      statelessRulesAndCustomActions: {
        statelessRules: [
          {
            priority: 1,
            ruleDefinition: {
              actions: ["aws:pass"],
              matchAttributes: {
                protocols: [6],
                sources: [{ addressDefinition: "0.0.0.0/0" }],
                destinations: [{ addressDefinition: "0.0.0.0/0" }],
              },
            },
          },
        ],
      },
    },
  },
});

new CfnFirewallPolicy(stack, "HuntFwPolicy", {
  firewallPolicyName: "cdkrd-hunt-fw-policy",
  firewallPolicy: {
    statelessDefaultActions: ["aws:forward_to_sfe"],
    statelessFragmentDefaultActions: ["aws:drop"],
  },
});

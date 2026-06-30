// cdk-real-drift SES inbound receipt-rule family read-gap test.
// AWS::SES::ReceiptRuleSet / ::ReceiptRule / ::ReceiptFilter have NO Cloud Control
// handlers (GetResource throws UnsupportedActionException), so each was silently
// `skipped` — zero drift coverage. SDK_OVERRIDES readers (SES DescribeReceiptRuleSet /
// DescribeReceiptRule / ListReceiptFilters) close the gap, so a fresh deploy + record +
// check is CLEAN with no skipped resources. The rule uses only AddHeader + Stop actions
// (no S3 bucket / SNS topic dependency), so the stack is self-contained. NOTE: SES inbound
// receipt rules exist only in us-east-1 / us-west-2 / eu-west-1 — verify.sh pins us-east-1.
import { App, Stack } from "aws-cdk-lib";
import { CfnReceiptFilter, CfnReceiptRule, CfnReceiptRuleSet } from "aws-cdk-lib/aws-ses";

const app = new App();
const stack = new Stack(app, "CdkRealDriftIntegSesReceiptReadGap");

const ruleSet = new CfnReceiptRuleSet(stack, "RuleSet", {
  ruleSetName: "cdkrd-integ-receipt-rule-set",
});

// A rule with two ordered actions (executed sequentially) — proves the Actions array is
// read back in order. tlsPolicy / scanEnabled are left undeclared on purpose: the live
// read returns the SES defaults ("Optional" / false), folded by KNOWN_DEFAULT_PATHS /
// isTrivialEmpty so a never-declared rule stays CLEAN.
const rule = new CfnReceiptRule(stack, "Rule", {
  ruleSetName: ruleSet.ref,
  rule: {
    name: "cdkrd-integ-receipt-rule",
    enabled: true,
    recipients: ["example.com"],
    actions: [
      { addHeaderAction: { headerName: "X-Cdkrd", headerValue: "integ" } },
      { stopAction: { scope: "RuleSet" } },
    ],
  },
});
rule.addDependency(ruleSet);

new CfnReceiptFilter(stack, "Filter", {
  filter: {
    name: "cdkrd-integ-receipt-filter",
    ipFilter: { policy: "Block", cidr: "10.0.0.0/24" },
  },
});

app.synth();

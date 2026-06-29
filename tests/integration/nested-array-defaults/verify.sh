#!/usr/bin/env bash
# cdk-real-drift nested-array materialized-default integration test (real AWS).
#
# AWS::Backup::BackupPlan rules (keyed by RuleName) and AWS::Route53Resolver::FirewallRuleGroup
# rules (keyed by Priority) are object-arrays keyed by a NON-standard field, so
# collectNestedUndeclared could not descend them before NESTED_ARRAY_IDENTITY (a silent FN).
# AWS materializes defaults into each live element (folded via KNOWN_DEFAULT_PATHS), so:
#   deploy -> record a baseline -> check is CLEAN (the materialized defaults fold)
#   -> mutate a rule setting out of band -> check DETECTS it.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegNestedDefaults
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build ==="; (cd "$ROOT" && vp pack) >/dev/null 2>&1 || fail "build"
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

RG_ID="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Route53Resolver::FirewallRuleGroup'].PhysicalResourceId" --output text)"
PLAN_ID="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Backup::BackupPlan'].PhysicalResourceId" --output text)"
VAULT="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Backup::BackupVault'].PhysicalResourceId" --output text)"
DL_ID="$(aws route53resolver list-firewall-rules --firewall-rule-group-id "$RG_ID" --region "$REGION" --query 'FirewallRules[0].FirewallDomainListId' --output text)"

echo "=== record a baseline, then check must be CLEAN (materialized rule defaults fold) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record — a rule default did not fold"

echo "=== mutate a Backup rule (CompletionWindowMinutes 10080->5000) out of band ==="
PLAN_NAME="$(aws backup get-backup-plan --backup-plan-id "$PLAN_ID" --region "$REGION" --query 'BackupPlan.BackupPlanName' --output text)"
aws backup update-backup-plan --backup-plan-id "$PLAN_ID" --region "$REGION" \
  --backup-plan "{\"BackupPlanName\":\"$PLAN_NAME\",\"Rules\":[{\"RuleName\":\"DailyRule\",\"TargetBackupVaultName\":\"$VAULT\",\"ScheduleExpression\":\"cron(0 3 * * ? *)\",\"StartWindowMinutes\":480,\"CompletionWindowMinutes\":5000}]}" >/dev/null \
  || fail "mutate backup rule"

echo "=== mutate a Route53 firewall rule (FirewallDomainRedirectionAction) out of band ==="
aws route53resolver update-firewall-rule --firewall-rule-group-id "$RG_ID" --firewall-domain-list-id "$DL_ID" \
  --region "$REGION" --priority 100 --action BLOCK --block-response NODATA \
  --firewall-domain-redirection-action TRUST_REDIRECTION_DOMAIN >/dev/null || fail "mutate firewall rule"

echo "=== check must DETECT both out-of-band rule changes ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-nested.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "BackupPlanRule\[DailyRule\].CompletionWindowMinutes" /tmp/cdkrd-integ-nested.out \
  || fail "Backup rule CompletionWindowMinutes change not detected (RuleName descent missing?)"
grep -q "FirewallRules\[100\].FirewallDomainRedirectionAction" /tmp/cdkrd-integ-nested.out \
  || fail "Route53 firewall rule change not detected (Priority descent missing?)"

echo "=== revert: both array-element nested values revert via the Cloud Control index-revert writer ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/cdkrd-integ-nested-revert.out || fail "revert errored"
grep -qi "FAILED" /tmp/cdkrd-integ-nested-revert.out && fail "revert reported a FAILED op"

echo "=== verify convergence on the live resources ==="
CW_AFTER="$(aws backup get-backup-plan --backup-plan-id "$PLAN_ID" --region "$REGION" \
  --query 'BackupPlan.Rules[0].CompletionWindowMinutes' --output text)"
echo "CompletionWindowMinutes after revert: $CW_AFTER"
[ "$CW_AFTER" = "10080" ] || fail "Backup CompletionWindowMinutes not reverted (still $CW_AFTER)"
RD_AFTER="$(aws route53resolver list-firewall-rules --firewall-rule-group-id "$RG_ID" --region "$REGION" \
  --query 'FirewallRules[0].FirewallDomainRedirectionAction' --output text)"
echo "FirewallDomainRedirectionAction after revert: $RD_AFTER"
[ "$RD_AFTER" = "INSPECT_REDIRECTION_DOMAIN" ] || fail "Route53 rule not reverted (still $RD_AFTER)"

echo "=== check must be CLEAN again after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "INTEG PASS"

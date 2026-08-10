#!/usr/bin/env bash
# 2026-08-10 hunt: live-proof of never-exercised SDK writers/deleters.
# deploy -> first check MUST be CLEAN (barest-pack FP probe) -> record ->
# mutate all 10 targets out of band -> check MUST DETECT (exit 1) ->
# revert --remove-unrecorded -> check MUST be CLEAN -> live values MUST be back.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0810Wrt
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
ACCT="$(aws sts get-caller-identity --query Account --output text)"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  # the out-of-band grant blocks nothing, but revoke it if the run died mid-way
  if [ -n "${KEY_ID:-}" ]; then
    GID="$(aws kms list-grants --key-id "$KEY_ID" --region "$REGION" \
      --query "Grants[?Name=='cdkrd-0810w-grant'].GrantId" --output text 2>/dev/null || true)"
    [ -n "$GID" ] && aws kms revoke-grant --key-id "$KEY_ID" --grant-id "$GID" --region "$REGION" 2>/dev/null || true
  fi
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

phys() {
  aws cloudformation describe-stack-resource --stack-name "$STACK" --region "$REGION" \
    --logical-resource-id "$1" --query 'StackResourceDetail.PhysicalResourceId' --output text
}
EC_PG="$(phys EcPg)"
SVC_ID="$(phys Svc)"
KEY_ID="$(phys Key)"
ROLE_NAME="$(phys FnRole)"
TG_ARN="$(aws elbv2 describe-target-groups --names cdkrd-0810w-tg --region "$REGION" \
  --query 'TargetGroups[0].TargetGroupArn' --output text)"

echo "=== [$STACK] first check MUST be CLEAN (barest-pack FP probe), then record ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-wrtpack}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.pre.out"
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && fail "first-run FP (see /tmp/cdkrd-$STACK.pre.out)"
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] mutate all targets out of band ==="
aws elbv2 modify-target-group-attributes --target-group-arn "$TG_ARN" --region "$REGION" \
  --attributes Key=deregistration_delay.timeout_seconds,Value=45 >/dev/null || fail "mutate tg"
aws elasticache modify-cache-parameter-group --cache-parameter-group-name "$EC_PG" --region "$REGION" \
  --parameter-name-values "ParameterName=maxmemory-policy,ParameterValue=noeviction" >/dev/null || fail "mutate ec pg"
aws dax update-parameter-group --parameter-group-name cdkrd-0810w-daxpg --region "$REGION" \
  --parameter-name-values "ParameterName=query-ttl-millis,ParameterValue=60000" >/dev/null || fail "mutate dax pg"
aws budgets update-budget --account-id "$ACCT" --new-budget \
  '{"BudgetName":"cdkrd-0810w-budget","BudgetType":"COST","TimeUnit":"MONTHLY","BudgetLimit":{"Amount":"50","Unit":"USD"}}' \
  >/dev/null || fail "mutate budget"
aws cloudwatch disable-alarm-actions --alarm-names cdkrd-0810w-composite --region "$REGION" \
  >/dev/null || fail "mutate composite alarm"
# CognitoEvents leg RULED OUT live (2026-08-10): "Amazon Cognito Sync is no longer
# accepting new customers" (NotAuthorizedException) — the SDK_PROP_WRITERS
# CognitoEvents writer cannot be live-proven from a new account; the OOB mutation
# itself is service-refused, so the drift is unreachable here too.
aws sesv2 update-configuration-set-event-destination --region "$REGION" \
  --configuration-set-name cdkrd-0810w-cs --event-destination-name cdkrd-0810w-dest \
  --event-destination '{"Enabled":true,"MatchingEventTypes":["SEND"],"CloudWatchDestination":{"DimensionConfigurations":[{"DimensionName":"ses-source","DimensionValueSource":"MESSAGE_TAG","DefaultDimensionValue":"none"}]}}' \
  >/dev/null || fail "mutate ses csed"
aws servicediscovery update-service --id "$SVC_ID" --region "$REGION" \
  --service '{"Description":"cdkrd 0810 drifted","DnsConfig":{"DnsRecords":[{"Type":"A","TTL":60}]}}' \
  >/dev/null || fail "mutate cloudmap svc"
aws kms create-grant --key-id "$KEY_ID" --region "$REGION" \
  --grantee-principal "arn:aws:iam::$ACCT:role/$ROLE_NAME" \
  --operations Decrypt --name cdkrd-0810w-grant >/dev/null || fail "mutate kms grant"
aws logs put-bearer-token-authentication --log-group-identifier cdkrd-0810w-lg --region "$REGION" \
  --bearer-token-authentication-enabled >/dev/null || fail "mutate loggroup bearer"
sleep 30

echo "=== [$STACK] check MUST DETECT all 10 ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift (exit 1), got $rc"
for needle in deregistration_delay "maxmemory-policy" "query-ttl-millis" BudgetLimit ActionsEnabled \
  MatchingEventTypes "AWS::KMS::Grant" BearerTokenAuthenticationEnabled; do
  grep -q "$needle" "/tmp/cdkrd-$STACK.detect.out" || fail "missed detection: $needle"
done
# the Cloud Map Service description drift (declared tier)
grep -Eq "Description" "/tmp/cdkrd-$STACK.detect.out" || fail "missed detection: cloudmap Description"

echo "=== [$STACK] revert (all via SDK writers / deleters) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee "/tmp/cdkrd-$STACK.revert.out" || fail "revert"
grep -Eq "NOT reverted|could not be confirmed|not revertable" "/tmp/cdkrd-$STACK.revert.out" \
  && fail "revert reported a non-converged / not-revertable path (see /tmp/cdkrd-$STACK.revert.out)"
sleep 30

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.post.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after revert — a revert did not converge"

echo "=== [$STACK] live values MUST be back ==="
V="$(aws elbv2 describe-target-group-attributes --target-group-arn "$TG_ARN" --region "$REGION" \
  --query "Attributes[?Key=='deregistration_delay.timeout_seconds'].Value" --output text)"
[ "$V" = "300" ] || fail "tg deregistration_delay not restored: $V"
V="$(aws elasticache describe-cache-parameters --cache-parameter-group-name "$EC_PG" --region "$REGION" \
  --query "Parameters[?ParameterName=='maxmemory-policy'].ParameterValue" --output text)"
[ "$V" = "allkeys-lru" ] || fail "ec maxmemory-policy not restored: $V"
V="$(aws dax describe-parameters --parameter-group-name cdkrd-0810w-daxpg --region "$REGION" \
  --query "Parameters[?ParameterName=='query-ttl-millis'].ParameterValue" --output text)"
[ "$V" = "300000" ] || fail "dax query-ttl-millis not restored: $V"
V="$(aws budgets describe-budget --account-id "$ACCT" --budget-name cdkrd-0810w-budget \
  --query 'Budget.BudgetLimit.Amount' --output text)"
[ "${V%%.*}" = "100" ] || fail "budget limit not restored: $V"
V="$(aws cloudwatch describe-alarms --alarm-names cdkrd-0810w-composite --alarm-types CompositeAlarm \
  --region "$REGION" --query 'CompositeAlarms[0].ActionsEnabled' --output text)"
[ "$V" = "True" ] || fail "composite ActionsEnabled not restored: $V"
V="$(aws sesv2 get-configuration-set-event-destinations --configuration-set-name cdkrd-0810w-cs \
  --region "$REGION" --query 'EventDestinations[0].MatchingEventTypes | length(@)' --output text)"
[ "$V" = "3" ] || fail "ses matching event types not restored (len=$V)"
V="$(aws servicediscovery get-service --id "$SVC_ID" --region "$REGION" \
  --query 'Service.Description' --output text)"
[ "$V" = "cdkrd 0810 writer hunt svc" ] || fail "cloudmap description not restored: $V"
V="$(aws kms list-grants --key-id "$KEY_ID" --region "$REGION" \
  --query "Grants[?Name=='cdkrd-0810w-grant'] | length(@)" --output text)"
[ "$V" = "0" ] || fail "kms grant not revoked"
V="$(aws cloudcontrol get-resource --type-name AWS::Logs::LogGroup --identifier cdkrd-0810w-lg \
  --region "$REGION" --query 'ResourceDescription.Properties' --output text | python3 -c \
  "import json,sys; print(json.load(sys.stdin).get('BearerTokenAuthenticationEnabled', False))")"
[ "$V" = "False" ] || fail "loggroup bearer token not disabled: $V"

echo "INTEG OK ($STACK): 10 SDK writer/deleter paths live-proven"

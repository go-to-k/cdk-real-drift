#!/usr/bin/env bash
# enumrev2-hunt (2026-08-09): added->revert(DELETE) proof for the two child types
# the 2026-08-03 run left unproven (distinct CC delete handlers):
#   - AWS::SSM::MaintenanceWindowTask            (OOB register-task)
#   - AWS::ElasticBeanstalk::ConfigurationTemplate (OOB create-configuration-template)
# deploy -> first check CLEAN -> record -> OOB-add both -> check surfaces both as
# added -> revert --remove-unrecorded deletes both (live-verified GONE) -> CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntEnumRev0809
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
EB_APP=cdkrd-hunt-eb-0809b
OOB_TASK_ID=""

cleanup() {
  echo "--- cleanup ($STACK) ---"
  if [ -n "$OOB_TASK_ID" ] && [ -n "${WINDOW_ID:-}" ]; then
    aws ssm deregister-task-from-maintenance-window --window-id "$WINDOW_ID" --window-task-id "$OOB_TASK_ID" --region "$REGION" >/dev/null 2>&1 || true
  fi
  aws elasticbeanstalk delete-configuration-template --application-name "$EB_APP" --template-name cdkrd-oob-tmpl --region "$REGION" >/dev/null 2>&1 || true
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

drift_entries() {
  sed -n '/\[Potential Drift/,/^──/p' "$1" | grep -E '^\s+\S+.* \(AWS::' || true
}

SS="$(aws elasticbeanstalk list-available-solution-stacks --region "$REGION" \
  --query "SolutionStacks[?contains(@,'Amazon Linux 2023') && contains(@,'running Docker')]|[0]" --output text)"
[ -n "$SS" ] && [ "$SS" != "None" ] || fail "could not resolve a Docker/AL2023 solution stack"
echo "solution stack: $SS"

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" -c "ss=$SS" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (pre-record) MUST be CLEAN ==="
CDKRD_CORPUS_DIR="${CDKRD_CORPUS_DIR_OVERRIDE:-/tmp/corpus-enumrev2-hunt}" $CLI check "$STACK" --region "$REGION" -c "ss=$SS" | tee "/tmp/cdkrd-$STACK.first.out"
[ -z "$(drift_entries "/tmp/cdkrd-$STACK.first.out")" ] || { drift_entries "/tmp/cdkrd-$STACK.first.out"; fail "first check surfaced [Potential Drift] entries (fold gap)"; }

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" -c "ss=$SS" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" -c "ss=$SS" --fail || fail "expected CLEAN after record"

WINDOW_ID=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::SSM::MaintenanceWindow'].PhysicalResourceId|[0]" --output text)
DECLARED_TARGET_ID=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::SSM::MaintenanceWindowTarget'].PhysicalResourceId|[0]" --output text)

echo "=== [$STACK] OOB-add: register-task + create-configuration-template ==="
OOB_TASK_ID=$(aws ssm register-task-with-maintenance-window --window-id "$WINDOW_ID" \
  --task-arn AWS-RunShellScript --task-type RUN_COMMAND \
  --targets "Key=WindowTargetIds,Values=$DECLARED_TARGET_ID" \
  --priority 2 --max-concurrency 1 --max-errors 1 --region "$REGION" \
  --query 'WindowTaskId' --output text) || fail "oob register-task"
aws elasticbeanstalk create-configuration-template --application-name "$EB_APP" \
  --template-name cdkrd-oob-tmpl --solution-stack-name "$SS" --region "$REGION" >/dev/null || fail "oob create-configuration-template"

echo "=== [$STACK] check MUST surface both OOB children as added ==="
$CLI check "$STACK" --region "$REGION" -c "ss=$SS" --fail | tee "/tmp/cdkrd-$STACK.oob.out"
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "check did not fail with OOB children present"
grep -q "$OOB_TASK_ID" "/tmp/cdkrd-$STACK.oob.out" || fail "OOB MaintenanceWindowTask not surfaced as added"
grep -q "cdkrd-oob-tmpl" "/tmp/cdkrd-$STACK.oob.out" || fail "OOB EB ConfigurationTemplate not surfaced as added"
# #1737: post-record OOB children must be CONFIRMED (appeared since record), not potential
grep -q "appeared since record" "/tmp/cdkrd-$STACK.oob.out" || fail "OOB children not confirmed as appeared-since-record"

echo "=== [$STACK] plain revert (no --remove-unrecorded) MUST delete both CONFIRMED OOB children ==="
# #1737: appeared-since-record children are confirmed drift, so the delete plans flaglessly
$CLI revert "$STACK" --region "$REGION" -c "ss=$SS" --yes | tee "/tmp/cdkrd-$STACK.revert.out"
grep -qiE "NOT reverted|could not be confirmed|drift\(s\) remain" "/tmp/cdkrd-$STACK.revert.out" && fail "revert reported non-convergence deleting OOB children"
aws ssm describe-maintenance-window-tasks --window-id "$WINDOW_ID" --region "$REGION" \
  --query "Tasks[?WindowTaskId=='$OOB_TASK_ID']" --output text | grep -q . && fail "OOB task still exists after revert"
aws elasticbeanstalk describe-applications --application-names "$EB_APP" --region "$REGION" \
  --query 'Applications[0].ConfigurationTemplates' --output text | grep -q "cdkrd-oob-tmpl" && fail "OOB configuration template still exists after revert"
OOB_TASK_ID="" # deleted by revert — cleanup must not re-try
$CLI check "$STACK" --region "$REGION" -c "ss=$SS" --fail || fail "expected CLEAN after revert-deleting OOB children"

echo "INTEG PASS ($STACK)"

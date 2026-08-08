#!/usr/bin/env bash
# cdstyle-hunt (2026-08-09): two probes on one cheap stack.
#   1. #1723 DeploymentStyle revert proof: OOB update-deployment-group attaches
#      WITH_TRAFFIC_CONTROL + targetGroupInfoList (reachable thanks to the
#      standalone TG) -> check must DETECT -> revert must converge BOTH the style
#      flip (back to IN_PLACE/WITHOUT_TRAFFIC_CONTROL) and the appeared
#      LoadBalancerInfo (removed).
#   2. First live E2E of `check --pre-deploy` (#727): OOB-mutate the declared SSM
#      parameter -> --pre-deploy must surface it; a context-gated local-only
#      resource (-c extra=1) must read as "not yet deployed" info (exit 0 when
#      the drift is restored, including under --strict).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntCdStyle0809
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
CD_APP=cdkrd-hunt-cd-0809b
CD_DG=cdkrd-hunt-dg-0809b
TG_NAME=cdkrd-hunt-tg-0809
PARAM=cdkrd-hunt-pval-0809

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

# entry lines inside the [Potential Drift] block (NOT the summary header)
drift_entries() {
  sed -n '/\[Potential Drift/,/^──/p' "$1" | grep -E '^\s+\S+.* \(AWS::' || true
}

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (pre-record) MUST be CLEAN ==="
CDKRD_CORPUS_DIR="${CDKRD_CORPUS_DIR_OVERRIDE:-/tmp/corpus-cdstyle-hunt}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
[ -z "$(drift_entries "/tmp/cdkrd-$STACK.first.out")" ] || { drift_entries "/tmp/cdkrd-$STACK.first.out"; fail "first check surfaced [Potential Drift] entries (fold gap)"; }

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "=== [$STACK] #1723 probe: OOB WITH_TRAFFIC_CONTROL + TG attach MUST be DETECTED ==="
aws deploy update-deployment-group --application-name "$CD_APP" \
  --current-deployment-group-name "$CD_DG" \
  --deployment-style '{"deploymentType":"IN_PLACE","deploymentOption":"WITH_TRAFFIC_CONTROL"}' \
  --load-balancer-info "{\"targetGroupInfoList\":[{\"name\":\"$TG_NAME\"}]}" \
  --region "$REGION" || fail "oob update-deployment-group"
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.style.out"
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "OOB DeploymentStyle flip NOT detected (FN)"
grep -q "DeploymentStyle" "/tmp/cdkrd-$STACK.style.out" || fail "detected drift does not mention DeploymentStyle"

echo "=== [$STACK] revert MUST converge style AND remove the appeared LoadBalancerInfo ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee "/tmp/cdkrd-$STACK.revert.out"
grep -qiE "NOT reverted|could not be confirmed|drift\(s\) remain" "/tmp/cdkrd-$STACK.revert.out" && fail "revert reported non-convergence on the DeploymentStyle flip"
LIVE_OPT=$(aws deploy get-deployment-group --application-name "$CD_APP" --deployment-group-name "$CD_DG" \
  --region "$REGION" --query 'deploymentGroupInfo.deploymentStyle.deploymentOption' --output text)
[ "$LIVE_OPT" = "WITHOUT_TRAFFIC_CONTROL" ] || fail "revert did NOT converge DeploymentStyle (live deploymentOption=$LIVE_OPT)"
LIVE_TGS=$(aws deploy get-deployment-group --application-name "$CD_APP" --deployment-group-name "$CD_DG" \
  --region "$REGION" --query 'length(deploymentGroupInfo.loadBalancerInfo.targetGroupInfoList || `[]`)' --output text)
[ "$LIVE_TGS" = "0" ] || fail "revert left the appeared LoadBalancerInfo attached (targetGroupInfoList len=$LIVE_TGS)"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after style revert"

echo "=== [$STACK] --pre-deploy probe: OOB declared-param change MUST surface ==="
aws ssm put-parameter --name "$PARAM" --value v2 --type String --overwrite --region "$REGION" >/dev/null || fail "oob put-parameter"
$CLI check "$STACK" --region "$REGION" --pre-deploy --fail | tee "/tmp/cdkrd-$STACK.pre.out"
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "--pre-deploy did not fail on an OOB change to a declared prop"
grep -q "PreParam\|$PARAM" "/tmp/cdkrd-$STACK.pre.out" || fail "--pre-deploy output does not mention the drifted parameter"

echo "=== [$STACK] --pre-deploy with a local-only resource: pending creation is INFO, not a gap ==="
$CLI check "$STACK" --region "$REGION" --pre-deploy -c extra=1 --fail | tee "/tmp/cdkrd-$STACK.pre2.out"
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "--pre-deploy -c extra=1 lost the param drift"
grep -qi "not yet deployed" "/tmp/cdkrd-$STACK.pre2.out" || fail "pending-creation resource not surfaced as 'not yet deployed' info"
grep -qi "NOT checked (coverage incomplete)" "/tmp/cdkrd-$STACK.pre2.out" && fail "pending-creation resource was warned as a coverage gap"

echo "=== [$STACK] restore param: --pre-deploy --strict -c extra=1 MUST exit 0 ==="
aws ssm put-parameter --name "$PARAM" --value v1 --type String --overwrite --region "$REGION" >/dev/null || fail "restore put-parameter"
$CLI check "$STACK" --region "$REGION" --pre-deploy --strict -c extra=1 --fail | tee "/tmp/cdkrd-$STACK.pre3.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "--pre-deploy --strict false-failed on a pending-creation-only diff"

echo "INTEG PASS ($STACK)"

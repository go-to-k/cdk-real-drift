#!/usr/bin/env bash
# cdk-real-drift corpus-harvest integration test wave 4 (real AWS) — R75.
#
#   A. HARVEST the high-frequency families (ALB+TG+Listener, EFS, Route53
#      zone + ALIAS record, Cognito IdentityPool, DynamoDB Application Auto
#      Scaling, SSM Document, HTTP API explicit stage, ECR lifecycle policy):
#      1. baseline-free `check` — fresh deploy must classify with ZERO
#         declared drift, exit 0;
#      2. `record --yes` then `check --fail` — CLEAN across every type.
#   B. ALB ATTRIBUTE REVERT: the declared idle_timeout lives INSIDE the
#      {Key,Value}[] LoadBalancerAttributes list — mutate it out of band
#      (120 -> 300), `check` must name it as DECLARED drift, `revert --yes`
#      must restore it via Cloud Control, confirmed by a direct ELBv2 read.
#      (Exercises declared drift + revert through a Key-sorted attribute
#      bag — a different shape from every earlier matrix type.)
#
# CDKRD_HARVEST4_KEEP=1 skips the destroy for debug iteration.
# Run with CDKRD_CORPUS_DIR=<dir> to record golden-corpus cases; drift-state
# recordings are snapshotted to ${CDKRD_CORPUS_DIR}.drifted first.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/harvest4 && npm install && bash verify-harvest4.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkrdIntegHarvest4
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
OUT=/tmp/cdkrd-harvest4.out

cleanup() {
  if [ -n "${CDKRD_HARVEST4_KEEP:-}" ]; then
    echo "--- keeping stack (CDKRD_HARVEST4_KEEP set) — destroy manually when done ---"
    return
  fi
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture (wave 4: high-frequency families) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== A1. baseline-free check: fresh deploy must have ZERO declared drift ==="
$CLI check "$STACK" --region "$REGION" | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded inventory only), got $rc"
grep -q "DECLARED DRIFT" "$OUT" && fail "fresh deploy reported DECLARED drift — false positive"
grep -q "deleted" "$OUT" && fail "fresh deploy reported a deleted resource"

echo "=== A2. record + check --fail must be CLEAN across every type ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after record"

echo "=== B1. mutate the declared ALB idle_timeout out of band (120 -> 300) ==="
ALB_ARN="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ElasticLoadBalancingV2::LoadBalancer'].PhysicalResourceId" \
  --output text)"
[ -n "$ALB_ARN" ] || fail "could not resolve ALB arn"
aws elbv2 modify-load-balancer-attributes --load-balancer-arn "$ALB_ARN" \
  --attributes Key=idle_timeout.timeout_seconds,Value=300 --region "$REGION" >/dev/null || fail "inject alb attribute"
sleep 10

# DETECTION of an out-of-band change to ONE attribute inside the {Key,Value}[]
# LoadBalancerAttributes bag must name exactly that attribute by KEY — the
# template declares 2 of ~23 attributes, so without the R75 subset comparison the
# whole list reports as drift; with the R78 Key-scoped comparison only
# idle_timeout surfaces, named LoadBalancerAttributes[idle_timeout.timeout_seconds].
echo "=== B2. check must name ONLY the mutated attribute by Key ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected drift exit 1"
grep -q "DECLARED DRIFT: 1" "$OUT" || fail "expected exactly 1 declared drift (Key-scoped compare failed)"
grep -q "idle_timeout" "$OUT" || fail "missing idle_timeout drift"

if [ -n "${CDKRD_CORPUS_DIR:-}" ]; then
  echo "=== snapshot drift-state corpus recordings ==="
  rm -rf "${CDKRD_CORPUS_DIR}.drifted"
  cp -R "$CDKRD_CORPUS_DIR" "${CDKRD_CORPUS_DIR}.drifted" || fail "corpus snapshot"
fi

# R78: revert the identity-keyed attribute bag via the ELB SDK writer
# (ModifyLoadBalancerAttributes with ONLY the declared Key=Value — not a Cloud
# Control index patch, which misaligns against the full live bag and exceeds
# ELB's 20-attribute cap). This is the live proof of the R78 revert path.
echo "=== B3. revert --yes restores the attribute via the ELB SDK writer ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert returned non-zero"
sleep 5

echo "=== B4. check CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "drift remains after revert"

echo "=== B5. direct ELBv2 read confirms idle_timeout restored to 120 ==="
IDLE="$(aws elbv2 describe-load-balancer-attributes --load-balancer-arn "$ALB_ARN" --region "$REGION" \
  --query "Attributes[?Key=='idle_timeout.timeout_seconds'].Value | [0]" --output text)"
[ "$IDLE" = "120" ] || fail "idle_timeout not restored (got $IDLE)"

echo "INTEG PASS"

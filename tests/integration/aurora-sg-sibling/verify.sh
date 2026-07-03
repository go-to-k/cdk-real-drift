#!/usr/bin/env bash
# cdk-real-drift Aurora SecurityGroup-sibling false-positive integration test (real AWS).
#
# Deploys an Aurora cluster whose SG carries a STANDALONE AWS::EC2::SecurityGroupIngress
# sibling (emitted by `cluster.connections.allowFrom(peer, Port.tcp(cluster.clusterEndpoint
# .port))` — see app.ts). The sibling's FromPort/ToPort are GetAtt <Cluster>.Endpoint.Port,
# which resolves to a STRING while the SG reflects the rule with a NUMBER port.
#
# The strong assertion: with NO baseline, `check` must NOT report the SG's
# SecurityGroupIngress — the sibling subtract recognizes the reflected rule as declared. A
# regression in siblingRuleFieldMatches (dropping the typed<->string / UNRESOLVED tolerance)
# turns it back into a false undeclared potential-drift, which this grep catches. Then
# record + check stays CLEAN.
#
# A cleanup trap destroys even on failure, so a failed run leaves no orphans.
# Usage:  cd tests/integration/aurora-sg-sibling && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegAuroraSgSibling
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture (Aurora — allow ~15 min) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== check (no baseline) must NOT report the sibling-reflected SecurityGroupIngress ==="
$CLI check "$STACK" --region "$REGION" | tee /tmp/cdkrd-aurora-sg-pre.out
grep -q "SecurityGroupIngress" /tmp/cdkrd-aurora-sg-pre.out \
  && fail "SG SecurityGroupIngress surfaced as drift — the sibling-rule subtract regressed (typed<->string / UNRESOLVED port)"

echo "=== record then check must stay CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after record"

echo "INTEG PASS"

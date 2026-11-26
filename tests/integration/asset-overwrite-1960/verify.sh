#!/usr/bin/env bash
# cdk-real-drift #1960 integration test (real AWS): an out-of-band overwrite of a Glue job's
# script / a TrustStore's CA bundle made AFTER a legit redeploy of that source must still be
# detected, against the LOCAL synthesized asset (the S3 object is the live artifact, so it
# cannot be its own expected hash).
#   deploy v1 -> record -> check CLEAN
#   -> deploy v2 (new script + new CA, new asset keys) -> check CLEAN, verified (no
#      "could not verify" note)
#   -> overwrite the v2 script object; overwrite the v2 CA object + modify-trust-store
#   -> check DETECTS ScriptSha256 + CaCertificatesBundleSha256 (exit 1)
# A cleanup trap destroys the stack and removes the baseline even on failure.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit), openssl. Docker NOT needed.
# Usage:  cd tests/integration/asset-overwrite-1960 && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdInteg1960AssetOverwrite
REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="$REGION"
CLI="node $ROOT/dist/cli.js"
OUT="$(mktemp -d)"

cleanup() {
  echo "--- cleanup ---"
  CODE_VERSION=v2 CDKRD_1960_CA="$OUT/ca-v2.pem" npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out "$OUT"
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

mkca() {
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$OUT/$1.key" -out "$OUT/$1.pem" \
    -days 2 -subj "/CN=cdkrd-1960-$1" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    >/dev/null 2>&1 || fail "openssl $1"
}
mkca ca-v1
mkca ca-v2
mkca ca-v3

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy v1 ==="
export CODE_VERSION=v1 CDKRD_1960_CA="$OUT/ca-v1.pem"
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy v1"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
grep -q ScriptSha256 .cdkrd/baselines/*.json || fail "ScriptSha256 not recorded"
grep -q CaCertificatesBundleSha256 .cdkrd/baselines/*.json || fail "CA bundle hash not recorded"

echo "=== check should be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN right after record"

echo "=== deploy v2 (legit script + CA redeploy) ==="
export CODE_VERSION=v2 CDKRD_1960_CA="$OUT/ca-v2.pem"
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy v2"

echo "=== check should be CLEAN, verified against the local assets ==="
$CLI check "$STACK" --region "$REGION" --fail >"$OUT/v2.out" 2>&1
rc=$?
cat "$OUT/v2.out"
[ $rc -eq 0 ] || fail "expected CLEAN after a legit source redeploy (rc=$rc)"
grep -q "redeployed via CloudFormation since record" "$OUT/v2.out" || fail "missing re-record nudge"
if grep -q "could not verify" "$OUT/v2.out"; then fail "a hash was not verified"; fi

echo "=== overwrite the deployed objects out of band ==="
res() {
  aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='$1'].PhysicalResourceId" --output text
}
JOB="$(res AWS::Glue::Job)"
TS_ARN="$(res AWS::ElasticLoadBalancingV2::TrustStore)"
[ -n "$JOB" ] && [ -n "$TS_ARN" ] || fail "could not resolve physical ids"
LOC="$(aws glue get-job --job-name "$JOB" --region "$REGION" --query Job.Command.ScriptLocation --output text)"
echo 'print("swapped out of band")' >"$OUT/swapped.py"
aws s3 cp "$OUT/swapped.py" "$LOC" --region "$REGION" >/dev/null || fail "overwrite script"
TPL="$(aws cloudformation get-template --stack-name "$STACK" --region "$REGION" --query TemplateBody --output json)"
CA_KEY="$(node -e 'const t=JSON.parse(JSON.parse(process.argv[1]));for(const r of Object.values(t.Resources))if(r.Type==="AWS::ElasticLoadBalancingV2::TrustStore")console.log(r.Properties.CaCertificatesBundleS3Key)' "$TPL")"
CA_BUCKET="${LOC#s3://}"; CA_BUCKET="${CA_BUCKET%%/*}"
[ -n "$CA_KEY" ] || fail "could not resolve CA key"
aws s3 cp "$OUT/ca-v3.pem" "s3://$CA_BUCKET/$CA_KEY" --region "$REGION" >/dev/null || fail "overwrite CA"
aws elbv2 modify-trust-store --trust-store-arn "$TS_ARN" --region "$REGION" \
  --ca-certificates-bundle-s3-bucket "$CA_BUCKET" --ca-certificates-bundle-s3-key "$CA_KEY" \
  >/dev/null || fail "modify-trust-store"
sleep 10

echo "=== check should DETECT both overwrites ==="
$CLI check "$STACK" --region "$REGION" --fail >"$OUT/v3.out" 2>&1
rc=$?
cat "$OUT/v3.out"
[ $rc -eq 1 ] || fail "expected drift (exit 1) after the overwrites (rc=$rc)"
grep -q "ScriptSha256" "$OUT/v3.out" || fail "ScriptSha256 not reported"
grep -q "CaCertificatesBundleSha256" "$OUT/v3.out" || fail "CaCertificatesBundleSha256 not reported"

echo "INTEG PASS"

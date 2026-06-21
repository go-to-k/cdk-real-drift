#!/usr/bin/env bash
# CloudFront detect + revert (real AWS). The revert is the point: CloudFront's Cloud
# Control UpdateResource REJECTS a partial patch (ViewerCertificate re-validation), so
# revert goes through the GetDistributionConfig->UpdateDistribution SDK writer. Mutate
# the declared MUTABLE Comment out of band -> check MUST DETECT -> revert (SDK writer)
# -> check MUST be CLEAN and Comment restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegCloudfrontRich; COMMENT="cdkrd cloudfront rich"; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out cfg.json cfg2.json; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
DID="$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$COMMENT'].Id" --output text)"
[ -n "$DID" ] && [ "$DID" != "None" ] || fail "no distribution id"
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob Comment -> DRIFTED (full-config update) ==="
aws cloudfront get-distribution-config --id "$DID" > cfg.json
ETAG="$(node -e "console.log(require('./cfg.json').ETag)")"
node -e "const fs=require('fs');const j=require('./cfg.json');j.DistributionConfig.Comment='DRIFTED OUT OF BAND';fs.writeFileSync('cfg2.json',JSON.stringify(j.DistributionConfig));"
aws cloudfront update-distribution --id "$DID" --distribution-config file://cfg2.json --if-match "$ETAG" >/dev/null || fail "inject"
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-cf-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "Comment" /tmp/cdkrd-cf-detect.out || fail "Comment drift not reported"
echo "=== revert (SDK writer: UpdateDistribution) ==="; $CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/cdkrd-cf-revert.out
grep -qi "CLEAN after revert" /tmp/cdkrd-cf-revert.out || fail "revert did not converge (CC-patch regression?)"
GOT="$(aws cloudfront get-distribution-config --id "$DID" --query 'DistributionConfig.Comment' --output text)"
[ "$GOT" = "$COMMENT" ] || fail "Comment not restored (got: $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

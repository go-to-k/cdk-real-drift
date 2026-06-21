#!/usr/bin/env bash
# OpenSearch Domain detect + revert (real AWS). The revert is the point: OpenSearch's
# Cloud Control UpdateResource REJECTS a property patch — it re-submits the full model
# and AWS's own legacy `override_main_response_version` AdvancedOption is rejected as
# "Unrecognized advanced option". Revert goes through the UpdateDomainConfig SDK writer,
# which sends ONLY the touched option (partial API), so AdvancedOptions is never
# re-submitted. Drift the declared MUTABLE EBSOptions.VolumeSize 10->20 out of band ->
# check MUST DETECT -> revert (SDK writer) -> CLEAN + restored. (Domain config changes
# take a few minutes; the script waits for the domain to settle before reverting.)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$HERE"
STACK=CdkRealDriftIntegOpensearchRich; DN=cdkrd-opensearch-rich; REGION="${AWS_REGION:-us-east-1}"; CLI="node $ROOT/dist/cli.js"
cleanup(){ echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT; fail(){ echo "INTEG FAIL ($STACK): $*"; exit 1; }
settle(){ for _ in $(seq 1 60); do [ "$(aws opensearch describe-domain --domain-name "$DN" --region "$REGION" --query 'DomainStatus.Processing' --output text)" = "False" ] && return 0; sleep 15; done; }
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy
echo "=== record ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== oob EBS VolumeSize 10->20 ==="
aws opensearch update-domain-config --domain-name "$DN" --ebs-options EBSEnabled=true,VolumeType=gp3,VolumeSize=20 --region "$REGION" >/dev/null || fail inject
settle
echo "=== check MUST DETECT ==="; $CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-os-detect.out
rc=${PIPESTATUS[0]}; [ "$rc" -eq 1 ] || fail "expected exit 1 got $rc"
grep -qi "VolumeSize" /tmp/cdkrd-os-detect.out || fail "EBS VolumeSize drift not reported"
echo "=== revert (SDK writer: UpdateDomainConfig) ==="; $CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/cdkrd-os-revert.out
grep -qi "CLEAN after revert" /tmp/cdkrd-os-revert.out || fail "revert did not converge (CC override_main_response_version regression?)"
settle
GOT="$(aws opensearch describe-domain-config --domain-name "$DN" --region "$REGION" --query 'DomainConfig.EBSOptions.Options.VolumeSize' --output text)"
[ "$GOT" = "10" ] || fail "VolumeSize not restored (got $GOT)"
echo "INTEG PASS ($STACK detect+revert)"

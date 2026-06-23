#!/usr/bin/env bash
# Read-gap integration test (real AWS): API Gateway REST sub-resources
# (RequestValidator, Model, DocumentationPart) each carry a COMPOSITE Cloud Control
# primaryIdentifier while their CFn Ref returns only the child segment. If cdkrd does
# not derive the composite id, Cloud Control GetResource rejects the bare id and the
# resource is silently classified `skipped` (a read-gap false negative). This test
# deploys all three and asserts NONE of them are skipped (they must be read), then runs
# the standard record -> check CLEAN false-positive oracle.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegApigwRestSubres
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] check --json (fresh, pre-record) — inspect for skipped sub-resources ==="
$CLI check "$STACK" --region "$REGION" --json | tee "/tmp/cdkrd-$STACK.json" >/dev/null || true
python3 - "$STACK" <<'PY' || fail "read-gap: a composite-id sub-resource was skipped"
import json, sys
stack = sys.argv[1]
data = json.load(open(f"/tmp/cdkrd-{stack}.json"))
findings = data.get("findings", [])
gap_types = {
    "AWS::ApiGateway::RequestValidator",
    "AWS::ApiGateway::Model",
    "AWS::ApiGateway::DocumentationPart",
}
skipped = [f for f in findings if f.get("tier") == "skipped" and f.get("resourceType") in gap_types]
if skipped:
    print("READ-GAP DETECTED — composite-id sub-resources skipped (not read):")
    for f in skipped:
        print(f"  {f['resourceType']} {f.get('logicalId')} — {f.get('note')}")
    sys.exit(1)
print("OK — no composite-id sub-resource was skipped; all three were read.")
PY

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"

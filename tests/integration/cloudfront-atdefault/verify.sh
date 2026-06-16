#!/usr/bin/env bash
# cdkrd R103 integration test (real AWS, read-only). A CloudFront Distribution
# materializes nested config defaults the template never set; the CloudFront CFn
# schema annotates them as `default`, so cdkrd folds the matching live values as
# `atDefault` (nested) instead of `undeclared`. Asserts that schema-defaulted nested
# paths (CustomOriginConfig.HTTPSPort=443 / OriginReadTimeout=30, PriceClass) land in
# the atDefault tier, and that NONE of them are `declared` drift.
# CloudFront deploy/destroy are slow (minutes each).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegCfAtDefault
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup (CloudFront destroy is slow) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build ==="; (cd "$ROOT" && vp run build) || fail build
echo "=== deploy (slow) ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy

echo "=== check: schema-defaulted nested values fold as atDefault, none are drift ==="
$CLI check "$STACK" --region "$REGION" --show-all --json > /tmp/cdkrd-cfad.json 2>/tmp/cdkrd-cfad.err \
  || { cat /tmp/cdkrd-cfad.err; fail "check errored"; }
node -e '
  const j = require("/tmp/cdkrd-cfad.json");
  const dist = (j.findings||[]).filter(f => f.resourceType === "AWS::CloudFront::Distribution");
  const tierOf = (substr) => {
    const f = dist.find(x => String(x.path).includes(substr));
    return f ? f.tier : "(absent)";
  };
  // these nested paths are schema `default`s — must be atDefault now, never undeclared
  const checks = [
    ["CustomOriginConfig.HTTPSPort", 443],
    ["CustomOriginConfig.OriginReadTimeout", 30],
    ["PriceClass", null],
  ];
  let bad = [];
  for (const [p] of checks) {
    const t = tierOf(p);
    if (t !== "atDefault") bad.push(`${p} -> ${t} (expected atDefault)`);
  }
  if (dist.some(f => f.tier === "declared")) bad.push("unexpected declared drift: " + JSON.stringify(dist.filter(f=>f.tier==="declared").map(f=>f.path)));
  if (bad.length) { console.error("FAIL:\n" + bad.join("\n")); process.exit(1); }
  const atDefaultCount = dist.filter(f => f.tier === "atDefault").length;
  console.log(`schema-defaulted nested values folded as atDefault (${atDefaultCount} total) ✓`);
' || fail "nested schema defaults did not fold as atDefault"

echo "INTEG PASS"

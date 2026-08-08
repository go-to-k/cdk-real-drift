#!/usr/bin/env bash
# elbx-hunt (2026-08-09): first-run FP probe over the ELB/VPC surfaces the
# offline audit flagged (see app.ts). Pre-creates the CA bundle + CRL bucket the
# TrustStore/Revocation need, deploys, asserts the FIRST check (pre-record) is
# CLEAN, records, then runs an FN probe on the VPC endpoint service's
# AcceptanceRequired (OOB modify -> detect -> revert -> live restored).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkrdHunt0809ElbX
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
ACCT=$(aws sts get-caller-identity --query Account --output text)
export CDKRD_HUNT_TSX_BUCKET="cdkrd-hunt-tsx-0809-$ACCT"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  aws s3 rb "s3://$CDKRD_HUNT_TSX_BUCKET" --force >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

drift_entries() {
  # The TrustStore CaCertificatesBundleSha256 is the BY-DESIGN recordable synthetic
  # hash (#1606/#1615): it deliberately surfaces on a baseline-less first run (so an
  # out-of-band modify-trust-store is watchable) and is snapshotted by `record`.
  # Same carve-out as truststore-barest — every OTHER entry is a fold gap.
  sed -n '/\[Potential Drift/,/^──/p' "$1" | grep -E '^\s+\S.*\(AWS::' | grep -v 'CaCertificatesBundleSha256' || true
}

echo "=== [$STACK] pre-create CA bundle + CRL ==="
WORK=$(mktemp -d /tmp/cdkrd-tsx-0809.XXXXXX)
openssl req -x509 -newkey rsa:2048 -keyout "$WORK/ca.key" -out "$WORK/ca.pem" \
  -days 7 -nodes -subj "/CN=cdkrd-hunt-elbx.internal" 2>/dev/null || fail "openssl ca"
cat > "$WORK/crl.cnf" <<EOF
[ca]
default_ca = myca
[myca]
database = $WORK/index.txt
crlnumber = $WORK/crlnumber
default_md = sha256
certificate = $WORK/ca.pem
private_key = $WORK/ca.key
default_crl_days = 7
EOF
touch "$WORK/index.txt"
echo 01 > "$WORK/crlnumber"
openssl ca -config "$WORK/crl.cnf" -gencrl -out "$WORK/crl.pem" 2>/dev/null || fail "openssl crl"
aws s3api create-bucket --bucket "$CDKRD_HUNT_TSX_BUCKET" --region "$REGION" >/dev/null || true
aws s3 cp "$WORK/ca.pem" "s3://$CDKRD_HUNT_TSX_BUCKET/ca-bundle.pem" >/dev/null || fail "s3 cp ca"
aws s3 cp "$WORK/crl.pem" "s3://$CDKRD_HUNT_TSX_BUCKET/crl.pem" >/dev/null || fail "s3 cp crl"

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (pre-record) MUST be CLEAN and error-free ==="
CDKRD_CORPUS_DIR="${CDKRD_CORPUS_DIR_OVERRIDE:-/tmp/corpus-elbx}" $CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check errored (exit != 0)"
[ -z "$(drift_entries "/tmp/cdkrd-$STACK.first.out")" ] || { drift_entries "/tmp/cdkrd-$STACK.first.out"; fail "first check surfaced [Potential Drift] entries (fold gap)"; }
grep -E "skipped=|readGap=|unresolved=" "/tmp/cdkrd-$STACK.first.out" || true

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "=== [$STACK] FN probe: OOB AcceptanceRequired flip -> detect -> revert ==="
SVC_ID=$(aws cloudformation describe-stack-resource --stack-name "$STACK" \
  --logical-resource-id Vpces --region "$REGION" \
  --query 'StackResourceDetail.PhysicalResourceId' --output text)
[ "$SVC_ID" != "None" ] && [ -n "$SVC_ID" ] || fail "could not resolve endpoint service id"
aws ec2 modify-vpc-endpoint-service-configuration --service-id "$SVC_ID" \
  --acceptance-required --region "$REGION" >/dev/null || fail "oob modify vpces"
$CLI check "$STACK" --region "$REGION" --fail && fail "AcceptanceRequired drift NOT detected (FN)"
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.revert.out"
grep -E "NOT reverted|could not be confirmed" "/tmp/cdkrd-$STACK.revert.out" && fail "revert reported non-convergence"
LIVE_AR=$(aws ec2 describe-vpc-endpoint-service-configurations --service-ids "$SVC_ID" --region "$REGION" \
  --query 'ServiceConfigurations[0].AcceptanceRequired' --output text)
[ "$LIVE_AR" = "False" ] || fail "revert did not restore AcceptanceRequired (live=$LIVE_AR)"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"

echo "INTEG PASS ($STACK)"

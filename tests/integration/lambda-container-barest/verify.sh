#!/usr/bin/env bash
# False-positive integration test (real AWS) for a container-image Lambda (PackageType:
# Image). A tiny image is built from a public Lambda base and pushed to a dedicated ECR
# repo out of band, then the barest CfnFunction (Code.ImageUri + Role only) is deployed.
# A clean deploy must FIRST-check CLEAN — every AWS-assigned default the Image variant
# materializes (Architectures, EphemeralStorage, PackageType, LoggingConfig,
# RuntimeManagementConfig, ImageConfigResponse, MemorySize/Timeout) must fold, not FP.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntLambdaImg0713
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REPO=cdkrd-hunt-lambdaimg0713
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  aws ecr delete-repository --repository-name "$REPO" --region "$REGION" --force >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] create ECR repo + build/push image ==="
aws ecr create-repository --repository-name "$REPO" --region "$REGION" \
  --tags Key=cdkrd:ephemeral,Value=1 >/dev/null 2>&1 || true
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" || fail "ecr login"
# Build linux/amd64: the barest function declares no Architectures, so Lambda defaults
# to x86_64 and would reject an arm64 image. --provenance=false --sbom=false disable the
# buildkit OCI attestation layers that Lambda rejects (InvalidImage:
# UnsupportedImageLayerDetected) — required with Docker 24+ default buildkit.
docker build --platform linux/amd64 --provenance=false --sbom=false -t "$REGISTRY/$REPO:latest" . || fail "docker build"
docker push "$REGISTRY/$REPO:latest" || fail "docker push"
# Resolve the immutable digest URI (Lambda pins by digest; use it so the template is stable).
DIGEST="$(aws ecr describe-images --repository-name "$REPO" --region "$REGION" \
  --query 'imageDetails[0].imageDigest' --output text)"
export CDKRD_HUNT_IMAGE_URI="$REGISTRY/$REPO@$DIGEST"
echo "image: $CDKRD_HUNT_IMAGE_URI"

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (no baseline) MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-first.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check reported potential drift on a clean deploy (fold gap)"

echo "=== [$STACK] record + check MUST be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "expected CLEAN after record"

echo "INTEG PASS ($STACK)"

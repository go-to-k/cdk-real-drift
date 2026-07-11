#!/usr/bin/env bash
# Smoke test for sweep-orphans.sh — runs the DRY-RUN sweep against a MOCK `aws` CLI
# (canned list/describe output on PATH) and asserts the safety-critical behaviors:
#   1. case-INSENSITIVE active-stack protection (a lowercased RDS name is recognized
#      as backed by its mixed-case stack → SKIP, never a false orphan → never deleted)
#   2. IAM roles are swept (the class that leaked before) — an orphan role is found
#   3. the generic tag net reports an any-type tagged resource (no false SWEEP CLEAN)
# Run: bash tests/integration/sweep-orphans.test.sh

set -euo pipefail

SWEEP="$(cd "$(dirname "$0")" && pwd)/sweep-orphans.sh"
PASS=0
FAIL=0
# assert <name> <haystack> <regex> — grep inside `if` is a condition context, so a
# no-match does not trip `set -e`.
assert() {
  if printf '%s' "$2" | grep -qE "$3"; then PASS=$((PASS + 1)); echo "ok   - $1"; else FAIL=$((FAIL + 1)); echo "FAIL - $1"; fi
}
refute() {
  if printf '%s' "$2" | grep -qE "$3"; then FAIL=$((FAIL + 1)); echo "FAIL - $1"; else PASS=$((PASS + 1)); echo "ok   - $1"; fi
}

tmp=$(mktemp -d)
# --- mock aws: dispatch on "<service> <op>", emit canned --output text ---
cat > "$tmp/aws" <<'MOCK'
#!/usr/bin/env bash
svc="$1"; op="${2:-}"
case "$svc/$op" in
  cloudformation/list-stacks)   echo "Cdkrd717Verify" ;;            # the only ACTIVE stack (mixed case)
  rds/describe-db-instances)    echo "cdkrd717verify-writer-abc123" ;;  # lowercased -> backed by Cdkrd717Verify
  rds/describe-db-clusters)     : ;;
  iam/list-roles)               printf '%s\t%s\n' "CdkRealDriftGone-ApiCloudWatchRole-xyz" "2020-01-01T00:00:00+00:00" ;; # stack gone + old -> ORPHAN
  iam/list-instance-profiles)   : ;;
  resourcegroupstaggingapi/get-resources) echo "arn:aws:sqs:us-east-1:123456789012:CdkrdGoneQueue" ;;
  kinesis/list-streams|dynamodb/list-tables|efs/describe-file-systems|secretsmanager/list-secrets|logs/describe-log-groups) : ;;
  *) : ;;
esac
MOCK
chmod +x "$tmp/aws"

# The sweep exits 1 when it reports unresolved orphans (keeps verify RED) — expected
# here (the tagged resource), so tolerate it; we assert on the OUTPUT. MIN_AGE_HOURS=0
# turns the age guard off for these (they test the name/IAM/tag logic; the age guard
# has its own test below).
out="$(PATH="$tmp:$PATH" AWS_REGION=us-east-1 CDKRD_SWEEP_MIN_AGE_HOURS=0 bash "$SWEEP" 2>&1 || true)"

assert "case-insensitive active-stack protection (lowercased RDS backed by mixed-case stack -> SKIP)" "$out" "SKIP \(active-stack member\): RDS-instance cdkrd717verify-writer-abc123"
assert "IAM role orphan is found (the leaked class)" "$out" "ORPHAN \(dry-run\): IAM-role CdkRealDriftGone-ApiCloudWatchRole-xyz"
assert "generic tag net reports an any-type tagged orphan (no false SWEEP CLEAN)" "$out" "ORPHAN \(needs manual delete.*arn:aws:sqs:.*CdkrdGoneQueue"
assert "summary counts the 2 orphans (IAM + tagged), RDS protected" "$out" "2 orphan\(s\) found"

# negative: with NO token-matching resources, sweep is CLEAN
cat > "$tmp/aws" <<'MOCK'
#!/usr/bin/env bash
case "$1/${2:-}" in cloudformation/list-stacks) echo "SomeUnrelatedStack" ;; *) : ;; esac
MOCK
chmod +x "$tmp/aws"
clean_out="$(PATH="$tmp:$PATH" AWS_REGION=us-east-1 bash "$SWEEP" 2>&1)"
assert "SWEEP CLEAN when nothing token-matches" "$clean_out" "SWEEP CLEAN"

# age guard: a RECENT, name-UNBACKED role (the ImageBuilder truncation/hyphen case that
# name-substring misses) must be PROTECTED as too-young, never swept. Dynamic recent ts.
RECENT="$(date -u -v-1M +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d '1 minute ago' +%Y-%m-%dT%H:%M:%S 2>/dev/null)"
cat > "$tmp/aws" <<MOCK
#!/usr/bin/env bash
case "\$1/\${2:-}" in
  cloudformation/list-stacks) echo "SomeUnrelatedStack" ;;
  iam/list-roles) printf '%s\t%s\n' "CdkRealDriftIntegImageBuilderRi-BuilderRole-abc" "$RECENT" ;;
  *) : ;;
esac
MOCK
chmod +x "$tmp/aws"
age_out="$(PATH="$tmp:$PATH" AWS_REGION=us-east-1 bash "$SWEEP" 2>&1 || true)"
assert "age guard PROTECTS a recent name-unbacked role (ImageBuilder truncation case)" "$age_out" "SKIP \(younger than.*IAM-role CdkRealDriftIntegImageBuilderRi-BuilderRole-abc"
refute "the protected recent role is NOT reported as an orphan" "$age_out" "ORPHAN.*CdkRealDriftIntegImageBuilderRi-BuilderRole-abc"

# layer 1 (authoritative membership): a name-UNBACKED, OLD role (age guard off) is still
# PROTECTED because list-stack-resources reports it as a member of the active stack —
# the truncation case the name-substring guard alone would delete.
cat > "$tmp/aws" <<'MOCK'
#!/usr/bin/env bash
case "$1/${2:-}" in
  cloudformation/list-stacks)          echo "CdkRealDriftIntegImageBuilderRich" ;;
  cloudformation/list-stack-resources) echo "CdkRealDriftIntegImageBuilderRi-BuilderRole-abc" ;; # 64-char truncated member
  iam/list-roles)                      printf '%s\t%s\n' "CdkRealDriftIntegImageBuilderRi-BuilderRole-abc" "2020-01-01T00:00:00+00:00" ;;
  *) : ;;
esac
MOCK
chmod +x "$tmp/aws"
mem_out="$(PATH="$tmp:$PATH" AWS_REGION=us-east-1 CDKRD_SWEEP_MIN_AGE_HOURS=0 bash "$SWEEP" 2>&1 || true)"
assert "layer 1 membership PROTECTS a truncated-name member even when OLD + name-unbacked" "$mem_out" "SKIP \(active-stack member.*IAM-role CdkRealDriftIntegImageBuilderRi-BuilderRole-abc"
refute "the member role is NOT reported as an orphan" "$mem_out" "ORPHAN.*IAM-role CdkRealDriftIntegImageBuilderRi-BuilderRole-abc"

# #1463: a just-deleted EBS volume lingering in the RGT tag index (InvalidVolume.NotFound on a
# direct probe) must fold to the RGT-lag SKIP, never a hard ORPHAN that deadlocks the gate —
# mirroring the vpc-endpoint / instance resource_gone arms.
cat > "$tmp/aws" <<'MOCK'
#!/usr/bin/env bash
case "$1/${2:-}" in
  cloudformation/list-stacks)              echo "SomeUnrelatedStack" ;;
  resourcegroupstaggingapi/get-resources)  printf '%s\tNone\n' "arn:aws:ec2:us-east-1:123456789012:volume/vol-0deadbeef00000000" ;;
  ec2/describe-volumes)                     echo "An error occurred (InvalidVolume.NotFound) when calling the DescribeVolumes operation: The volume 'vol-0deadbeef00000000' does not exist." >&2; exit 255 ;;
  *) : ;;
esac
MOCK
chmod +x "$tmp/aws"
gone_out="$(PATH="$tmp:$PATH" AWS_REGION=us-east-1 bash "$SWEEP" 2>&1 || true)"
assert "#1463 a NotFound EBS volume folds to the RGT-lag SKIP (not ORPHAN)" "$gone_out" "SKIP \(tagged mapping for an already-deleted resource.*volume/vol-0deadbeef00000000"
refute "#1463 the deleted volume is NOT reported as an orphan" "$gone_out" "ORPHAN.*volume/vol-0deadbeef00000000"
assert "#1463 sweep is CLEAN once the phantom volume is folded" "$gone_out" "SWEEP CLEAN"

# #1463 fail-safe: a volume that STILL EXISTS (DescribeVolumes succeeds) is a REAL orphan and must
# stay RED — resource_gone folds ONLY a definitive InvalidVolume.NotFound, never a live volume.
cat > "$tmp/aws" <<'MOCK'
#!/usr/bin/env bash
case "$1/${2:-}" in
  cloudformation/list-stacks)              echo "SomeUnrelatedStack" ;;
  resourcegroupstaggingapi/get-resources)  printf '%s\tNone\n' "arn:aws:ec2:us-east-1:123456789012:volume/vol-0liveaaaa00000000" ;;
  ec2/describe-volumes)                     echo "available" ;;
  *) : ;;
esac
MOCK
chmod +x "$tmp/aws"
live_out="$(PATH="$tmp:$PATH" AWS_REGION=us-east-1 bash "$SWEEP" 2>&1 || true)"
assert "#1463 fail-safe: an EXISTING volume stays a hard ORPHAN (never folded)" "$live_out" "ORPHAN.*volume/vol-0liveaaaa00000000"
refute "#1463 fail-safe: an existing volume is NOT folded to the RGT-lag SKIP" "$live_out" "already-deleted resource.*volume/vol-0liveaaaa00000000"

# 2026-07-12 hunt phantom set: subnet NotFound (RGT lag), ECS task-definition / service
# INACTIVE (kept visible by design), KMS key PendingDeletion (self-resolving debris that
# otherwise deadlocks the gate for the whole deletion window) — all fold to SKIP.
cat > "$tmp/aws" <<'MOCK'
#!/usr/bin/env bash
case "$1/${2:-}" in
  cloudformation/list-stacks)              echo "SomeUnrelatedStack" ;;
  resourcegroupstaggingapi/get-resources)
    printf '%s\tNone\n' "arn:aws:ec2:us-east-1:123456789012:subnet/subnet-0deadbeef0000000a"
    printf '%s\tNone\n' "arn:aws:ecs:us-east-1:123456789012:task-definition/cdkrd-hunt-td:1"
    printf '%s\tNone\n' "arn:aws:ecs:us-east-1:123456789012:service/cdkrd-hunt-cluster/cdkrd-hunt-svc"
    printf '%s\tNone\n' "arn:aws:kms:us-east-1:123456789012:key/00000000-dead-beef-0000-000000000000"
    ;;
  ec2/describe-subnets)                     echo "An error occurred (InvalidSubnetID.NotFound) when calling the DescribeSubnets operation: The subnet ID 'subnet-0deadbeef0000000a' does not exist" >&2; exit 255 ;;
  ecs/describe-task-definition)             echo "INACTIVE" ;;
  ecs/describe-services)                    echo "INACTIVE" ;;
  kms/describe-key)                         echo "PendingDeletion" ;;
  *) : ;;
esac
MOCK
chmod +x "$tmp/aws"
gone2_out="$(PATH="$tmp:$PATH" AWS_REGION=us-east-1 bash "$SWEEP" 2>&1 || true)"
assert "a NotFound subnet folds to the RGT-lag SKIP" "$gone2_out" "SKIP \(tagged mapping for an already-deleted resource.*subnet/subnet-0deadbeef0000000a"
assert "an INACTIVE task definition folds to SKIP" "$gone2_out" "SKIP \(tagged mapping for an already-deleted resource.*task-definition/cdkrd-hunt-td:1"
assert "an INACTIVE service folds to SKIP" "$gone2_out" "SKIP \(tagged mapping for an already-deleted resource.*service/cdkrd-hunt-cluster/cdkrd-hunt-svc"
assert "a PendingDeletion KMS key folds to SKIP" "$gone2_out" "SKIP \(tagged mapping for an already-deleted resource.*key/00000000-dead-beef-0000-000000000000"
assert "sweep is CLEAN once the phantom set is folded" "$gone2_out" "SWEEP CLEAN"

# fail-safe twins: a live subnet / ACTIVE task definition / ACTIVE service / Enabled key
# all stay hard ORPHANs.
cat > "$tmp/aws" <<'MOCK'
#!/usr/bin/env bash
case "$1/${2:-}" in
  cloudformation/list-stacks)              echo "SomeUnrelatedStack" ;;
  resourcegroupstaggingapi/get-resources)
    printf '%s\tNone\n' "arn:aws:ec2:us-east-1:123456789012:subnet/subnet-0liveaaaa0000000a"
    printf '%s\tNone\n' "arn:aws:ecs:us-east-1:123456789012:task-definition/cdkrd-live-td:1"
    printf '%s\tNone\n' "arn:aws:ecs:us-east-1:123456789012:service/cdkrd-live-cluster/cdkrd-live-svc"
    printf '%s\tNone\n' "arn:aws:kms:us-east-1:123456789012:key/11111111-aaaa-bbbb-0000-000000000000"
    ;;
  ec2/describe-subnets)                     echo "subnet-0liveaaaa0000000a" ;;
  ecs/describe-task-definition)             echo "ACTIVE" ;;
  ecs/describe-services)                    echo "ACTIVE" ;;
  kms/describe-key)                         echo "Enabled" ;;
  *) : ;;
esac
MOCK
chmod +x "$tmp/aws"
live2_out="$(PATH="$tmp:$PATH" AWS_REGION=us-east-1 bash "$SWEEP" 2>&1 || true)"
assert "fail-safe: a live subnet stays a hard ORPHAN" "$live2_out" "ORPHAN.*subnet/subnet-0liveaaaa0000000a"
assert "fail-safe: an ACTIVE task definition stays a hard ORPHAN" "$live2_out" "ORPHAN.*task-definition/cdkrd-live-td:1"
assert "fail-safe: an ACTIVE service stays a hard ORPHAN" "$live2_out" "ORPHAN.*service/cdkrd-live-cluster/cdkrd-live-svc"
assert "fail-safe: an Enabled KMS key stays a hard ORPHAN" "$live2_out" "ORPHAN.*key/11111111-aaaa-bbbb-0000-000000000000"

rm -rf "$tmp"
echo "----"
echo "sweep-orphans: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

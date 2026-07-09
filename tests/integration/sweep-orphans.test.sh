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
  iam/list-roles)               echo "CdkRealDriftGone-ApiCloudWatchRole-xyz" ;; # stack gone -> ORPHAN
  iam/list-instance-profiles)   : ;;
  resourcegroupstaggingapi/get-resources) echo "arn:aws:sqs:us-east-1:123456789012:CdkrdGoneQueue" ;;
  kinesis/list-streams|dynamodb/list-tables|efs/describe-file-systems|secretsmanager/list-secrets|logs/describe-log-groups) : ;;
  *) : ;;
esac
MOCK
chmod +x "$tmp/aws"

# The sweep exits 1 when it reports unresolved orphans (keeps verify RED) — expected
# here (the tagged resource), so tolerate it; we assert on the OUTPUT.
out="$(PATH="$tmp:$PATH" AWS_REGION=us-east-1 bash "$SWEEP" 2>&1 || true)"

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

rm -rf "$tmp"
echo "----"
echo "sweep-orphans: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

#!/usr/bin/env bash
# Integration test #564 (real AWS, AWS-mutating): Lex Bot BotLocales STRUCTURAL revert.
#   deploy -> record baseline -> check CLEAN (harvest corpus here)
#   TEST A: delete a whole intent (Greeting) out of band -> check DETECTS -> revert RECREATES it
#   TEST B: add a whole intent (Rogue) out of band     -> check DETECTS -> revert DELETES it
#   throughout, the built-in FallbackIntent is never created or deleted. -> destroy.
# Run with CDKRD_CORPUS_DIR=<dir> to record the golden-corpus case for the CLEAN reconstructed
# BotLocales (AWS__Lex__Bot.Bot.json — a #527 reader regression guard).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE" || exit 1
STACK=CdkRealDriftIntegLexStructural
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
LOC=en_US
# Harvest only at the clean point (not on every check); unset so drift checks don't record.
CORPUS_DIR="${CDKRD_CORPUS_DIR:-}"; unset CDKRD_CORPUS_DIR

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL: $*"; exit 1; }

lex() { aws lexv2-models "$@" --region "$REGION"; }
intent_id() { lex list-intents --bot-id "$BOT" --bot-version DRAFT --locale-id "$LOC" \
  --query "intentSummaries[?intentName=='$1'].intentId | [0]" --output text; }
wait_built() {
  for _ in $(seq 1 90); do
    S=$(lex describe-bot-locale --bot-id "$BOT" --bot-version DRAFT --locale-id "$LOC" \
      --query botLocaleStatus --output text 2>/dev/null || echo "?")
    case "$S" in
      Built|NotBuilt) return 0 ;;
      Failed) echo "locale build FAILED"; return 1 ;;
    esac
    sleep 5
  done
  echo "timed out waiting for locale build"; return 1
}
build_locale() { lex build-bot-locale --bot-id "$BOT" --bot-version DRAFT --locale-id "$LOC" >/dev/null || return 1; sleep 3; wait_built; }

echo "=== build ==="; (cd "$ROOT" && vp run build) || fail build
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy

BOT="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lex::Bot'].PhysicalResourceId" --output text)"
[ -n "$BOT" ] || fail "no bot id"
echo "bot id = $BOT"
wait_built || fail "initial locale not built"

echo "=== record baseline ==="; $CLI record "$STACK" --region "$REGION" --yes || fail record
echo "=== check CLEAN (fresh deploy) ==="
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || { $CLI check "$STACK" --region "$REGION" --show-all; fail "expected CLEAN after record"; }

if [ -n "$CORPUS_DIR" ]; then
  echo "=== harvest corpus (clean reconstructed BotLocales) ==="
  CDKRD_CORPUS_DIR="$CORPUS_DIR" $CLI check "$STACK" --region "$REGION" >/dev/null || true
fi

# ---------------- TEST A: out-of-band DELETE of a whole intent -> revert RECREATES ----------------
echo "=== TEST A: delete Greeting intent out of band ==="
GID="$(intent_id Greeting)"; [ -n "$GID" ] && [ "$GID" != "None" ] || fail "Greeting intent id not found"
lex delete-intent --bot-id "$BOT" --bot-version DRAFT --locale-id "$LOC" --intent-id "$GID" >/dev/null || fail "delete-intent"
build_locale || fail "build after delete"

echo "=== check DETECTS the missing intent ==="
$CLI check "$STACK" --region "$REGION" --show-all | tee /tmp/cdkrd-lex-A-pre.txt
grep -qi "Greeting\|BotLocales" /tmp/cdkrd-lex-A-pre.txt || fail "missing-intent drift not reported"

echo "=== revert --yes (must CreateIntent Greeting) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert A returned non-zero"
wait_built || fail "locale not built after revert A"
RGID="$(intent_id Greeting)"; [ -n "$RGID" ] && [ "$RGID" != "None" ] || fail "Greeting NOT recreated by revert"
echo "Greeting recreated with id $RGID"

echo "=== check CLEAN after revert A ==="
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || { $CLI check "$STACK" --region "$REGION" --show-all; fail "drift remains after revert A"; }

# ---------------- TEST B: out-of-band ADD of a whole intent -> revert DELETES ----------------
echo "=== TEST B: add Rogue intent out of band ==="
lex create-intent --bot-id "$BOT" --bot-version DRAFT --locale-id "$LOC" \
  --intent-name Rogue --sample-utterances '[{"utterance":"rogue one"},{"utterance":"rogue two"}]' >/dev/null || fail "create-intent Rogue"
build_locale || fail "build after add"

echo "=== check DETECTS the extra intent ==="
$CLI check "$STACK" --region "$REGION" --show-all | tee /tmp/cdkrd-lex-B-pre.txt
grep -qi "Rogue\|BotLocales" /tmp/cdkrd-lex-B-pre.txt || fail "extra-intent drift not reported"

echo "=== revert --yes (must DeleteIntent Rogue) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert B returned non-zero"
wait_built || fail "locale not built after revert B"
BGID="$(intent_id Rogue)"
[ -z "$BGID" ] || [ "$BGID" = "None" ] || fail "Rogue NOT deleted by revert (id=$BGID)"
echo "Rogue deleted"

echo "=== FallbackIntent survived both reverts ==="
FID="$(intent_id FallbackIntent)"; [ -n "$FID" ] && [ "$FID" != "None" ] || fail "FallbackIntent was destroyed"
echo "FallbackIntent intact (id $FID)"

echo "=== check CLEAN after revert B ==="
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || { $CLI check "$STACK" --region "$REGION" --show-all; fail "drift remains after revert B"; }

echo "INTEG PASS: lex-structural (#564)"

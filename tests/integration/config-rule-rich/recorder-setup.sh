#!/usr/bin/env bash
# Shared AWS Config recorder/delivery-channel bootstrap for the config-rule-rich
# fixture. The CFn-native AWS::Config::ConfigurationRecorder hits a create-time
# stabilization deadlock (it waits to be "recording", which needs a delivery channel
# ordered after it), so the recorder + channel are provisioned here via the SDK
# instead. A ConfigRule cannot exist without an active recorder. Account-singleton:
# these are torn down by teardown_recorder so the account is left as found.
export AWS_CLI_AUTO_PROMPT=off

CONF_ROLE=cdkrd-config-recorder-role
CONF_REC=cdkrd-config-recorder
CONF_CHAN=cdkrd-config-channel

setup_recorder() {
  local region="$1"
  local account bucket
  account="$(aws sts get-caller-identity --query Account --output text)"
  bucket="cdkrd-config-${account}-${region}"

  aws iam create-role --role-name "$CONF_ROLE" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"config.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    >/dev/null 2>&1 || true
  aws iam attach-role-policy --role-name "$CONF_ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWS_ConfigRole >/dev/null 2>&1 || true

  aws s3api create-bucket --bucket "$bucket" --region "$region" >/dev/null 2>&1 || true
  cat > /tmp/cdkrd-config-bucket-policy.json <<JSON
{ "Version": "2012-10-17", "Statement": [
  { "Sid": "AWSConfigBucketPermissionsCheck", "Effect": "Allow",
    "Principal": { "Service": "config.amazonaws.com" },
    "Action": ["s3:GetBucketAcl","s3:ListBucket"], "Resource": "arn:aws:s3:::${bucket}" },
  { "Sid": "AWSConfigBucketDelivery", "Effect": "Allow",
    "Principal": { "Service": "config.amazonaws.com" },
    "Action": "s3:PutObject", "Resource": "arn:aws:s3:::${bucket}/AWSLogs/${account}/Config/*",
    "Condition": { "StringEquals": { "s3:x-amz-acl": "bucket-owner-full-control" } } } ] }
JSON
  aws s3api put-bucket-policy --bucket "$bucket" --policy file:///tmp/cdkrd-config-bucket-policy.json >/dev/null
  # IAM eventual consistency before Config assumes the role
  sleep 10
  # JSON (not CLI shorthand): the shorthand coerces recordingGroup.allSupported to the
  # string "false", which fails parameter validation.
  cat > /tmp/cdkrd-config-recorder.json <<JSON
{ "name": "${CONF_REC}", "roleARN": "arn:aws:iam::${account}:role/${CONF_ROLE}",
  "recordingGroup": { "allSupported": false, "includeGlobalResourceTypes": false, "resourceTypes": ["AWS::IAM::User"] } }
JSON
  aws configservice put-configuration-recorder --region "$region" \
    --configuration-recorder "file:///tmp/cdkrd-config-recorder.json" >/dev/null
  aws configservice put-delivery-channel --region "$region" \
    --delivery-channel "name=${CONF_CHAN},s3BucketName=${bucket}" >/dev/null
  aws configservice start-configuration-recorder --region "$region" \
    --configuration-recorder-name "$CONF_REC" >/dev/null
}

teardown_recorder() {
  local region="$1"
  local account bucket
  account="$(aws sts get-caller-identity --query Account --output text)"
  bucket="cdkrd-config-${account}-${region}"
  aws configservice stop-configuration-recorder --region "$region" --configuration-recorder-name "$CONF_REC" >/dev/null 2>&1 || true
  aws configservice delete-delivery-channel --region "$region" --delivery-channel-name "$CONF_CHAN" >/dev/null 2>&1 || true
  aws configservice delete-configuration-recorder --region "$region" --configuration-recorder-name "$CONF_REC" >/dev/null 2>&1 || true
  aws s3 rm "s3://${bucket}" --recursive >/dev/null 2>&1 || true
  aws s3api delete-bucket --bucket "$bucket" --region "$region" >/dev/null 2>&1 || true
  aws iam detach-role-policy --role-name "$CONF_ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWS_ConfigRole >/dev/null 2>&1 || true
  aws iam delete-role --role-name "$CONF_ROLE" >/dev/null 2>&1 || true
}

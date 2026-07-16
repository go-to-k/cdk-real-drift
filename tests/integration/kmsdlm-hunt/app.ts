// Barest-variant first-run FP probe (real AWS), two axes never exercised live.
// DETERMINATIONS (live, 2026-07-17, us-east-1): KMS folds clean across ALL four key
// variants (the symmetric-centric KNOWN_DEFAULTS pins are equality-gated, so the
// asymmetric/HMAC shapes — which DECLARE KeySpec/KeyUsage — never hit them; the naked
// key's default key policy folds too). DLM first-ran THREE bugs: #1663 (undeclared
// interval CreateRule.Times materialization + shorthand RetainInterval=7), #1665
// (DefaultPolicy readGap blocked snapshot-completeness → appeared-since-record was
// silently disabled), #1666 (RetainInterval revert no-op: RSDP + top-level shorthand
// Update params). verify-detect.sh live-proves detection + revert convergence.
// Follow-up #1668: a default policy with NO shorthand key declared (the
// DefaultPolicyInstance shape below) fell into the reader's custom branch and FP'd a
// whole-object PolicyDetails; DefaultPolicy===true now forces shorthand projection
// (CreateInterval joins KNOWN_DEFAULTS + RSDP; detect→revert→converge live-proven).
// - AWS::KMS::Key non-symmetric variants: every existing fixture/corpus key is
//   symmetric (KNOWN_DEFAULTS pins KeySpec=SYMMETRIC_DEFAULT / KeyUsage=ENCRYPT_DECRYPT
//   around that shape). Asymmetric RSA/ECC sign-verify keys and HMAC keys cannot
//   rotate and carry different KeySpec/KeyUsage, so the symmetric-centric folds are
//   unguarded here. Key4 is a fully naked symmetric key (no KeyPolicy declared) to
//   probe the default-key-policy echo too.
// - AWS::DLM::LifecyclePolicy: the SDK-override reader + writer have corpus cases but
//   ZERO live fixtures — both projection styles (custom PolicyDetails vs the
//   default-policy top-level shorthand, DLM_DEFAULT_POLICY_SHORTHAND) and the #1362
//   map->list Tags projection never ran against a real deploy.
// Stack A carries the KMS keys (safe), stack B the DLM pair (riskier create-time
// validation), so one failure cannot roll back the other probe.
import { App, Stack, Tags } from "aws-cdk-lib";
import { CfnLifecyclePolicy } from "aws-cdk-lib/aws-dlm";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnKey } from "aws-cdk-lib/aws-kms";

const app = new App();
Tags.of(app).add("cdkrd:ephemeral", "1");
const rev = app.node.tryGetContext("rev");
if (rev) Tags.of(app).add("cdkrd:rev", String(rev));

// ---------------------------------------------------------------- stack A: KMS
const a = new Stack(app, "CdkrdHunt0717KmsA");

// Asymmetric RSA sign/verify — KeySpec+KeyUsage are the create-time minimum.
new CfnKey(a, "RsaSignKey", {
  keySpec: "RSA_2048",
  keyUsage: "SIGN_VERIFY",
});
// Asymmetric ECC sign/verify.
new CfnKey(a, "EccSignKey", {
  keySpec: "ECC_NIST_P256",
  keyUsage: "SIGN_VERIFY",
});
// HMAC generate/verify.
new CfnKey(a, "HmacKey", {
  keySpec: "HMAC_256",
  keyUsage: "GENERATE_VERIFY_MAC",
});
// Fully naked symmetric control: KeyPolicy undeclared — probes the default
// key policy echo (a deterministic f(account) document).
new CfnKey(a, "NakedKey", {});

// ---------------------------------------------------------------- stack B: DLM
const b = new Stack(app, "CdkrdHunt0717DlmB");

const dlmRole = new Role(b, "DlmRole", {
  assumedBy: new ServicePrincipal("dlm.amazonaws.com"),
  managedPolicies: [
    ManagedPolicy.fromAwsManagedPolicyName(
      "service-role/AWSDataLifecycleManagerServiceRole"
    ),
  ],
});

// Custom policy — full PolicyDetails projection path.
new CfnLifecyclePolicy(b, "CustomPolicy", {
  description: "cdkrd hunt 0717 custom snapshot policy",
  executionRoleArn: dlmRole.roleArn,
  state: "ENABLED",
  policyDetails: {
    policyType: "EBS_SNAPSHOT_MANAGEMENT",
    resourceTypes: ["VOLUME"],
    targetTags: [{ key: "cdkrd-hunt", value: "0717" }],
    schedules: [
      {
        name: "cdkrd-hunt-daily",
        createRule: { interval: 12, intervalUnit: "HOURS" },
        retainRule: { count: 1 },
      },
    ],
  },
});

// Default-policy shorthand — the usesShorthand projection path. CreateInterval is
// declared to select the shorthand branch; RetainInterval/CopyTags/ExtendDeletion
// stay undeclared to probe their defaults. Description AND State are REQUIRED for
// the default-policy form too (live-determined: DLM rejects the create without each).
new CfnLifecyclePolicy(b, "DefaultPolicy", {
  defaultPolicy: "VOLUME",
  description: "cdkrd hunt 0717 default policy shorthand",
  state: "ENABLED",
  executionRoleArn: dlmRole.roleArn,
  createInterval: 1,
});

// Barest default policy with NO shorthand keys declared — only the live-required
// Description/State + role (CreateInterval etc. all omitted). Probes the reader's
// usesShorthand=false branch for a DEFAULT policy (the prior two policies both
// declare a shorthand key), plus the INSTANCE variant axis (VOLUME above).
new CfnLifecyclePolicy(b, "DefaultPolicyInstance", {
  defaultPolicy: "INSTANCE",
  description: "cdkrd hunt 0717b default policy instance barest",
  state: "ENABLED",
  executionRoleArn: dlmRole.roleArn,
});

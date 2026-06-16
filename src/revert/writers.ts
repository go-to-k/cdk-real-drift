// Type-specific SDK writers for revert of Cloud-Control-unwritable types. Each
// reads the current model (reusing the override READER), applies the revert ops to
// reconstruct the DESIRED full value, then writes it back with the resource's own
// SDK. Covers the policy-document types (the common revert) plus IAM ManagedPolicy
// (revert the default version's document).
//
// Still not-revertable by design (no SDK writer here):
//   - AWS::Lambda::Permission: an ADD/REMOVE statement model keyed by StatementId
//     (AddPermission/RemovePermission), NOT a settable whole-document property. A
//     generic ops-based revert would have to diff the resource policy statements
//     and add/remove each individually; the override READER only returns a thin
//     best-effort match (FunctionName/Action/Principal, no StatementId / SourceArn
//     / SourceAccount / EventSourceToken), so we cannot reconstruct the exact
//     statement to re-add nor safely identify the one to remove. Reverting it
//     blindly risks dropping or duplicating unrelated grants -> left not-revertable.
//   - AWS::Budgets::Budget: UpdateBudget requires a FULL NewBudget object
//     (BudgetLimit/PlannedBudgetLimits + BudgetName + TimeUnit + BudgetType, and it
//     overwrites CostFilters / CostTypes / notifications wholesale). The override
//     READER returns only the scalar identity subset (BudgetName / BudgetType /
//     TimeUnit) — no BudgetLimit / CostFilters / CostTypes — so a desiredModel
//     reconstruction would be missing the required limit and would wipe the cost
//     filters/types on write. Too divergent from the reader to revert safely ->
//     left not-revertable.
import {
  ElasticLoadBalancingV2Client,
  ModifyLoadBalancerAttributesCommand,
  ModifyTargetGroupAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  CreatePolicyVersionCommand,
  DeletePolicyVersionCommand,
  DeleteRolePolicyCommand,
  IAMClient,
  ListPolicyVersionsCommand,
  PutGroupPolicyCommand,
  PutRolePolicyCommand,
  PutUserPolicyCommand,
} from '@aws-sdk/client-iam';
import { DeleteBucketPolicyCommand, PutBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';
import { SetTopicAttributesCommand, SNSClient } from '@aws-sdk/client-sns';
import { SetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { canonicalizeForCompare } from '../normalize/pipeline.js';
import { type OverrideCtx, SDK_OVERRIDES } from '../read/overrides.js';
import { applyOps } from './apply-ops.js';
import type { PatchOp } from './plan.js';

export type SdkWriter = (ctx: OverrideCtx, ops: PatchOp[]) => Promise<void>;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const firstStr = (v: unknown): string | undefined => (Array.isArray(v) ? str(v[0]) : str(v));

// reconstruct the desired full model = current (read back) with revert ops applied
async function desiredModel(
  type: string,
  ctx: OverrideCtx,
  ops: PatchOp[]
): Promise<Record<string, unknown>> {
  const reader = SDK_OVERRIDES[type];
  const current = (reader && (await reader(ctx))) ?? {};
  // A revert op path indexes the model classify COMPARED — which is canonicalized
  // (canonicalizePolicy SORTS the Statement array, reshapes Action/Resource, …). But the
  // override reader returns the RAW live document, whose statement order can differ. An
  // op like `…/Statement/1/Resource` would then land on a DIFFERENT statement than the
  // one classify found drifted — corrupting an unrelated statement and leaving the real
  // drift unreverted (a security-relevant wrong write). Canonicalize the current
  // PolicyDocument the same way so an indexed op hits the SAME statement; the written
  // doc is the canonical (statement-sorted, AWS-equivalent) form of the declared intent.
  const aligned =
    current.PolicyDocument === undefined
      ? current
      : { ...current, PolicyDocument: canonicalizeForCompare(current.PolicyDocument) };
  return applyOps(aligned, ops);
}
const policyJson = (m: Record<string, unknown>): string | undefined =>
  m.PolicyDocument === undefined ? undefined : JSON.stringify(m.PolicyDocument);

const writeS3BucketPolicy: SdkWriter = async (ctx, ops) => {
  const bucket = str(ctx.declared['Bucket']);
  if (!bucket) throw new Error('cannot resolve bucket for revert');
  const desired = policyJson(await desiredModel('AWS::S3::BucketPolicy', ctx, ops));
  const c = new S3Client({ region: ctx.region });
  if (desired === undefined) await c.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
  else await c.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: desired }));
};

const writeSnsTopicPolicy: SdkWriter = async (ctx, ops) => {
  const topic = firstStr(ctx.declared['Topics']);
  if (!topic) throw new Error('cannot resolve topic for revert');
  const desired = policyJson(await desiredModel('AWS::SNS::TopicPolicy', ctx, ops)) ?? '';
  await new SNSClient({ region: ctx.region }).send(
    new SetTopicAttributesCommand({
      TopicArn: topic,
      AttributeName: 'Policy',
      AttributeValue: desired,
    })
  );
};

const writeSqsQueuePolicy: SdkWriter = async (ctx, ops) => {
  const queue = firstStr(ctx.declared['Queues']);
  if (!queue) throw new Error('cannot resolve queue for revert');
  const desired = policyJson(await desiredModel('AWS::SQS::QueuePolicy', ctx, ops)) ?? '';
  await new SQSClient({ region: ctx.region }).send(
    new SetQueueAttributesCommand({ QueueUrl: queue, Attributes: { Policy: desired } })
  );
};

const writeIamPolicy: SdkWriter = async (ctx, ops) => {
  const name = str(ctx.declared['PolicyName']);
  if (!name) throw new Error('cannot resolve policy name for revert');
  const desired = policyJson(await desiredModel('AWS::IAM::Policy', ctx, ops));
  if (desired === undefined) throw new Error('cannot revert an IAM inline policy to absent');
  const c = new IAMClient({ region: ctx.region });
  const role = firstStr(ctx.declared['Roles']);
  const user = firstStr(ctx.declared['Users']);
  const group = firstStr(ctx.declared['Groups']);
  if (role)
    await c.send(
      new PutRolePolicyCommand({ RoleName: role, PolicyName: name, PolicyDocument: desired })
    );
  else if (user)
    await c.send(
      new PutUserPolicyCommand({ UserName: user, PolicyName: name, PolicyDocument: desired })
    );
  else if (group)
    await c.send(
      new PutGroupPolicyCommand({ GroupName: group, PolicyName: name, PolicyDocument: desired })
    );
  else throw new Error('IAM policy has no role/user/group target');
};

// IAM managed policies are versioned: a "settable" PolicyDocument lives in the
// default version, and a policy can hold at most 5 versions. To revert we create a
// NEW version (SetAsDefault) carrying the desired document; if 5 already exist we
// first delete the oldest NON-default version to make room.
const isArn = (v: unknown): string | undefined => {
  const s = str(v);
  return s && s.startsWith('arn:') ? s : undefined;
};
const writeIamManagedPolicy: SdkWriter = async (ctx, ops) => {
  // CFn physical id for a managed policy IS its arn; fall back to the declared
  // ManagedPolicyArn when the physical id isn't (yet) the arn shape.
  const arn = isArn(ctx.physicalId) ?? isArn(ctx.declared['ManagedPolicyArn']);
  if (!arn) throw new Error('cannot resolve managed policy arn for revert');
  const desired = policyJson(await desiredModel('AWS::IAM::ManagedPolicy', ctx, ops));
  if (desired === undefined)
    throw new Error('cannot revert a managed policy to an absent document');
  const c = new IAMClient({ region: ctx.region });

  const versions = (await c.send(new ListPolicyVersionsCommand({ PolicyArn: arn }))).Versions ?? [];
  if (versions.length >= 5) {
    const oldest = versions
      .filter((v) => !v.IsDefaultVersion && v.VersionId)
      .sort((a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0))[0];
    if (oldest?.VersionId)
      await c.send(new DeletePolicyVersionCommand({ PolicyArn: arn, VersionId: oldest.VersionId }));
  }
  await c.send(
    new CreatePolicyVersionCommand({ PolicyArn: arn, PolicyDocument: desired, SetAsDefault: true })
  );
};

// Inline Policies on an IAM Role, reverted PER ENTRY (PutRolePolicy /
// DeleteRolePolicy by PolicyName) instead of a whole-property Cloud Control patch:
// a CC `remove /Policies` would also wipe the sibling-AWS::IAM::Policy entries
// (the CDK DefaultPolicy) that classify filtered OUT of the finding. Each op
// carries the finding's current live subset in `prior` (set by plan.ts); the
// desired subset is `value` for an add (baseline restore), empty for a remove.
// Entries in prior but not desired are deleted; every desired entry is (re)put.
interface InlinePolicy {
  PolicyName: string;
  PolicyDocument: unknown;
}
const asInlinePolicies = (v: unknown): InlinePolicy[] =>
  Array.isArray(v)
    ? v.filter(
        (p): p is InlinePolicy =>
          !!p && typeof p === 'object' && typeof (p as InlinePolicy).PolicyName === 'string'
      )
    : [];

const writeIamRoleInlinePolicies: SdkWriter = async (ctx, ops) => {
  const role = str(ctx.physicalId); // an AWS::IAM::Role physical id IS the role name
  if (!role) throw new Error('cannot resolve role name for revert');
  const c = new IAMClient({ region: ctx.region });
  for (const op of ops) {
    if (op.path !== '/Policies')
      throw new Error(`unsupported inline-policy revert path: ${op.path}`);
    const desired = op.op === 'add' ? asInlinePolicies(op.value) : [];
    const keep = new Set(desired.map((p) => p.PolicyName));
    for (const p of asInlinePolicies(op.prior)) {
      if (!keep.has(p.PolicyName))
        await c.send(new DeleteRolePolicyCommand({ RoleName: role, PolicyName: p.PolicyName }));
    }
    for (const p of desired) {
      await c.send(
        new PutRolePolicyCommand({
          RoleName: role,
          PolicyName: p.PolicyName,
          PolicyDocument: JSON.stringify(p.PolicyDocument),
        })
      );
    }
  }
};

// ELB attribute bags (LoadBalancerAttributes / TargetGroupAttributes), reverted
// PER ATTRIBUTE via Modify*AttributesCommand instead of a whole-property Cloud
// Control patch (R78): the CC index patch misaligns against the full live bag
// (~23 entries) and ELB rejects a modify carrying >20 attributes. Each op carries
// the changed attribute's Key (op.attributeKey) and the desired Value (op.value),
// so we send ONLY the declared attributes — a partial, merge-style update that
// leaves every other live attribute untouched. The ELB physical id IS the ARN.
const elbAttributeOps = (ops: PatchOp[]): { Key: string; Value: string }[] =>
  ops
    .filter((o) => o.attributeKey !== undefined)
    .map((o) => ({ Key: o.attributeKey as string, Value: String(o.value) }));

const writeElbLoadBalancerAttributes: SdkWriter = async (ctx, ops) => {
  const arn = str(ctx.physicalId);
  if (!arn) throw new Error('cannot resolve load balancer arn for revert');
  const attrs = elbAttributeOps(ops);
  if (attrs.length === 0) return;
  await new ElasticLoadBalancingV2Client({ region: ctx.region }).send(
    new ModifyLoadBalancerAttributesCommand({ LoadBalancerArn: arn, Attributes: attrs })
  );
};

const writeElbTargetGroupAttributes: SdkWriter = async (ctx, ops) => {
  const arn = str(ctx.physicalId);
  if (!arn) throw new Error('cannot resolve target group arn for revert');
  const attrs = elbAttributeOps(ops);
  if (attrs.length === 0) return;
  await new ElasticLoadBalancingV2Client({ region: ctx.region }).send(
    new ModifyTargetGroupAttributesCommand({ TargetGroupArn: arn, Attributes: attrs })
  );
};

export const SDK_WRITERS: Record<string, SdkWriter> = {
  'AWS::S3::BucketPolicy': writeS3BucketPolicy,
  'AWS::SNS::TopicPolicy': writeSnsTopicPolicy,
  'AWS::SQS::QueuePolicy': writeSqsQueuePolicy,
  'AWS::IAM::Policy': writeIamPolicy,
  'AWS::IAM::ManagedPolicy': writeIamManagedPolicy,
};

// Property-scoped SDK writers: CC-writable types where ONE property must be
// reverted via the type's own SDK instead of a Cloud Control patch. Keyed by
// resource type -> EXACT top-level finding path. Deeper paths (e.g. a declared
// drift at Policies.0...) still go through Cloud Control as before.
export const SDK_PROP_WRITERS: Record<string, Record<string, SdkWriter>> = {
  'AWS::IAM::Role': { Policies: writeIamRoleInlinePolicies },
  'AWS::ElasticLoadBalancingV2::LoadBalancer': {
    LoadBalancerAttributes: writeElbLoadBalancerAttributes,
  },
  'AWS::ElasticLoadBalancingV2::TargetGroup': {
    TargetGroupAttributes: writeElbTargetGroupAttributes,
  },
};

/** Resolve the SDK writer for a kind='sdk' revert item: the whole-type writer, or
 *  the property-scoped writer matching the item's ops (all ops in a prop-scoped
 *  item share one top-level pointer — plan.ts groups by exact finding path). */
export function resolveSdkWriter(resourceType: string, ops: PatchOp[]): SdkWriter | undefined {
  const whole = SDK_WRITERS[resourceType];
  if (whole) return whole;
  const byProp = SDK_PROP_WRITERS[resourceType];
  const top = ops[0]?.path.split('/')[1]?.replace(/~1/g, '/').replace(/~0/g, '~');
  return byProp && top ? byProp[top] : undefined;
}

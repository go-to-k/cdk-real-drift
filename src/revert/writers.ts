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
  CloudFrontClient,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import { DocDBClient, ModifyDBClusterCommand } from '@aws-sdk/client-docdb';
import { GetJobCommand, GlueClient, UpdateJobCommand } from '@aws-sdk/client-glue';
import {
  GetWebACLCommand,
  type Scope,
  UpdateWebACLCommand,
  WAFV2Client,
} from '@aws-sdk/client-wafv2';
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
import {
  ServiceDiscoveryClient,
  UpdateHttpNamespaceCommand,
} from '@aws-sdk/client-servicediscovery';
import { SetTopicAttributesCommand, SNSClient } from '@aws-sdk/client-sns';
import { SetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { canonicalizeForCompare } from '../normalize/pipeline.js';
import { type OverrideCtx, SDK_OVERRIDES } from '../read/overrides.js';
import { applyOps } from './apply-ops.js';
import type { PatchOp } from './plan.js';

export type SdkWriter = (ctx: OverrideCtx, ops: PatchOp[]) => Promise<void>;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
// Every non-empty string in v (an array of targets, or a single scalar). A policy
// resource can attach to MORE THAN ONE target (an AWS::IAM::Policy on several Roles,
// an SNS TopicPolicy spanning several Topics) — revert must write to ALL of them, or
// the drift silently persists on every target after the first while the run reports
// "reverted".
const strList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).map(str).filter((s): s is string => s !== undefined);

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
  const topics = strList(ctx.declared['Topics']);
  if (topics.length === 0) throw new Error('cannot resolve topic for revert');
  const desired = policyJson(await desiredModel('AWS::SNS::TopicPolicy', ctx, ops)) ?? '';
  const c = new SNSClient({ region: ctx.region });
  // A TopicPolicy can attach to several Topics — set the policy on every one.
  for (const topic of topics) {
    await c.send(
      new SetTopicAttributesCommand({
        TopicArn: topic,
        AttributeName: 'Policy',
        AttributeValue: desired,
      })
    );
  }
};

const writeSqsQueuePolicy: SdkWriter = async (ctx, ops) => {
  const queues = strList(ctx.declared['Queues']);
  if (queues.length === 0) throw new Error('cannot resolve queue for revert');
  const desired = policyJson(await desiredModel('AWS::SQS::QueuePolicy', ctx, ops)) ?? '';
  const c = new SQSClient({ region: ctx.region });
  // A QueuePolicy can attach to several Queues — set the policy on every one.
  for (const queue of queues) {
    await c.send(
      new SetQueueAttributesCommand({ QueueUrl: queue, Attributes: { Policy: desired } })
    );
  }
};

const writeIamPolicy: SdkWriter = async (ctx, ops) => {
  const name = str(ctx.declared['PolicyName']);
  if (!name) throw new Error('cannot resolve policy name for revert');
  const desired = policyJson(await desiredModel('AWS::IAM::Policy', ctx, ops));
  if (desired === undefined) throw new Error('cannot revert an IAM inline policy to absent');
  const c = new IAMClient({ region: ctx.region });
  // An AWS::IAM::Policy can attach to ANY combination of Roles, Users and Groups, and
  // to several of each — the same inline policy is put on every one. Reverting only the
  // first target (the old behavior) left the drift in place on every other attachment
  // while reporting success.
  const roles = strList(ctx.declared['Roles']);
  const users = strList(ctx.declared['Users']);
  const groups = strList(ctx.declared['Groups']);
  if (roles.length + users.length + groups.length === 0)
    throw new Error('IAM policy has no role/user/group target');
  for (const role of roles)
    await c.send(
      new PutRolePolicyCommand({ RoleName: role, PolicyName: name, PolicyDocument: desired })
    );
  for (const user of users)
    await c.send(
      new PutUserPolicyCommand({ UserName: user, PolicyName: name, PolicyDocument: desired })
    );
  for (const group of groups)
    await c.send(
      new PutGroupPolicyCommand({ GroupName: group, PolicyName: name, PolicyDocument: desired })
    );
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

// AWS::ServiceDiscovery::HttpNamespace — Cloud Control cannot read OR write this
// type (UnsupportedActionException), so revert goes through Cloud Map's own
// UpdateHttpNamespace, whose ONLY mutable field is Description (Name is immutable).
// Reconstruct the desired model (current read + revert ops) and write its Description
// back. (Sibling AWS::ServiceDiscovery::Service is intentionally NOT revertable: a
// service in an HTTP/API-only namespace cannot be updated at all — UpdateService
// throws InvalidInput "Service in API-only namespace cannot be updated" — so there is
// nothing to revert; a DNS-namespace service writer can be added if a real gap surfaces.)
const writeServiceDiscoveryHttpNamespace: SdkWriter = async (ctx, ops) => {
  const id = str(ctx.physicalId);
  if (!id) throw new Error('cannot resolve namespace id for revert');
  const m = await desiredModel('AWS::ServiceDiscovery::HttpNamespace', ctx, ops);
  await new ServiceDiscoveryClient({ region: ctx.region }).send(
    new UpdateHttpNamespaceCommand({
      Id: id,
      Namespace: { Description: (str(m.Description) ?? '') as string },
    })
  );
};

// AWS::DocDB::DBCluster — Cloud Control cannot read OR write this type
// (UnsupportedActionException), so revert goes through DocDB's own ModifyDBCluster.
// ModifyDBCluster is a PARTIAL update (only the supplied fields change), so we send
// ONLY the drifted top-level props that are in the safe-to-modify allowlist below —
// re-asserting unchanged props would be a no-op but is avoided to keep the call
// minimal. ApplyImmediately so the revert converges on the next read. EngineVersion is
// intentionally NOT in the allowlist (a version write can trigger an upgrade); a
// declared EngineVersion drift stays not-revertable rather than risk a major upgrade.
// (Sibling AWS::DocDB::DBInstance is read-only/not-revertable for now — its common
// mutable prop, DBInstanceClass, is a resize that can be added if a real gap surfaces.)
const DOCDB_CLUSTER_MODIFY_PARAMS = new Set([
  'BackupRetentionPeriod',
  'PreferredBackupWindow',
  'PreferredMaintenanceWindow',
  'Port',
  'DeletionProtection',
]);
const writeDocDbCluster: SdkWriter = async (ctx, ops) => {
  const id = str(ctx.physicalId) ?? str(ctx.declared['DBClusterIdentifier']);
  if (!id) throw new Error('cannot resolve DB cluster identifier for revert');
  const desired = await desiredModel('AWS::DocDB::DBCluster', ctx, ops);
  const input: { DBClusterIdentifier: string; ApplyImmediately: boolean; [k: string]: unknown } = {
    DBClusterIdentifier: id,
    ApplyImmediately: true,
  };
  let any = false;
  for (const op of ops) {
    const top = op.path.replace(/^\//, '').split('/')[0];
    if (top && DOCDB_CLUSTER_MODIFY_PARAMS.has(top) && desired[top] !== undefined) {
      input[top] = desired[top];
      any = true;
    }
  }
  if (!any) return;
  await new DocDBClient({ region: ctx.region }).send(new ModifyDBClusterCommand(input));
};

// AWS::CloudFront::Distribution — Cloud Control CAN read this type, but its
// UpdateResource REJECTS even a minimal single-property patch: applying the patch
// re-validates the WHOLE distribution and the default ViewerCertificate
// representation trips "IamCertificateId or AcmCertificateArn can be specified only
// if SslSupportMethod must also be specified and vice-versa" (proven live — EVERY
// CloudFront revert failed). Route revert through CloudFront's own GetDistributionConfig
// -> apply ops -> UpdateDistribution(IfMatch=ETag) instead: a full-config round-trip
// re-submits AWS's own ViewerCertificate verbatim, so it validates. The revert ops are
// CFn-pointer paths (`/DistributionConfig/<prop>`); applying a SCALAR op to the freshly
// read SDK config touches only that property, so the CFn-vs-SDK array-shape difference
// (Origins as `[...]` vs `{Quantity,Items}`) is irrelevant for the common scalar drifts
// (Comment / DefaultRootObject / Enabled / PriceClass / HttpVersion / WebACLId / …).
const writeCloudFrontDistribution: SdkWriter = async (ctx, ops) => {
  const id = str(ctx.physicalId);
  if (!id) throw new Error('cannot resolve distribution id for revert');
  const c = new CloudFrontClient({ region: ctx.region });
  const cur = await c.send(new GetDistributionConfigCommand({ Id: id }));
  if (!cur.DistributionConfig || !cur.ETag)
    throw new Error('could not read current distribution config for revert');
  const reverted = applyOps({ DistributionConfig: cur.DistributionConfig }, ops) as {
    DistributionConfig: Record<string, unknown>;
  };
  await c.send(
    new UpdateDistributionCommand({
      Id: id,
      IfMatch: cur.ETag,
      // the SDK DistributionConfig shape is preserved verbatim except for the scalar
      // properties the revert ops set, so it round-trips validly.
      DistributionConfig: reverted.DistributionConfig as never,
    })
  );
};

// AWS::WAFv2::WebACL — Cloud Control CAN read this type, but its UpdateResource
// REJECTS a property patch: applying the patch re-validates the WHOLE WebACL against
// the CFn schema, and AWS's own live `Description: ""` (empty when none was set) fails
// the schema's Description pattern constraint — "#/Description: failed validation
// constraint for keyword [pattern]" (proven live; the same CC re-validation class as
// CloudFront). Route revert through WAFv2's own GetWebACL -> apply ops -> UpdateWebACL
// (Name|Id|Scope physical id + LockToken). update-web-acl accepts the absence of
// Description, so OMIT an empty/invalid one; every other updatable field is re-sent
// verbatim so nothing is dropped.
const WAF_UPDATABLE_PASSTHROUGH = [
  'Rules',
  'CustomResponseBodies',
  'CaptchaConfig',
  'ChallengeConfig',
  'TokenDomains',
  'AssociationConfig',
  'DataProtectionConfig',
  'OnSourceDDoSProtectionConfig',
  'ApplicationConfig',
  'MonetizationConfig',
] as const;
const writeWafv2WebAcl: SdkWriter = async (ctx, ops) => {
  const [name, id, scope] = (str(ctx.physicalId) ?? '').split('|');
  if (!name || !id || !scope) throw new Error('cannot resolve WebACL Name|Id|Scope for revert');
  const c = new WAFV2Client({ region: ctx.region });
  const cur = await c.send(new GetWebACLCommand({ Name: name, Id: id, Scope: scope as Scope }));
  if (!cur.WebACL || !cur.LockToken) throw new Error('could not read current WebACL for revert');
  const m = applyOps(cur.WebACL as unknown as Record<string, unknown>, ops);
  const desc = m.Description;
  await c.send(
    new UpdateWebACLCommand({
      Name: name,
      Id: id,
      Scope: scope as Scope,
      LockToken: cur.LockToken,
      DefaultAction: m.DefaultAction as never,
      VisibilityConfig: m.VisibilityConfig as never,
      // OMIT an empty Description — AWS returns "" but the schema pattern rejects it.
      ...(typeof desc === 'string' && desc.length > 0 ? { Description: desc } : {}),
      ...Object.fromEntries(
        WAF_UPDATABLE_PASSTHROUGH.filter((k) => m[k] !== undefined).map((k) => [k, m[k]])
      ),
    } as never)
  );
};

// AWS::Glue::Job — Cloud Control CAN read this type, but its UpdateResource REJECTS a
// property patch when the job uses WorkerType + NumberOfWorkers: AWS ALSO returns a
// computed `MaxCapacity` (and the deprecated `AllocatedCapacity`) on read, and
// re-submitting BOTH MaxCapacity and WorkerType fails "Please do not set Max Capacity
// if using Worker Type and Number of Workers" (proven live; the same CC-revalidation
// class as CloudFront/WAFv2). Route revert through Glue's own GetJob -> apply ops ->
// UpdateJob, OMITTING MaxCapacity/AllocatedCapacity when WorkerType is set (update-job
// accepts their absence). Read-only fields (CreatedOn / LastModifiedOn / Name) are not
// part of JobUpdate and are dropped by the explicit field copy.
const GLUE_JOB_UPDATE_FIELDS = [
  'JobMode',
  'JobRunQueuingEnabled',
  'Description',
  'LogUri',
  'Role',
  'ExecutionProperty',
  'Command',
  'DefaultArguments',
  'NonOverridableArguments',
  'Connections',
  'MaxRetries',
  'Timeout',
  'WorkerType',
  'NumberOfWorkers',
  'SecurityConfiguration',
  'NotificationProperty',
  'GlueVersion',
  'CodeGenConfigurationNodes',
  'ExecutionClass',
  'SourceControlDetails',
  'MaintenanceWindow',
] as const;
const writeGlueJob: SdkWriter = async (ctx, ops) => {
  const name = str(ctx.physicalId) ?? str(ctx.declared['Name']);
  if (!name) throw new Error('cannot resolve Glue job name for revert');
  const c = new GlueClient({ region: ctx.region });
  const got = await c.send(new GetJobCommand({ JobName: name }));
  if (!got.Job) throw new Error('could not read current Glue job for revert');
  const m = applyOps(got.Job as unknown as Record<string, unknown>, ops);
  const update: Record<string, unknown> = {};
  for (const k of GLUE_JOB_UPDATE_FIELDS) if (m[k] !== undefined) update[k] = m[k];
  // MaxCapacity / AllocatedCapacity are mutually exclusive with WorkerType — include
  // them ONLY for a non-WorkerType job (else update-job rejects sending both).
  if (m.WorkerType === undefined) {
    if (m.MaxCapacity !== undefined) update.MaxCapacity = m.MaxCapacity;
    if (m.AllocatedCapacity !== undefined) update.AllocatedCapacity = m.AllocatedCapacity;
  }
  await c.send(new UpdateJobCommand({ JobName: name, JobUpdate: update as never }));
};

export const SDK_WRITERS: Record<string, SdkWriter> = {
  'AWS::CloudFront::Distribution': writeCloudFrontDistribution,
  'AWS::WAFv2::WebACL': writeWafv2WebAcl,
  'AWS::Glue::Job': writeGlueJob,
  'AWS::DocDB::DBCluster': writeDocDbCluster,
  'AWS::ServiceDiscovery::HttpNamespace': writeServiceDiscoveryHttpNamespace,
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

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
  APIGatewayClient,
  type PatchOperation,
  UpdateIntegrationCommand,
  UpdateIntegrationResponseCommand,
  UpdateMethodResponseCommand,
} from '@aws-sdk/client-api-gateway';
import { CloudWatchClient, PutAnomalyDetectorCommand } from '@aws-sdk/client-cloudwatch';
import {
  DLMClient,
  GetLifecyclePolicyCommand,
  type SettablePolicyStateValues,
  UpdateLifecyclePolicyCommand,
} from '@aws-sdk/client-dlm';
import {
  CloudControlClient,
  GetResourceCommand,
  UpdateResourceCommand,
} from '@aws-sdk/client-cloudcontrol';
import {
  CloudFrontClient,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import {
  CloudWatchLogsClient,
  PutBearerTokenAuthenticationCommand,
  PutMetricFilterCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  DocDBClient,
  ModifyDBClusterCommand,
  ModifyDBInstanceCommand,
} from '@aws-sdk/client-docdb';
import {
  DescribeDomainConfigCommand,
  OpenSearchClient,
  UpdateDomainConfigCommand,
} from '@aws-sdk/client-opensearch';
import {
  GetJobCommand,
  GlueClient,
  UpdateClassifierCommand,
  UpdateConnectionCommand,
  UpdateJobCommand,
  UpdateTableCommand,
  UpdateWorkflowCommand,
} from '@aws-sdk/client-glue';
import {
  GetWebACLCommand,
  type Scope,
  UpdateWebACLCommand,
  WAFV2Client,
} from '@aws-sdk/client-wafv2';
import { type ReceiptRule, SESClient, UpdateReceiptRuleCommand } from '@aws-sdk/client-ses';
import {
  ElasticLoadBalancingV2Client,
  ModifyLoadBalancerAttributesCommand,
  ModifyTargetGroupAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  AttachGroupPolicyCommand,
  AttachRolePolicyCommand,
  AttachUserPolicyCommand,
  CreatePolicyVersionCommand,
  DetachGroupPolicyCommand,
  DetachRolePolicyCommand,
  DetachUserPolicyCommand,
  DeletePolicyVersionCommand,
  DeleteRolePolicyCommand,
  IAMClient,
  ListPolicyVersionsCommand,
  PutGroupPolicyCommand,
  PutRolePolicyCommand,
  PutUserPolicyCommand,
} from '@aws-sdk/client-iam';
import {
  ConfigServiceClient,
  DescribeConfigRulesCommand,
  PutConfigRuleCommand,
} from '@aws-sdk/client-config-service';
import { KafkaClient, UpdateConfigurationCommand } from '@aws-sdk/client-kafka';
import {
  DescribeEventBusCommand,
  EventBridgeClient,
  PutPermissionCommand,
} from '@aws-sdk/client-eventbridge';
import {
  CognitoSyncClient,
  GetCognitoEventsCommand,
  SetCognitoEventsCommand,
} from '@aws-sdk/client-cognito-sync';
import {
  ECSClient,
  type ServiceConnectConfiguration,
  type ServiceVolumeConfiguration,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import { ChangeResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import { DeleteBucketPolicyCommand, PutBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';
import {
  ServiceDiscoveryClient,
  UpdateHttpNamespaceCommand,
} from '@aws-sdk/client-servicediscovery';
import { SetTopicAttributesCommand, SNSClient } from '@aws-sdk/client-sns';
import { SetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { NESTED_ARRAY_IDENTITY } from '../diff/classify.js';
import { identityField } from '../normalize/noise.js';
import { canonicalizeForCompare } from '../normalize/pipeline.js';
import {
  DLM_DEFAULT_POLICY_SHORTHAND,
  type OverrideCtx,
  SDK_OVERRIDES,
} from '../read/overrides.js';
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

// AWS::Events::EventBusPolicy is a resource-policy STATEMENT on an event bus — the
// same class as SNS TopicPolicy / SQS QueuePolicy / S3 BucketPolicy, all of which
// revert via their native SDK because a Cloud Control RFC6902 patch is wrong for a
// policy here: the live `Statement` comes back as a SINGULAR object while classify
// canonicalizes it to a one-element array, so an indexed op (`/Statement/0/Action`)
// targets a path the raw model lacks (`noSuchPath`) and the CC revert FAILS. We write
// the desired statement directly via PutPermission, MERGING by StatementId into the
// bus's current aggregate policy so a sibling statement (another EventBusPolicy
// resource, or one added out of band) is preserved rather than wiped.
const writeEventBusPolicy: SdkWriter = async (ctx) => {
  const eventBusName = str(ctx.declared['EventBusName']) ?? 'default';
  const statementId = str(ctx.declared['StatementId']);
  if (!statementId) throw new Error('cannot resolve StatementId for EventBusPolicy revert');
  const c = new EventBridgeClient({ region: ctx.region });

  // Desired statement = the declared (template) intent. Modern templates declare a full
  // `Statement` object; the legacy CfnEventBusPolicy form declares Action+Principal.
  const declaredStmt = ctx.declared['Statement'];
  let desiredStatement: Record<string, unknown>;
  if (declaredStmt && typeof declaredStmt === 'object' && !Array.isArray(declaredStmt)) {
    desiredStatement = { Sid: statementId, ...(declaredStmt as Record<string, unknown>) };
  } else {
    const action = ctx.declared['Action'];
    const principal = str(ctx.declared['Principal']);
    if (action === undefined || principal === undefined)
      throw new Error('EventBusPolicy revert needs a Statement (or Action + Principal)');
    desiredStatement = {
      Sid: statementId,
      Effect: 'Allow',
      Principal: principal === '*' ? '*' : { AWS: `arn:aws:iam::${principal}:root` },
      Action: action,
      Resource: `arn:aws:events:${ctx.region}:${ctx.accountId}:event-bus/${eventBusName}`,
      ...(ctx.declared['Condition'] !== undefined ? { Condition: ctx.declared['Condition'] } : {}),
    };
  }

  const bus = await c.send(new DescribeEventBusCommand({ Name: eventBusName }));
  const policy =
    bus.Policy && bus.Policy.length > 0
      ? (JSON.parse(bus.Policy) as { Version?: string; Statement?: unknown })
      : { Version: '2012-10-17', Statement: [] as unknown };
  const statements: Record<string, unknown>[] = Array.isArray(policy.Statement)
    ? (policy.Statement as Record<string, unknown>[])
    : policy.Statement
      ? [policy.Statement as Record<string, unknown>]
      : [];
  const idx = statements.findIndex((s) => s?.['Sid'] === statementId);
  if (idx >= 0) statements[idx] = desiredStatement;
  else statements.push(desiredStatement);
  await c.send(
    new PutPermissionCommand({
      EventBusName: eventBusName,
      Policy: JSON.stringify({ Version: policy.Version ?? '2012-10-17', Statement: statements }),
    })
  );
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
// Top JSON-pointer segment of an op path (`/Roles/0` -> `Roles`, `/Roles` -> `Roles`).
const topSeg = (path: string): string => path.split('/').filter(Boolean)[0] ?? '';
const ATTACHMENT_PROPS = new Set(['Roles', 'Users', 'Groups']);
// Resolve an op into a ManagedPolicy attachment (prop + member) from EITHER encoding the
// revert plan emits: a declared DETACH revert (re-attach) arrives as path `Roles` with
// the member on `attributeKey`; an unexpected-attach removal (--remove-unrecorded) of a
// live-only member arrives as the nested path `Roles[member]`. Returns undefined for a
// document op (PolicyDocument/Path/Description), which routes to the version path below.
const parseAttachmentOp = (o: PatchOp): { prop: string; member: string } | undefined => {
  const seg = topSeg(o.path);
  if (ATTACHMENT_PROPS.has(seg)) {
    const member = o.attributeKey ?? (typeof o.value === 'string' ? o.value : undefined);
    return member !== undefined ? { prop: seg, member: String(member) } : undefined;
  }
  const m = /^(Roles|Users|Groups)\[(.+)\]$/.exec(seg);
  return m ? { prop: m[1] as string, member: m[2] as string } : undefined;
};

const writeIamManagedPolicy: SdkWriter = async (ctx, ops) => {
  // CFn physical id for a managed policy IS its arn; fall back to the declared
  // ManagedPolicyArn when the physical id isn't (yet) the arn shape.
  const arn = isArn(ctx.physicalId) ?? isArn(ctx.declared['ManagedPolicyArn']);
  if (!arn) throw new Error('cannot resolve managed policy arn for revert');
  const c = new IAMClient({ region: ctx.region });

  // Attachment-list reverts (Roles/Users/Groups), per member — never by rewriting the
  // whole list (that would touch the union members another stack/role/console
  // legitimately added):
  //   - an `add` op re-ATTACHES a declared member detached out of band (AttachXPolicy);
  //   - a `remove` op DETACHES a live-only (unexpected) member the user chose to remove
  //     via --remove-unrecorded (DetachXPolicy).
  // AttachXPolicy on an already-attached member is a no-op, so a partial prior revert
  // re-runs safely.
  for (const o of ops) {
    const parsed = parseAttachmentOp(o);
    if (!parsed) continue;
    const { prop, member } = parsed;
    const detach = o.op === 'remove';
    if (prop === 'Roles')
      await c.send(
        detach
          ? new DetachRolePolicyCommand({ PolicyArn: arn, RoleName: member })
          : new AttachRolePolicyCommand({ PolicyArn: arn, RoleName: member })
      );
    else if (prop === 'Users')
      await c.send(
        detach
          ? new DetachUserPolicyCommand({ PolicyArn: arn, UserName: member })
          : new AttachUserPolicyCommand({ PolicyArn: arn, UserName: member })
      );
    else if (prop === 'Groups')
      await c.send(
        detach
          ? new DetachGroupPolicyCommand({ PolicyArn: arn, GroupName: member })
          : new AttachGroupPolicyCommand({ PolicyArn: arn, GroupName: member })
      );
  }

  // Document/Path/Description reverts go through a new default policy version. Skip it
  // entirely when only attachment ops were present, so a detach-only revert does not
  // burn a (capped at 5) policy version re-writing the unchanged document.
  const docOps = ops.filter((o) => parseAttachmentOp(o) === undefined);
  if (docOps.length === 0) return;
  const desired = policyJson(await desiredModel('AWS::IAM::ManagedPolicy', ctx, docOps));
  if (desired === undefined)
    throw new Error('cannot revert a managed policy to an absent document');

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
// (The sibling AWS::DocDB::DBInstance has its own ModifyDBInstance writer below.)
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

// AWS::DocDB::DBInstance — Cloud Control cannot read OR write the DocDB family, so it is
// read via DescribeDBInstances and had no writer (the sibling cluster had one). Revert
// goes through DocDB's own ModifyDBInstance (a PARTIAL update, like ModifyDBCluster), so
// send ONLY the drifted top-level props in the safe-to-modify allowlist. ApplyImmediately
// so the revert converges on the next read. The mirror of the cluster writer.
// EXCLUDED: DBClusterIdentifier (create-only) and AutoMinorVersionUpgrade — the latter is
// a CLUSTER-level setting on DocumentDB (ModifyDBInstance rejects it: "AutoMinorVersionUpgrade
// is a cluster setting for DocumentDB clusters. Use ModifyDBCluster"), so even though the
// reader echoes the cluster's value on the instance read, it is not instance-modifiable —
// a change surfaces/reverts at the cluster, not here.
const DOCDB_INSTANCE_MODIFY_PARAMS = new Set([
  'DBInstanceClass',
  'PreferredMaintenanceWindow',
  'CACertificateIdentifier',
  'EnablePerformanceInsights',
]);
const writeDocDbInstance: SdkWriter = async (ctx, ops) => {
  const id = str(ctx.physicalId) ?? str(ctx.declared['DBInstanceIdentifier']);
  if (!id) throw new Error('cannot resolve DB instance identifier for revert');
  const desired = await desiredModel('AWS::DocDB::DBInstance', ctx, ops);
  const input: { DBInstanceIdentifier: string; ApplyImmediately: boolean; [k: string]: unknown } = {
    DBInstanceIdentifier: id,
    ApplyImmediately: true,
  };
  let any = false;
  for (const op of ops) {
    const top = op.path.replace(/^\//, '').split('/')[0];
    if (top && DOCDB_INSTANCE_MODIFY_PARAMS.has(top) && desired[top] !== undefined) {
      input[top] = desired[top];
      any = true;
    }
  }
  if (!any) return;
  await new DocDBClient({ region: ctx.region }).send(new ModifyDBInstanceCommand(input));
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
  // A revert op path indexes the model classify COMPARED, which is canonicalized: every
  // WebACL Rule carries a `Name`, so canonicalizeForCompare SORTS the `Rules` array by it
  // (the same identity-keyed sort that aligns Tags/Origins). But GetWebACL returns Rules in
  // their RAW configured order, which a user who declared rules out of Name order returns in
  // a DIFFERENT order than the sorted finding index. An op like `…/Rules/1/…` would then
  // land on a DIFFERENT rule than the one classify found drifted — patching an unrelated
  // (security-relevant) rule and leaving the real drift unreverted (the #180 / #275 index-
  // misalignment class, here on the SDK-writer path). Canonicalize the current model the
  // same way so an indexed op hits the SAME rule; Rule order is not significant to WAFv2
  // (Priority governs evaluation), so re-sending the sorted array changes no behavior.
  const m = applyOps(
    canonicalizeForCompare(cur.WebACL as unknown as Record<string, unknown>) as Record<
      string,
      unknown
    >,
    ops
  );
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

// AWS::Glue::Table — Cloud Control GetResource throws UnsupportedActionException for the
// whole Glue family, so it is read via the Glue GetTable override and was not revertable.
// Glue UpdateTable is a WHOLE-TableInput overwrite, and the override reader already
// returns the full CFn-modeled TableInput (Name/Description/Owner/Retention/TableType/
// Parameters/PartitionKeys/StorageDescriptor/…), so reconstruct the desired TableInput
// (current + revert ops) and write it back. Mirrors the sibling writeGlueJob (GetJob →
// UpdateJob). The reverted TableInput is complete, so the overwrite is safe.
const writeGlueTable: SdkWriter = async (ctx, ops) => {
  const m = await desiredModel('AWS::Glue::Table', ctx, ops);
  const dbName = str(m.DatabaseName) ?? str(ctx.declared['DatabaseName']);
  const tableInput = m.TableInput as Record<string, unknown> | undefined;
  if (!dbName || !tableInput || !str(tableInput.Name))
    throw new Error('cannot resolve Glue table target for revert');
  const catalogId = str(m.CatalogId) ?? str(ctx.declared['CatalogId']);
  await new GlueClient({ region: ctx.region }).send(
    new UpdateTableCommand({
      DatabaseName: dbName,
      TableInput: tableInput as never,
      ...(catalogId && { CatalogId: catalogId }),
    })
  );
};

// AWS::Glue::Classifier — read via the GetClassifier override (CC UnsupportedActionException),
// so it was not revertable. Glue UpdateClassifier is a WHOLE one-of overwrite ({CsvClassifier
// | GrokClassifier | JsonClassifier | XMLClassifier}); the override reader returns the full
// CFn-modeled member, so reconstruct the desired member (current + revert ops) and write it
// back. Mirrors writeGlueTable (GetTable → UpdateTable). Covers the common drifts — an
// out-of-band Delimiter / GrokPattern / JsonPath edit.
const writeGlueClassifier: SdkWriter = async (ctx, ops) => {
  const m = await desiredModel('AWS::Glue::Classifier', ctx, ops);
  const input: Record<string, unknown> = {};
  for (const k of ['CsvClassifier', 'GrokClassifier', 'JsonClassifier', 'XMLClassifier']) {
    const member = m[k];
    // require a Name — UpdateClassifier targets the classifier by it, and it guards against
    // a partial member an op might fabricate when the live read returned nothing.
    if (member && typeof member === 'object' && str((member as Record<string, unknown>).Name)) {
      input[k] = member;
      break;
    }
  }
  if (Object.keys(input).length === 0)
    throw new Error('cannot resolve Glue classifier target for revert');
  await new GlueClient({ region: ctx.region }).send(new UpdateClassifierCommand(input as never));
};

// AWS::Glue::Workflow — read via the GetWorkflow override (CC UnsupportedActionException),
// so it was not revertable. Glue UpdateWorkflow takes the mutable props (Description /
// DefaultRunProperties / MaxConcurrentRuns); reconstruct the desired model (current + revert
// ops) and write the present ones back, targeting by the declared/physical Name.
const writeGlueWorkflow: SdkWriter = async (ctx, ops) => {
  const m = await desiredModel('AWS::Glue::Workflow', ctx, ops);
  const name = str(m.Name) ?? str(ctx.physicalId) ?? str(ctx.declared['Name']);
  if (!name) throw new Error('cannot resolve Glue workflow target for revert');
  await new GlueClient({ region: ctx.region }).send(
    new UpdateWorkflowCommand({
      Name: name,
      ...(m.Description !== undefined && { Description: str(m.Description) }),
      ...(m.DefaultRunProperties !== undefined && {
        DefaultRunProperties: m.DefaultRunProperties as Record<string, string>,
      }),
      ...(m.MaxConcurrentRuns !== undefined && { MaxConcurrentRuns: Number(m.MaxConcurrentRuns) }),
    })
  );
};

// AWS::Glue::Connection — read via the GetConnection override (the whole Glue family is a
// CC read gap; UnsupportedActionException), so it was detect-only. Glue UpdateConnection is
// a WHOLE-ConnectionInput overwrite, and the reader returns the full CFn `ConnectionInput`
// (ConnectionType / Description / MatchCriteria / ConnectionProperties [SECRET_ID kept] /
// PhysicalConnectionRequirements / AuthenticationConfiguration), so reconstruct the desired
// model (current + revert ops) and write the whole ConnectionInput back — covering a
// network / Description / JDBC-setting drift.
//
// CREDENTIAL SAFETY: the reader runs GetConnection with HidePassword and DROPS every
// `*PASSWORD` ConnectionProperties key, so the desired ConnectionInput carries NO inline
// password. Re-supplying it on a connection that DECLARES an inline password would CLEAR
// that un-read credential (silent data loss). Refuse such a revert up front (a thrown error
// the revert loop reports as a per-resource failure — never a clobber): only the modern
// SECRET_ID / NETWORK / no-inline-credential pattern is safe to overwrite. The guard reads
// the DECLARED ConnectionProperties (no extra API call); a SECRET_ID connection has no
// password key and reverts fine.
const GLUE_CONNECTION_PASSWORD_KEY = /PASSWORD/i;
const writeGlueConnection: SdkWriter = async (ctx, ops) => {
  const declInput = ctx.declared['ConnectionInput'] as Record<string, unknown> | undefined;
  const declProps = declInput?.ConnectionProperties as Record<string, unknown> | undefined;
  if (declProps && Object.keys(declProps).some((k) => GLUE_CONNECTION_PASSWORD_KEY.test(k)))
    throw new Error(
      'Glue Connection declares an inline PASSWORD — not revertable (a revert would clear the un-read credential); use a SECRET_ID connection or update it manually'
    );
  const m = await desiredModel('AWS::Glue::Connection', ctx, ops);
  const ci = m.ConnectionInput as Record<string, unknown> | undefined;
  const name = str(ci?.Name) ?? str(ctx.physicalId) ?? str(declInput?.Name);
  if (!ci || !name) throw new Error('cannot resolve Glue connection target for revert');
  const catalogId = str(m.CatalogId) ?? str(ctx.declared['CatalogId']);
  await new GlueClient({ region: ctx.region }).send(
    new UpdateConnectionCommand({
      Name: name,
      ...(catalogId && { CatalogId: catalogId }),
      // ConnectionProperties is required by the API; a NETWORK connection has none -> {}.
      ConnectionInput: { ...ci, Name: name, ConnectionProperties: ci.ConnectionProperties ?? {} },
    } as never)
  );
};

// AWS::SES::ReceiptRule — read via the DescribeReceiptRule override (the SES inbound
// receipt-rule family has no Cloud Control handlers), so it was detect-only. SES
// UpdateReceiptRule REPLACES the whole rule in place (without changing its position), and
// the override reader returns the full CFn `Rule` (whose shape mirrors the SDK ReceiptRule
// 1:1), so reconstruct the desired model (current live + revert ops) and write the whole
// Rule back — covering any drift on Enabled / TlsPolicy / Recipients / Actions / ScanEnabled.
// The parent RuleSetName (createOnly) targets the rule; sending the WHOLE live Rule (not just
// the drifted field) means a never-declared Enabled/ScanEnabled is preserved rather than
// reset to the SES create-default. (RuleSetName / ReceiptFilter have only createOnly props,
// so they have no SDK writer — detect-only.)
const writeSesReceiptRule: SdkWriter = async (ctx, ops) => {
  const m = await desiredModel('AWS::SES::ReceiptRule', ctx, ops);
  const ruleSetName = str(m.RuleSetName) ?? str(ctx.declared['RuleSetName']);
  const rule = m.Rule as ReceiptRule | undefined;
  if (!ruleSetName || !rule || !str(rule.Name))
    throw new Error('cannot resolve SES receipt rule target for revert');
  await new SESClient({ region: ctx.region }).send(
    new UpdateReceiptRuleCommand({ RuleSetName: ruleSetName, Rule: rule })
  );
};

// AWS::CloudWatch::AnomalyDetector — read via the DescribeAnomalyDetectors override
// (NON_PROVISIONABLE, no Cloud Control handlers), so it was detect-only. Every
// identity property (Namespace/MetricName/Stat/Dimensions or the nested
// SingleMetric/MetricMath detector) is createOnly — the one mutable property is
// `Configuration` (MetricTimeZone + ExcludedTimeRanges), and cloudwatch
// PutAnomalyDetector is an UPSERT keyed on the detector identity: re-supply the
// identity from the desired model plus the desired Configuration and the config is
// overwritten in place. Field mapping mirrors the reader (CFn MetricTimeZone -> API
// MetricTimezone; ISO strings -> Dates). A desired model with NO Configuration sends
// an empty {} — proven live to clear an out-of-band timezone back to the default.
const writeCloudWatchAnomalyDetector: SdkWriter = async (ctx, ops) => {
  const m = await desiredModel('AWS::CloudWatch::AnomalyDetector', ctx, ops);
  const single = m.SingleMetricAnomalyDetector as Record<string, unknown> | undefined;
  const math = m.MetricMathAnomalyDetector as Record<string, unknown> | undefined;
  const legacyNs = str(m.Namespace);
  if (!single && !math && !legacyNs)
    throw new Error('cannot resolve anomaly-detector identity for revert');
  const cfg = m.Configuration as
    | {
        MetricTimeZone?: unknown;
        ExcludedTimeRanges?: { StartTime?: unknown; EndTime?: unknown }[];
      }
    | undefined;
  // The CFn Range pattern is ZONE-LESS UTC (`YYYY-MM-DDTHH:MM:SS`) — a bare
  // `new Date(s)` would parse that as LOCAL time and shift every range by the
  // machine's UTC offset on revert. Pin zone-less strings to UTC explicitly.
  const toDate = (v: unknown): Date | undefined =>
    typeof v === 'string'
      ? new Date(/Z$|[+-]\d\d:\d\d$/.test(v) ? v : `${v}Z`)
      : v instanceof Date
        ? v
        : undefined;
  const configuration = {
    ...(str(cfg?.MetricTimeZone) && { MetricTimezone: cfg?.MetricTimeZone as string }),
    ...((cfg?.ExcludedTimeRanges ?? []).length > 0 && {
      ExcludedTimeRanges: (cfg?.ExcludedTimeRanges ?? []).map((r) => ({
        StartTime: toDate(r.StartTime),
        EndTime: toDate(r.EndTime),
      })),
    }),
  };
  await new CloudWatchClient({ region: ctx.region }).send(
    new PutAnomalyDetectorCommand({
      ...(single && { SingleMetricAnomalyDetector: single as never }),
      ...(math && { MetricMathAnomalyDetector: math as never }),
      ...(!single &&
        !math && {
          SingleMetricAnomalyDetector: {
            Namespace: legacyNs,
            MetricName: str(m.MetricName),
            Stat: str(m.Stat),
            ...(Array.isArray(m.Dimensions) &&
              m.Dimensions.length > 0 && { Dimensions: m.Dimensions as never }),
          },
        }),
      Configuration: configuration,
    })
  );
};

// AWS::DLM::LifecyclePolicy — read via the GetLifecyclePolicy override (NON_PROVISIONABLE,
// no Cloud Control handlers), so it was detect-only. dlm:UpdateLifecyclePolicy takes the
// SAME shape as the read (PolicyId + the mutable Description / State / ExecutionRoleArn /
// PolicyDetails — PolicyType and ResourceType are the only immutable bits and are re-sent
// unchanged inside PolicyDetails), so reconstruct the desired model (current + revert ops)
// and write it back. Covers the common drifts: an out-of-band State flip (ENABLED↔DISABLED),
// a changed schedule retain count / interval, an ExecutionRoleArn swap. The default-policy
// shorthand emits the schedule knobs at the top level, which Update does NOT accept, so
// re-fetch the live PolicyDetails and overlay the desired shorthand keys into it.
const writeDlmLifecyclePolicy: SdkWriter = async (ctx, ops) => {
  const id = str(ctx.physicalId);
  if (!id) throw new Error('cannot resolve DLM lifecycle policy id for revert');
  const c = new DLMClient({ region: ctx.region });
  const m = await desiredModel('AWS::DLM::LifecyclePolicy', ctx, ops);
  let details = m.PolicyDetails as Record<string, unknown> | undefined;
  if (details === undefined && DLM_DEFAULT_POLICY_SHORTHAND.some((k) => m[k] !== undefined)) {
    // Shorthand style: Update only accepts a full PolicyDetails, so start from the live
    // PolicyDetails (carries the immutable PolicyType/ResourceType the API folded in) and
    // overlay the desired shorthand values.
    const live = (await c.send(new GetLifecyclePolicyCommand({ PolicyId: id }))).Policy
      ?.PolicyDetails as Record<string, unknown> | undefined;
    details = { ...(live ?? {}) };
    for (const k of DLM_DEFAULT_POLICY_SHORTHAND) if (m[k] !== undefined) details[k] = m[k];
  }
  await c.send(
    new UpdateLifecyclePolicyCommand({
      PolicyId: id,
      ...(str(m.Description) !== undefined && { Description: str(m.Description) }),
      ...(str(m.State) !== undefined && { State: str(m.State) as SettablePolicyStateValues }),
      ...(str(m.ExecutionRoleArn) !== undefined && { ExecutionRoleArn: str(m.ExecutionRoleArn) }),
      ...(details !== undefined && { PolicyDetails: details as never }),
    })
  );
};

// AWS::Logs::MetricFilter — Cloud Control GetResource throws ValidationException (its
// composite id), so it is read via DescribeMetricFilters and was not revertable.
// CloudWatch Logs PutMetricFilter is an UPSERT of the whole filter, and the override
// reader returns the full CFn model (FilterPattern + MetricTransformations [+
// ApplyOnTransformedLogs]), so reconstruct the desired model (current + revert ops) and
// PUT it back. Covers the common drifts: an out-of-band FilterPattern edit or a changed
// MetricTransformation value.
const writeMetricFilter: SdkWriter = async (ctx, ops) => {
  const m = await desiredModel('AWS::Logs::MetricFilter', ctx, ops);
  const logGroup = str(m.LogGroupName) ?? str(ctx.declared['LogGroupName']);
  const filterName = str(m.FilterName) ?? str(ctx.physicalId) ?? str(ctx.declared['FilterName']);
  if (!logGroup || !filterName) throw new Error('cannot resolve metric filter target for revert');
  const transforms = ((m.MetricTransformations as Record<string, unknown>[]) ?? []).map((t) => ({
    metricName: str(t.MetricName),
    metricNamespace: str(t.MetricNamespace),
    metricValue: str(t.MetricValue),
    ...(t.DefaultValue !== undefined && { defaultValue: Number(t.DefaultValue) }),
    ...(t.Unit !== undefined && { unit: t.Unit as string }),
    ...(t.Dimensions !== undefined && { dimensions: t.Dimensions as Record<string, string> }),
  }));
  await new CloudWatchLogsClient({ region: ctx.region }).send(
    new PutMetricFilterCommand({
      logGroupName: logGroup,
      filterName,
      filterPattern: str(m.FilterPattern) ?? '',
      metricTransformations: transforms as never,
      ...(m.ApplyOnTransformedLogs !== undefined && {
        applyOnTransformedLogs: m.ApplyOnTransformedLogs as boolean,
      }),
    })
  );
};

// AWS::Route53::RecordSet — Cloud Control cannot read this type (read via the
// ListResourceRecordSets override) and it had no writer, so a console edit to a record
// (TTL / values / weight / failover / alias target / health check) was detected but not
// revertable. Route53 ChangeResourceRecordSets with Action UPSERT replaces the record
// with the supplied ResourceRecordSet, and the override reader returns the FULL CFn
// projection (Name/Type/TTL/ResourceRecords + AliasTarget + all routing-policy fields),
// so reconstruct the desired RRSet (current + revert ops) and UPSERT it. A simple record
// carries Name/Type/TTL/ResourceRecords; alias/weighted/latency/failover/geo/cidr
// variants carry their extra fields, all already in the desired model.
const RR_ROUTING_FIELDS = [
  'SetIdentifier',
  'Weight',
  'Region',
  'Failover',
  'MultiValueAnswer',
  'HealthCheckId',
  'GeoLocation',
  'GeoProximityLocation',
  'CidrRoutingConfig',
] as const;
const writeRoute53RecordSet: SdkWriter = async (ctx, ops) => {
  const m = await desiredModel('AWS::Route53::RecordSet', ctx, ops);
  const zone = str(m.HostedZoneId) ?? str(ctx.declared['HostedZoneId']);
  const name = str(m.Name) ?? str(ctx.declared['Name']);
  const type = str(m.Type) ?? str(ctx.declared['Type']);
  if (!zone || !name || !type) throw new Error('cannot resolve Route53 record target for revert');
  const rrset: Record<string, unknown> = { Name: name, Type: type };
  if (m.TTL !== undefined) rrset.TTL = Number(m.TTL); // CFn TTL is a string; the API wants a number
  if (Array.isArray(m.ResourceRecords))
    rrset.ResourceRecords = (m.ResourceRecords as string[]).map((v) => ({ Value: v }));
  if (m.AliasTarget !== undefined) rrset.AliasTarget = m.AliasTarget;
  for (const k of RR_ROUTING_FIELDS) if (m[k] !== undefined) rrset[k] = m[k];
  await new Route53Client({ region: ctx.region }).send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: zone,
      ChangeBatch: { Changes: [{ Action: 'UPSERT', ResourceRecordSet: rrset as never }] },
    })
  );
};

// AWS::Config::ConfigRule `InputParameters` — Config stores it as a single JSON STRING.
// Cloud Control CAN read it (returned parsed as an object) but CANNOT revert it: a CC
// UpdateResource re-serializes the JSON into Config's string field WITH SPACES, which the
// PutConfigRule provider rejects ("Blank spaces are not acceptable for input parameter")
// — proven live, the same CC-revalidation class as OpenSearch/CloudFront. So revert this
// property via PutConfigRule directly, writing the declared value as a COMPACT JSON string
// (no spaces). PutConfigRule is a whole-rule UPSERT, so re-read the current rule and
// overwrite only InputParameters, preserving Source/Scope/MaximumExecutionFrequency/etc.
// Config stores InputParameters as a JSON string whose param VALUES are themselves
// strings (a managed rule's `maxAccessKeyAge` is `"90"`, not `90`). CDK declares them
// typed (`90`), and CloudFormation coerces them to strings on deploy — cdkrd treats
// `90` and `"90"` as equal (stringly). The revert must write the SAME string-valued form
// CloudFormation produced, or PutConfigRule rejects the numeric value with the misleading
// "Blank spaces are not acceptable for input parameter" error (proven live). So serialize
// the declared object with each scalar param value coerced to a string; objects/arrays
// (a rare structured param) are left as-is for JSON to render.
const configInputParametersString = (v: unknown): string => {
  let model: unknown = v;
  if (typeof v === 'string') {
    try {
      model = JSON.parse(v);
    } catch {
      return v; // already a string we can't parse — pass through verbatim
    }
  }
  if (model !== null && typeof model === 'object' && !Array.isArray(model)) {
    const coerced: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(model as Record<string, unknown>)) {
      coerced[k] = typeof val === 'number' || typeof val === 'boolean' ? String(val) : val;
    }
    return JSON.stringify(coerced);
  }
  return JSON.stringify(model);
};
const writeConfigRuleInputParameters: SdkWriter = async (ctx, ops) => {
  const name = str(ctx.physicalId) ?? str(ctx.declared['ConfigRuleName']);
  if (!name) throw new Error('cannot resolve Config rule name for revert');
  const op = ops.find((o) => o.path === '/InputParameters');
  if (op?.op !== 'add') throw new Error('Config rule InputParameters revert: unexpected op');
  const client = new ConfigServiceClient({ region: ctx.region });
  const got = await client.send(new DescribeConfigRulesCommand({ ConfigRuleNames: [name] }));
  const rule = got.ConfigRules?.[0];
  if (!rule) throw new Error(`Config rule not found for revert: ${name}`);
  // Re-PUT the rule with only InputParameters overwritten. Drop the server-populated
  // fields PutConfigRule rejects (ConfigRuleArn/Id/State, CreatedBy, and a newer
  // RuleEvaluationVisibility — proven live: "AWS Config populates the
  // RuleEvaluationVisibility field ... Try again without populating [it]"); keep the rest
  // (Source/Scope/Description/MaximumExecutionFrequency/EvaluationModes). The rule is
  // matched by the preserved ConfigRuleName.
  const {
    ConfigRuleArn,
    ConfigRuleId,
    ConfigRuleState,
    CreatedBy,
    RuleEvaluationVisibility,
    ...rest
  } = rule;
  void ConfigRuleArn;
  void ConfigRuleId;
  void ConfigRuleState;
  void CreatedBy;
  void RuleEvaluationVisibility;
  await client.send(
    new PutConfigRuleCommand({
      ConfigRule: { ...rest, InputParameters: configInputParametersString(op.value) },
    })
  );
};

// AWS::OpenSearchService::Domain — Cloud Control CAN read this type, but its
// UpdateResource REJECTS a property patch: it re-submits the full model and AWS's own
// legacy `override_main_response_version` AdvancedOption (returned on read) is rejected
// as "Unrecognized advanced option" (proven live; the same CC-revalidation class as
// CloudFront/WAFv2/Glue). UpdateDomainConfig is a PARTIAL API, so route revert through
// it sending ONLY the top-level option properties the revert ops actually touch — the
// untouched AdvancedOptions are never re-submitted. (If AdvancedOptions itself is the
// drift, the AWS-managed override_main_response_version key is dropped before the call.)
const OS_UPDATABLE_OPTIONS = new Set([
  'ClusterConfig',
  'EBSOptions',
  'SnapshotOptions',
  'VPCOptions',
  'CognitoOptions',
  'AdvancedOptions',
  'AccessPolicies',
  'IPAddressType',
  'LogPublishingOptions',
  'EncryptionAtRestOptions',
  'DomainEndpointOptions',
  'NodeToNodeEncryptionOptions',
  'AdvancedSecurityOptions',
  'AutoTuneOptions',
  'OffPeakWindowOptions',
  'SoftwareUpdateOptions',
]);
const writeOpenSearchDomain: SdkWriter = async (ctx, ops) => {
  const name = str(ctx.physicalId) ?? str(ctx.declared['DomainName']);
  if (!name) throw new Error('cannot resolve OpenSearch domain name for revert');
  const touched = new Set(
    ops.map((o) => o.path.replace(/^\//, '').split('/')[0]).filter((p): p is string => !!p)
  );
  const c = new OpenSearchClient({ region: ctx.region });
  const cfg = (await c.send(new DescribeDomainConfigCommand({ DomainName: name }))).DomainConfig as
    | Record<string, { Options?: unknown }>
    | undefined;
  // build a model of ONLY the touched option properties from the current live config,
  // apply the revert ops, then send each touched updatable property on its own.
  const model: Record<string, unknown> = {};
  for (const p of touched) if (cfg?.[p]?.Options !== undefined) model[p] = cfg[p].Options;
  const reverted = applyOps(model, ops);
  const input: Record<string, unknown> = { DomainName: name };
  for (const p of touched) {
    if (!OS_UPDATABLE_OPTIONS.has(p) || reverted[p] === undefined) continue;
    if (p === 'AdvancedOptions' && reverted[p] && typeof reverted[p] === 'object') {
      // drop the AWS-managed legacy key UpdateDomainConfig rejects on re-submit.
      const { override_main_response_version: _drop, ...rest } = reverted[p] as Record<
        string,
        unknown
      >;
      input[p] = rest;
    } else {
      input[p] = reverted[p];
    }
  }
  await c.send(new UpdateDomainConfigCommand(input as never));
};

// AWS::Logs::LogGroup.BearerTokenAuthenticationEnabled — Cloud Control CAN read this
// type, but its UpdateResource FAILS on this (newer) boolean: the CC LogGroup update
// handler's downstream CloudWatch Logs call errors with "The security token included in
// the request is invalid" (proven live; the property has a dedicated control-plane API
// the generic UpdateLogGroup path does not drive). CloudWatch Logs exposes
// PutBearerTokenAuthentication for exactly this toggle, so route the revert through it.
// The op is the BearerTokenAuthenticationEnabled toggle: a `remove` (undeclared, not in
// baseline) reverts to the schema default of DISABLED; an `add` carries the desired
// boolean (declared drift / recorded baseline value). The LogGroup physical id IS its
// name, which PutBearerTokenAuthentication accepts as logGroupIdentifier.
const writeLogGroupBearerTokenAuth: SdkWriter = async (ctx, ops) => {
  const lg = str(ctx.physicalId) ?? str(ctx.declared['LogGroupName']);
  if (!lg) throw new Error('cannot resolve log group name for revert');
  const c = new CloudWatchLogsClient({ region: ctx.region });
  for (const op of ops) {
    // plan.ts groups this prop-scoped item to the single BearerTokenAuthenticationEnabled
    // path, so there is one op; a `remove` means "back to default (disabled)".
    const enabled = op.op === 'add' ? op.value === true : false;
    await c.send(
      new PutBearerTokenAuthenticationCommand({
        logGroupIdentifier: lg,
        bearerTokenAuthenticationEnabled: enabled,
      })
    );
  }
};

// AWS::Cognito::IdentityPool `CognitoEvents` (the writeOnly "Cognito Events" Sync
// trigger) cannot be patched through Cloud Control — it is set via the cognito-sync
// SetCognitoEvents API. Reconstruct the DESIRED event map (current live + revert ops)
// then write it whole. Two cognito-sync quirks (both live-proven): SetCognitoEvents
// REJECTS an empty map ("Missing required parameter EventsMap"), and a key simply OMITTED
// from the map is NOT cleared — to remove an event you must set its value to an EMPTY
// STRING. So re-add every current key the desired map drops, valued "" (clear); and when
// there is nothing to set AND nothing to clear, skip the (rejected) empty call. The
// IdentityPool physical id is the pool id SetCognitoEvents expects.
const writeCognitoIdentityPoolEvents: SdkWriter = async (ctx, ops) => {
  const id = str(ctx.physicalId) ?? str(ctx.declared['Id']);
  if (!id) throw new Error('cannot resolve identity pool id for CognitoEvents revert');
  const c = new CognitoSyncClient({ region: ctx.region });
  const cur = (await c.send(new GetCognitoEventsCommand({ IdentityPoolId: id }))).Events ?? {};
  const desired =
    (applyOps({ CognitoEvents: { ...cur } }, ops) as { CognitoEvents?: Record<string, string> })
      .CognitoEvents ?? {};
  const events: Record<string, string> = { ...desired };
  for (const k of Object.keys(cur)) if (!(k in events)) events[k] = ''; // clear dropped keys
  if (Object.keys(events).length === 0) return; // nothing to set or clear -> no-op
  await c.send(new SetCognitoEventsCommand({ IdentityPoolId: id, Events: events }));
};

// An ApiGateway Method's nested knobs live under a NESTED path Cloud Control cannot patch
// reliably: the array-element ones (Integration.IntegrationResponses[<sc>].*,
// MethodResponses[<sc>].*) are unaddressable by a flat RFC6902 pointer (the `[sc]` bracket
// survives as a literal key, the same reason R78 abandoned index array patches), and CC's
// whole-Method read-modify-write is fiddly for these sub-objects. API Gateway's native
// granular patch API targets each knob exactly, so route these specific paths here. Mirrors
// isManagedPolicyAttachmentMember: a nested undeclared value WITH a precise flat SDK op is
// exempt from the record-only bar.
//   - Integration-level:  Integration.{PassthroughBehavior,ContentHandling,TimeoutInMillis}
//   - IntegrationResponse: Integration.IntegrationResponses[<sc>].{SelectionPattern,ContentHandling}
//   - MethodResponse:     MethodResponses[<sc>].ResponseModels (the whole live-only map —
//     classify emits a live-only sub-OBJECT whole, so the media keys ride the op's value)
const APIGW_METHOD_KNOB =
  /^Integration\.(PassthroughBehavior|ContentHandling|TimeoutInMillis)$|^Integration\.IntegrationResponses\[[^\]]+\]\.(SelectionPattern|ContentHandling)$|^MethodResponses\[[^\]]+\]\.ResponseModels$/;
export const isApiGatewayMethodKnobPath = (path: string): boolean => APIGW_METHOD_KNOB.test(path);

// Per-knob revert target: the API Gateway patch path + the value to RESET to when the knob
// was undeclared. API Gateway REJECTS `op: remove` for these INTEGRATION knobs (`Invalid
// patch path /selectionPattern` — proven live), so the reset is always a `replace`:
//   - PassthroughBehavior / TimeoutInMillis -> their AWS default (WHEN_NO_MATCH / 29000).
//   - ContentHandling / SelectionPattern    -> the EMPTY STRING, which is the cleared state:
//     `replace /contentHandling ""` makes CC read it ABSENT, and `replace /selectionPattern
//     ""` leaves a "" the compare folds as trivially-empty (both proven live).
// (MethodResponses ResponseModels is the EXCEPTION — UpdateMethodResponse DOES accept
// `op: remove /responseModels/<media>`, proven live — handled separately below.)
// A declared-drift revert (`add` op) replaces with the desired template value instead.
const APIGW_KNOB_RESET: Record<string, { patchPath: string; resetTo: string }> = {
  PassthroughBehavior: { patchPath: '/passthroughBehavior', resetTo: 'WHEN_NO_MATCH' },
  TimeoutInMillis: { patchPath: '/timeoutInMillis', resetTo: '29000' },
  ContentHandling: { patchPath: '/contentHandling', resetTo: '' },
  SelectionPattern: { patchPath: '/selectionPattern', resetTo: '' },
};

const ptrEscape = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

type ApiGwPatch =
  | { kind: 'integration'; patch: PatchOperation }
  | { kind: 'integrationResponse'; statusCode: string; patch: PatchOperation }
  | { kind: 'methodResponse'; statusCode: string; patch: PatchOperation };

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// Translate a revert op (RFC6902 pointer into the Method model) into the matching API Gateway
// PatchOperation(s) + which sub-resource call applies each. ResponseModels yields ONE patch
// per media key (the finding is the whole map); the others yield a single patch.
function apigwKnobPatches(op: PatchOp): ApiGwPatch[] {
  const segs = op.path
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  // MethodResponses[<sc>].ResponseModels -> UpdateMethodResponse, one patch per media key.
  // UpdateMethodResponse ACCEPTS op:remove for a responseModels entry (proven live), so an
  // undeclared map is removed key-by-key (its keys ride op.prior); a declared one is restored
  // with op:add from op.value.
  const mr = segs[0]?.match(/^MethodResponses\[(.+)\]$/);
  if (mr && segs[1] === 'ResponseModels') {
    const statusCode = mr[1] ?? '';
    const media = op.op === 'add' ? asRecord(op.value) : asRecord(op.prior);
    return Object.keys(media).map((k) => ({
      kind: 'methodResponse' as const,
      statusCode,
      patch:
        op.op === 'add'
          ? { op: 'add', path: `/responseModels/${ptrEscape(k)}`, value: String(media[k]) }
          : { op: 'remove', path: `/responseModels/${ptrEscape(k)}` },
    }));
  }
  const ir = segs[1]?.match(/^IntegrationResponses\[(.+)\]$/);
  const field = (ir ? segs[2] : segs[1]) ?? '';
  const knob = APIGW_KNOB_RESET[field];
  if (!knob) throw new Error(`unsupported ApiGateway method knob: ${op.path}`);
  const value = op.op === 'add' ? String(op.value) : knob.resetTo;
  const patch: PatchOperation = { op: 'replace', path: knob.patchPath, value };
  return [
    ir
      ? { kind: 'integrationResponse', statusCode: ir[1] ?? '', patch }
      : { kind: 'integration', patch },
  ];
}

const pushByKey = (m: Map<string, PatchOperation[]>, k: string, p: PatchOperation): void => {
  const arr = m.get(k);
  if (arr) arr.push(p);
  else m.set(k, [p]);
};

// Revert an ApiGateway Method's nested knobs (see isApiGatewayMethodKnobPath) via API
// Gateway's native granular patch API: integration-level ops batch into one UpdateIntegration;
// per-statusCode integration-response ops into UpdateIntegrationResponse; per-statusCode
// method-response ops into UpdateMethodResponse.
const writeApiGatewayMethod: SdkWriter = async (ctx, ops) => {
  const [restApiId, resourceId, httpMethod] = ctx.physicalId.split('|');
  if (!restApiId || !resourceId || !httpMethod)
    throw new Error(
      `cannot parse ApiGateway Method id "${ctx.physicalId}" (RestApiId|ResourceId|HttpMethod)`
    );
  const integrationPatches: PatchOperation[] = [];
  const integrationRespPatches = new Map<string, PatchOperation[]>();
  const methodRespPatches = new Map<string, PatchOperation[]>();
  for (const op of ops)
    for (const p of apigwKnobPatches(op)) {
      if (p.kind === 'integration') integrationPatches.push(p.patch);
      else if (p.kind === 'integrationResponse')
        pushByKey(integrationRespPatches, p.statusCode, p.patch);
      else pushByKey(methodRespPatches, p.statusCode, p.patch);
    }
  const c = new APIGatewayClient({ region: ctx.region });
  if (integrationPatches.length > 0)
    await c.send(
      new UpdateIntegrationCommand({
        restApiId,
        resourceId,
        httpMethod,
        patchOperations: integrationPatches,
      })
    );
  for (const [statusCode, patchOperations] of integrationRespPatches)
    await c.send(
      new UpdateIntegrationResponseCommand({
        restApiId,
        resourceId,
        httpMethod,
        statusCode,
        patchOperations,
      })
    );
  for (const [statusCode, patchOperations] of methodRespPatches)
    await c.send(
      new UpdateMethodResponseCommand({
        restApiId,
        resourceId,
        httpMethod,
        statusCode,
        patchOperations,
      })
    );
};

// Recursively lower-case the first letter of every object key (the inverse of the
// reader's pascalKeysDeep): the declared CFn `ServiceConnectConfiguration` is PascalCase,
// the ecs:UpdateService input is camelCase.
function camelKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelKeysDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k.charAt(0).toLowerCase() + k.slice(1)] = camelKeysDeep(val);
    }
    return out;
  }
  return v;
}

// AWS::ECS::Service ServiceConnectConfiguration / VolumeConfigurations — both writeOnly,
// so Cloud Control cannot sub-path patch them; revert re-supplies the WHOLE declared
// prop via ecs:UpdateService (the only API that sets them). The whole config comes from
// `ctx.declared` (the resolved template intent), NOT the nested op value, so any drift
// under either prop reverts to the declared whole. CamelCased back to the SDK shape;
// UpdateService re-defaults DiscoveryName→PortName / FilesystemType→"xfs", which the
// reader folds, so the stack converges clean. ONLY the prop(s) the ops touch are sent
// (UpdateService leaves untouched fields alone), and a service whose declared Service
// Connect config is gone sends `enabled: false` to turn it off.
const writeEcsServiceWriteOnlyProps: SdkWriter = async (ctx, ops) => {
  const cluster = str(ctx.declared['Cluster']);
  const service = str(ctx.physicalId);
  if (!cluster || !service) return;
  const input: { cluster: string; service: string } & Record<string, unknown> = {
    cluster,
    service,
  };
  if (ops.some((o) => o.path.startsWith('/ServiceConnectConfiguration'))) {
    const declared = ctx.declared['ServiceConnectConfiguration'];
    input.serviceConnectConfiguration =
      declared && typeof declared === 'object'
        ? (camelKeysDeep(declared) as ServiceConnectConfiguration)
        : { enabled: false };
  }
  if (ops.some((o) => o.path.startsWith('/VolumeConfigurations'))) {
    const declared = ctx.declared['VolumeConfigurations'];
    input.volumeConfigurations = Array.isArray(declared)
      ? (camelKeysDeep(declared) as ServiceVolumeConfiguration[])
      : [];
  }
  const c = new ECSClient({ region: ctx.region });
  await c.send(new UpdateServiceCommand(input));
};

// AWS::MSK::Configuration `ServerProperties` is writeOnly, so Cloud Control cannot patch it
// (it can't read it); a "revert" is APPEND-ONLY — kafka:UpdateConfiguration creates the NEXT
// revision carrying the desired properties (the only mechanism MSK offers), which becomes the
// LatestRevision the SDK_SUPPLEMENTS reader then reads back. The op value is the desired
// plaintext server.properties blob (CFn accepts plaintext; the API takes bytes). #508.
const writeMskConfiguration: SdkWriter = async (ctx, ops) => {
  const arn = str(ctx.physicalId);
  if (!arn) throw new Error('cannot resolve MSK Configuration ARN for revert');
  const op = ops.find((o) => o.path === '/ServerProperties');
  if (op === undefined || op.op === 'remove' || typeof op.value !== 'string')
    throw new Error('MSK Configuration ServerProperties revert: unexpected op');
  const client = new KafkaClient({ region: ctx.region });
  await client.send(
    new UpdateConfigurationCommand({
      Arn: arn,
      ServerProperties: new TextEncoder().encode(op.value),
    })
  );
};

export const SDK_WRITERS: Record<string, SdkWriter> = {
  'AWS::OpenSearchService::Domain': writeOpenSearchDomain,
  'AWS::CloudFront::Distribution': writeCloudFrontDistribution,
  'AWS::WAFv2::WebACL': writeWafv2WebAcl,
  'AWS::Glue::Job': writeGlueJob,
  'AWS::Glue::Table': writeGlueTable,
  'AWS::Glue::Classifier': writeGlueClassifier,
  'AWS::Glue::Workflow': writeGlueWorkflow,
  'AWS::Glue::Connection': writeGlueConnection,
  'AWS::SES::ReceiptRule': writeSesReceiptRule,
  'AWS::CloudWatch::AnomalyDetector': writeCloudWatchAnomalyDetector,
  'AWS::DLM::LifecyclePolicy': writeDlmLifecyclePolicy,
  'AWS::Logs::MetricFilter': writeMetricFilter,
  'AWS::Route53::RecordSet': writeRoute53RecordSet,
  'AWS::DocDB::DBCluster': writeDocDbCluster,
  'AWS::DocDB::DBInstance': writeDocDbInstance,
  'AWS::ServiceDiscovery::HttpNamespace': writeServiceDiscoveryHttpNamespace,
  'AWS::S3::BucketPolicy': writeS3BucketPolicy,
  'AWS::SNS::TopicPolicy': writeSnsTopicPolicy,
  'AWS::SQS::QueuePolicy': writeSqsQueuePolicy,
  'AWS::Events::EventBusPolicy': writeEventBusPolicy,
  'AWS::IAM::Policy': writeIamPolicy,
  'AWS::IAM::ManagedPolicy': writeIamManagedPolicy,
};

// Property-scoped SDK writers: CC-writable types where ONE property must be
// reverted via the type's own SDK instead of a Cloud Control patch. Keyed by
// resource type -> EXACT top-level finding path. Deeper paths (e.g. a declared
// drift at Policies.0...) still go through Cloud Control as before.
export const SDK_PROP_WRITERS: Record<string, Record<string, SdkWriter>> = {
  'AWS::Cognito::IdentityPool': { CognitoEvents: writeCognitoIdentityPoolEvents },
  'AWS::Config::ConfigRule': { InputParameters: writeConfigRuleInputParameters },
  'AWS::MSK::Configuration': { ServerProperties: writeMskConfiguration },
  'AWS::IAM::Role': { Policies: writeIamRoleInlinePolicies },
  'AWS::Logs::LogGroup': { BearerTokenAuthenticationEnabled: writeLogGroupBearerTokenAuth },
  'AWS::ElasticLoadBalancingV2::LoadBalancer': {
    LoadBalancerAttributes: writeElbLoadBalancerAttributes,
  },
  'AWS::ElasticLoadBalancingV2::TargetGroup': {
    TargetGroupAttributes: writeElbTargetGroupAttributes,
  },
};

// Re-point an RFC6902 pointer's IDENTITY-bracket array segments (`/Prop[<id>]/sub`, which
// Cloud Control would read as a literal key named `Prop[<id>]`) to the matching LIVE-array
// INDEX (`/Prop/<index>/sub`, a valid pointer CC applies read-modify-write). The index is
// located by the array's identity field (NESTED_ARRAY_IDENTITY override, else the generic
// identityField) against the live model — the SAME model CC will read-modify-write, so the
// index aligns. This is why an array-element nested value IS revertable via CC after all
// (R78 abandoned index patches against the DECLARED subset, whose indices differ from live;
// here we index the LIVE array). Throws if a segment can't be located → an honest revert
// failure, never a wrong write.
function reindexNestedPointer(
  pointer: string,
  live: Record<string, unknown>,
  resourceType: string
): string {
  const out: string[] = [];
  let node: unknown = live;
  let dotted = '';
  for (const raw of pointer.split('/').slice(1)) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    const m = seg.match(/^(.+)\[(.+)\]$/);
    if (m) {
      const prop = m[1] as string;
      const id = m[2] as string;
      const arrPath = dotted ? `${dotted}.${prop}` : prop;
      const arr =
        node && typeof node === 'object' ? (node as Record<string, unknown>)[prop] : undefined;
      if (!Array.isArray(arr)) throw new Error(`cannot resolve array "${arrPath}" for ${pointer}`);
      const idField = NESTED_ARRAY_IDENTITY[resourceType]?.[arrPath] ?? identityField(arr);
      const idx = idField
        ? arr.findIndex(
            (el) =>
              el &&
              typeof el === 'object' &&
              String((el as Record<string, unknown>)[idField]) === id
          )
        : -1;
      if (idx < 0) throw new Error(`cannot locate ${arrPath}[${id}] in live ${resourceType}`);
      out.push(ptrEscape(prop), String(idx));
      node = arr[idx];
      dotted = arrPath;
    } else {
      out.push(ptrEscape(seg));
      node = node && typeof node === 'object' ? (node as Record<string, unknown>)[seg] : undefined;
      dotted = dotted ? `${dotted}.${seg}` : seg;
    }
  }
  return `/${out.join('/')}`;
}

// Revert an array-element nested value (e.g. Backup BackupPlanRule[<RuleName>].window,
// Route53Resolver FirewallRules[<Priority>].setting) via Cloud Control: GetResource for the
// live model, re-point each op's identity-bracket to the live-array index (reindexNestedPointer),
// then one UpdateResource. CC-mutable types only (Backup / Route53Resolver) — proven live.
const writeCloudControlIndexNested: SdkWriter = async (ctx, ops) => {
  const type = ctx.resourceType;
  if (!type) throw new Error('writeCloudControlIndexNested: resourceType missing on ctx');
  // Address the resource by the resolved Cloud Control identifier (the composite the READ
  // path builds via CC_IDENTIFIER_ADAPTERS — e.g. AWS::ApiGateway::Stage `RestApiId|
  // StageName`), not the bare CFn physical id, or CC ValidationExceptions. Falls back to the
  // physical id when no adapter applies (single-segment types: Backup plan, Route53 group).
  const identifier = ctx.identifier ?? ctx.physicalId;
  const cc = new CloudControlClient({ region: ctx.region });
  const got = await cc.send(new GetResourceCommand({ TypeName: type, Identifier: identifier }));
  const live = JSON.parse(got.ResourceDescription?.Properties ?? '{}') as Record<string, unknown>;
  const patch = ops.map((op) => {
    const path = reindexNestedPointer(op.path, live, type);
    return op.op === 'remove' ? { op: op.op, path } : { op: op.op, path, value: op.value };
  });
  await cc.send(
    new UpdateResourceCommand({
      TypeName: type,
      Identifier: identifier,
      PatchDocument: JSON.stringify(patch),
    })
  );
};

// SDK writers for NESTED finding paths (a sub-key inside a declared object — dotted or
// array-element). Unlike SDK_PROP_WRITERS, which keys on an EXACT top-level finding path,
// these match by PREDICATE because the targetable knob is deep (e.g. an ApiGateway Method's
// Integration.IntegrationResponses[<statusCode>].SelectionPattern). A matching nested path is
// (a) exempt from the "nested undeclared is record-only" revert bar (plan.ts) and (b) routed
// to the writer, which translates each op to the type's native granular API.
export interface NestedWriterSpec {
  match: (path: string) => boolean;
  writer: SdkWriter;
}
export const SDK_NESTED_WRITERS: Record<string, NestedWriterSpec> = {
  'AWS::ApiGateway::Method': {
    match: isApiGatewayMethodKnobPath,
    writer: writeApiGatewayMethod,
  },
  // Any drift UNDER the writeOnly ServiceConnectConfiguration / VolumeConfigurations
  // re-supplies the whole declared prop via ecs:UpdateService (CC cannot sub-path patch
  // a writeOnly prop).
  'AWS::ECS::Service': {
    match: (p) =>
      p === 'ServiceConnectConfiguration' ||
      p.startsWith('ServiceConnectConfiguration.') ||
      p === 'VolumeConfigurations' ||
      p.startsWith('VolumeConfigurations.') ||
      p.startsWith('VolumeConfigurations['),
    writer: writeEcsServiceWriteOnlyProps,
  },
  // Array-element nested rule settings (keyed by RuleName / Priority — descended via
  // NESTED_ARRAY_IDENTITY). CC-mutable, so revert via the generic Cloud Control index-revert:
  // the identity bracket is re-pointed to the live-array index, which CC applies. Proven live.
  'AWS::Backup::BackupPlan': {
    match: (p) => p.startsWith('BackupPlan.BackupPlanRule['),
    writer: writeCloudControlIndexNested,
  },
  'AWS::Route53Resolver::FirewallRuleGroup': {
    match: (p) => p.startsWith('FirewallRules['),
    writer: writeCloudControlIndexNested,
  },
  // A multi-region secret's replica KmsKeyId (keyed by Region — descended via
  // NESTED_ARRAY_IDENTITY). CC-mutable, so revert re-points the identity bracket to the
  // live-array index. Proven live.
  'AWS::SecretsManager::Secret': {
    match: (p) => p.startsWith('ReplicaRegions['),
    writer: writeCloudControlIndexNested,
  },
  // A REST API stage's per-method caching/metrics knobs (keyed by HttpMethod — descended
  // via NESTED_ARRAY_IDENTITY). CC-mutable, so revert re-points the identity bracket to the
  // live-array index. Proven live.
  'AWS::ApiGateway::Stage': {
    match: (p) => p.startsWith('MethodSettings['),
    writer: writeCloudControlIndexNested,
  },
};

// dotted finding path for a revert op's RFC6902 pointer (`/A/B[x]/c` -> `A.B[x].c`).
function pointerToDotted(pointer: string): string {
  return pointer
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');
}

/** Resolve the SDK writer for a kind='sdk' revert item: the whole-type writer, the
 *  property-scoped writer matching the item's ops (all ops in a prop-scoped item share one
 *  top-level pointer — plan.ts groups by exact finding path), or a nested-path writer whose
 *  predicate matches the ops' (deep) finding path. */
export function resolveSdkWriter(resourceType: string, ops: PatchOp[]): SdkWriter | undefined {
  const whole = SDK_WRITERS[resourceType];
  if (whole) return whole;
  const byProp = SDK_PROP_WRITERS[resourceType];
  const top = ops[0]?.path.split('/')[1]?.replace(/~1/g, '/').replace(/~0/g, '~');
  if (byProp && top && byProp[top]) return byProp[top];
  const nested = SDK_NESTED_WRITERS[resourceType];
  if (nested && ops[0] && nested.match(pointerToDotted(ops[0].path))) return nested.writer;
  return undefined;
}

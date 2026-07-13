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
  UpdateRestApiCommand,
} from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayV2Client,
  DeleteAccessLogSettingsCommand,
  DeleteRouteSettingsCommand,
  type RouteSettings,
  UpdateStageCommand as UpdateApiGatewayV2StageCommand,
} from '@aws-sdk/client-apigatewayv2';
import { AppSyncClient, DeleteApiKeyCommand } from '@aws-sdk/client-appsync';
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
  GetResourceRequestStatusCommand,
  type ProgressEvent,
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
  DescribeSignalingChannelCommand,
  DescribeStreamCommand,
  KinesisVideoClient,
  type DefaultStorageTier,
  UpdateDataRetentionCommand,
  UpdateSignalingChannelCommand,
  UpdateStreamStorageConfigurationCommand,
} from '@aws-sdk/client-kinesis-video';
import { KMSClient, RevokeGrantCommand } from '@aws-sdk/client-kms';
import {
  ElasticBeanstalkClient,
  UpdateApplicationCommand,
  UpdateApplicationResourceLifecycleCommand,
  UpdateEnvironmentCommand,
} from '@aws-sdk/client-elastic-beanstalk';
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
  type ConfigurationRecorder,
  ConfigServiceClient,
  DescribeConfigRulesCommand,
  PutConfigRuleCommand,
  PutConfigurationRecorderCommand,
  type RecordingModeOverride,
  type ResourceType,
} from '@aws-sdk/client-config-service';
import { KafkaClient, UpdateConfigurationCommand } from '@aws-sdk/client-kafka';
import {
  CodeBuildClient,
  type ReportExportConfig,
  type Tag as CodeBuildTag,
  UpdateReportGroupCommand,
} from '@aws-sdk/client-codebuild';
import {
  DAXClient,
  UpdateClusterCommand,
  UpdateParameterGroupCommand as UpdateDaxParameterGroupCommand,
} from '@aws-sdk/client-dax';
import {
  ElastiCacheClient,
  ModifyCacheParameterGroupCommand,
  ResetCacheParameterGroupCommand,
} from '@aws-sdk/client-elasticache';
import {
  MemoryDBClient,
  ResetParameterGroupCommand as ResetMemoryDbParameterGroupCommand,
  UpdateParameterGroupCommand as UpdateMemoryDbParameterGroupCommand,
} from '@aws-sdk/client-memorydb';
import { EC2Client, ModifyClientVpnEndpointCommand } from '@aws-sdk/client-ec2';
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
import {
  BuildBotLocaleCommand,
  CreateIntentCommand,
  type CreateIntentCommandInput,
  CreateSlotCommand,
  type CreateSlotCommandInput,
  CreateSlotTypeCommand,
  type CreateSlotTypeCommandInput,
  DeleteIntentCommand,
  DeleteSlotCommand,
  DeleteSlotTypeCommand,
  DescribeBotLocaleCommand,
  DescribeIntentCommand,
  DescribeSlotCommand,
  DescribeSlotTypeCommand,
  LexModelsV2Client,
  ListIntentsCommand,
  ListSlotsCommand,
  ListSlotTypesCommand,
  type IntentSummary,
  type SlotSummary,
  type SlotTypeSummary,
  type SlotValueElicitationSetting,
  UpdateBotLocaleCommand,
  type UpdateBotLocaleCommandInput,
  UpdateIntentCommand,
  UpdateSlotCommand,
  UpdateSlotTypeCommand,
  type UpdateSlotTypeCommandInput,
  type VoiceSettings,
} from '@aws-sdk/client-lex-models-v2';
import { ChangeResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import { DeleteBucketPolicyCommand, PutBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DeleteResourcePolicyCommand as SecretsDeleteResourcePolicyCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  ServiceDiscoveryClient,
  UpdateHttpNamespaceCommand,
} from '@aws-sdk/client-servicediscovery';
import { SetTopicAttributesCommand, SNSClient } from '@aws-sdk/client-sns';
import { SetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { partitionForRegion } from '../desired/template-adapter.js';
import { NESTED_ARRAY_IDENTITY } from '../diff/classify.js';
import { deepEqual } from '../diff/drift-calculator.js';
import { identityField } from '../normalize/noise.js';
import { canonicalizeForCompare } from '../normalize/pipeline.js';
import { pageResourceRecordSets, route53RecordSetIdentifier } from '../read/child-enumerators.js';
import { CLIENT_TIMEOUTS } from '../read/client-config.js';
import {
  DLM_DEFAULT_POLICY_SHORTHAND,
  type OverrideCtx,
  SDK_OVERRIDES,
} from '../read/overrides.js';
import { applyOps } from './apply-ops.js';
import { hasArrayIndexSegment, type PatchOp, POINTER_ABSENT, rawValueAtPointer } from './plan.js';
import { classifyTransient, errorText } from './transient.js';

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

// Top-level JSON-pointer segment of an op path (`/EBSOptions/VolumeSize` -> `EBSOptions`,
// `/Description` -> `Description`). Empty string for a `/` or malformed path.
const opTopSeg = (path: string): string => path.replace(/^\//, '').split('/')[0] ?? '';

// #804 — a whole-type SDK writer that only honors an INTERNAL allowlist of top-level props
// must NOT silently drop an op outside that allowlist while reporting `reverted:`. The caller
// (stack-actions.ts) records `ok:false` when a writer THROWS, surfacing the finding as still
// unreverted; a silent `if (!any) return` instead prints a false success while AWS is
// unchanged and the drift persists forever. Compare the incoming ops' top-level path segments
// against the set the writer actually handles and, for any unhandled one, throw an honest
// failure naming the dropped prop(s). `handled` may be a Set of top segments or a predicate.
// Call this at the END of an allowlist writer (after it has done every write it can), so the
// convergeable ops still land and only the genuinely-dropped ones are reported not-reverted.
const assertOpsConsumed = (
  resourceType: string,
  ops: PatchOp[],
  handled: Set<string> | ((topSeg: string) => boolean)
): void => {
  const isHandled = typeof handled === 'function' ? handled : (s: string) => handled.has(s);
  const dropped = [...new Set(ops.map((o) => opTopSeg(o.path)).filter((s) => !isHandled(s)))];
  if (dropped.length > 0)
    throw new Error(
      `${resourceType} revert cannot apply ${dropped.join(', ')}: this SDK writer supports only ` +
        `a subset of properties and does not handle ${dropped.length > 1 ? 'these' : 'this one'}; ` +
        `update ${dropped.length > 1 ? 'them' : 'it'} manually`
    );
};

// #805: a whole-document SDK writer that re-reads and re-canonicalizes the live model at apply
// time (desiredModel below, writeWafv2WebAcl) fixes raw-vs-canonical ORDER, not index FRESHNESS.
// A revert op's numeric index (e.g. `/PolicyDocument/Statement/1/Resource`, `/Rules/1/Action`)
// was computed against the CHECK-time model. If a statement/rule was added, removed, or reordered
// while the user sat on the confirm prompt (the #760 mutation point), the canonically-sorted FRESH
// array puts a DIFFERENT element at that index -> the whole-document PUT (PutBucketPolicy /
// PutRolePolicy via SetTopicAttributes/SetQueueAttributes / UpdateWebACL) would corrupt an
// innocent (security-relevant) element AND write it, while leaving the real drift unreverted.
// Every op carries `prior` (the check-time live value = the finding's `f.actual`), and both the
// prior and the freshly-read model are canonicalized the SAME way (this is the very model the
// following applyOps mutates), so before applying an index-bearing op assert the fresh node at its
// pointer still deep-equals `prior`. On mismatch — or if the index shifted away entirely
// (POINTER_ABSENT) — abort the whole item (the writer throws, stack-actions.ts records `ok:false`,
// an honest FAILED) so the user re-runs check. Fail-closed: a false abort merely declines to write;
// it never corrupts. This is the SDK-path twin of #762/#853's Cloud Control `test` precondition
// (which the CC path already carries in toPatchDocument; #762's text wrongly assumed the SDK
// re-read guarded freshness — it only aligns order). Non-indexed scalar pointers carry no aliasing
// risk (a named property is stable regardless of array order), so they are not checked.
export function assertIndexedPriorsFresh(
  resourceType: string,
  freshModel: Record<string, unknown>,
  ops: readonly PatchOp[]
): void {
  for (const { path, prior } of ops) {
    // A `prior` of undefined is nothing to assert against (RFC6902 has no "undefined"): an
    // append at a new index, or an op the plan built without a check-time value.
    if (!hasArrayIndexSegment(path) || prior === undefined) continue;
    const fresh = rawValueAtPointer(freshModel, path);
    if (fresh === POINTER_ABSENT || !deepEqual(fresh, prior))
      throw new Error(
        `${resourceType} revert aborted: the live value at ${path} changed since check ` +
          `(an element was added, removed, or reordered) — re-run check and revert again`
      );
  }
}

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
  // #805: fail-closed if an index-bearing op's target element changed since check.
  assertIndexedPriorsFresh(type, aligned, ops);
  return applyOps(aligned, ops);
}
const policyJson = (m: Record<string, unknown>): string | undefined =>
  m.PolicyDocument === undefined ? undefined : JSON.stringify(m.PolicyDocument);

const writeS3BucketPolicy: SdkWriter = async (ctx, ops) => {
  const bucket = str(ctx.declared['Bucket']);
  if (!bucket) throw new Error('cannot resolve bucket for revert');
  const desired = policyJson(await desiredModel('AWS::S3::BucketPolicy', ctx, ops));
  const c = new S3Client({ region: ctx.region, ...CLIENT_TIMEOUTS });
  if (desired === undefined) await c.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
  else await c.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: desired }));
};

const writeSnsTopicPolicy: SdkWriter = async (ctx, ops) => {
  const topics = strList(ctx.declared['Topics']);
  if (topics.length === 0) throw new Error('cannot resolve topic for revert');
  const desired = policyJson(await desiredModel('AWS::SNS::TopicPolicy', ctx, ops)) ?? '';
  const c = new SNSClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
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
  const c = new SQSClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
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
  const c = new EventBridgeClient({ region: ctx.region, ...CLIENT_TIMEOUTS });

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
    // Partition is a function of the region — GovCloud (`aws-us-gov`) / China (`aws-cn`)
    // need their own ARN prefix, else the reverted statement never matches / is rejected (#865).
    const { partition } = partitionForRegion(ctx.region);
    desiredStatement = {
      Sid: statementId,
      Effect: 'Allow',
      Principal: principal === '*' ? '*' : { AWS: `arn:${partition}:iam::${principal}:root` },
      Action: action,
      Resource: `arn:${partition}:events:${ctx.region}:${ctx.accountId}:event-bus/${eventBusName}`,
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
  const c = new IAMClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
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
  const c = new IAMClient({ region: ctx.region, ...CLIENT_TIMEOUTS });

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
  const c = new IAMClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
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
  await new ElasticLoadBalancingV2Client({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
    new ModifyLoadBalancerAttributesCommand({ LoadBalancerArn: arn, Attributes: attrs })
  );
};

const writeElbTargetGroupAttributes: SdkWriter = async (ctx, ops) => {
  const arn = str(ctx.physicalId);
  if (!arn) throw new Error('cannot resolve target group arn for revert');
  const attrs = elbAttributeOps(ops);
  if (attrs.length === 0) return;
  await new ElasticLoadBalancingV2Client({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
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
  await new ServiceDiscoveryClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
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
    if (!top || !DOCDB_CLUSTER_MODIFY_PARAMS.has(top)) continue;
    if (desired[top] !== undefined) {
      input[top] = desired[top];
    } else {
      // A `remove` op (the desired value is now ABSENT) needs an EXPLICIT clearing value, or
      // ModifyDBCluster — a selective/partial modify — keeps the live value and the revert
      // silently non-converges (#913). DeletionProtection clears with an explicit `false`
      // (ModifyDBCluster accepts DeletionProtection=false); BackupRetentionPeriod /
      // PreferredBackupWindow / PreferredMaintenanceWindow / Port have NO expressible selective
      // clear (AWS-assigned / required), so bar them honestly.
      if (top === 'DeletionProtection') input.DeletionProtection = false;
      else
        throw new Error(
          `DocDB DBCluster ${top} cannot be cleared via ModifyDBCluster (its unset state is AWS-assigned/required, not expressible in a selective modify); update it manually`
        );
    }
    any = true;
  }
  // Send the convergeable (allowlist) ops FIRST, then report any op outside the allowlist as
  // NOT reverted (#804) — a silent no-op here would print a false `reverted:`.
  if (any)
    await new DocDBClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
      new ModifyDBClusterCommand(input)
    );
  assertOpsConsumed('DocDB DBCluster', ops, DOCDB_CLUSTER_MODIFY_PARAMS);
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
    if (!top || !DOCDB_INSTANCE_MODIFY_PARAMS.has(top)) continue;
    if (desired[top] !== undefined) {
      input[top] = desired[top];
    } else {
      // A `remove` op needs an EXPLICIT clearing value, or ModifyDBInstance — a selective/partial
      // modify — keeps the live value and the revert silently non-converges (#913).
      // EnablePerformanceInsights clears with an explicit `false` (ModifyDBInstance accepts it);
      // DBInstanceClass / PreferredMaintenanceWindow / CACertificateIdentifier have NO expressible
      // selective clear (AWS-assigned / required), so bar them honestly.
      if (top === 'EnablePerformanceInsights') input.EnablePerformanceInsights = false;
      else
        throw new Error(
          `DocDB DBInstance ${top} cannot be cleared via ModifyDBInstance (its unset state is AWS-assigned/required, not expressible in a selective modify); update it manually`
        );
    }
    any = true;
  }
  if (any)
    await new DocDBClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
      new ModifyDBInstanceCommand(input)
    );
  assertOpsConsumed('DocDB DBInstance', ops, DOCDB_INSTANCE_MODIFY_PARAMS);
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
  const c = new CloudFrontClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
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
  const c = new WAFV2Client({ region: ctx.region, ...CLIENT_TIMEOUTS });
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
  const canonWebAcl = canonicalizeForCompare(
    cur.WebACL as unknown as Record<string, unknown>
  ) as Record<string, unknown>;
  // #805: fail-closed if a Rule was added/removed/reordered since check, so an indexed op
  // (`/Rules/1/Action`) can no longer corrupt whatever rule now sits at that sorted index.
  assertIndexedPriorsFresh('AWS::WAFv2::WebACL', canonWebAcl, ops);
  const m = applyOps(canonWebAcl, ops);
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
  const c = new GlueClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
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
  // #804 — an op on a prop outside the JobUpdate field set (e.g. read-only CreatedOn, or a
  // prop this writer does not model) is applied to `m` then dropped by the explicit field
  // copy; report it not-reverted rather than a false `reverted:`. MaxCapacity/AllocatedCapacity
  // ARE handled (for a non-WorkerType job) so they are in the handled set.
  assertOpsConsumed(
    'Glue Job',
    ops,
    (top) =>
      (GLUE_JOB_UPDATE_FIELDS as readonly string[]).includes(top) ||
      top === 'MaxCapacity' ||
      top === 'AllocatedCapacity'
  );
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
  await new GlueClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
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
  await new GlueClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
    new UpdateClassifierCommand(input as never)
  );
};

// AWS::Glue::Workflow — read via the GetWorkflow override (CC UnsupportedActionException),
// so it was not revertable. Glue UpdateWorkflow takes the mutable props (Description /
// DefaultRunProperties / MaxConcurrentRuns); reconstruct the desired model (current + revert
// ops) and write the present ones back, targeting by the declared/physical Name.
const writeGlueWorkflow: SdkWriter = async (ctx, ops) => {
  const m = await desiredModel('AWS::Glue::Workflow', ctx, ops);
  const name = str(m.Name) ?? str(ctx.physicalId) ?? str(ctx.declared['Name']);
  if (!name) throw new Error('cannot resolve Glue workflow target for revert');
  // A `remove` op (revert of an OOB-added value back to unset) must send an EXPLICIT clearing
  // value — UpdateWorkflow is a selective update, so an omitted field keeps the live value and
  // the revert silently non-converges (#913). Description clears with '' and DefaultRunProperties
  // with {} (both expressible clears); MaxConcurrentRuns has NO selective clear (its unset state,
  // "no limit", cannot be sent as a number), so bar it honestly.
  const removed = (field: string): boolean =>
    ops.some((o) => o.op === 'remove' && o.path.replace(/^\//, '').split('/')[0] === field);
  if (removed('MaxConcurrentRuns'))
    throw new Error(
      'Glue Workflow MaxConcurrentRuns cannot be cleared via UpdateWorkflow (its unset state, "no limit", is not expressible in a selective update); update it manually'
    );
  const input: { Name: string; [k: string]: unknown } = { Name: name };
  if (m.Description !== undefined) input.Description = str(m.Description);
  else if (removed('Description')) input.Description = '';
  if (m.DefaultRunProperties !== undefined)
    input.DefaultRunProperties = m.DefaultRunProperties as Record<string, string>;
  else if (removed('DefaultRunProperties')) input.DefaultRunProperties = {};
  if (m.MaxConcurrentRuns !== undefined) input.MaxConcurrentRuns = Number(m.MaxConcurrentRuns);
  await new GlueClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
    new UpdateWorkflowCommand(input)
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
  await new GlueClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
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
  await new SESClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
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
  await new CloudWatchClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
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
  // A top-level `remove` op (State / Description / ExecutionRoleArn back to unset) has NO safe
  // selective-update clearing value: UpdateLifecyclePolicy always requires a State, and whether an
  // undeclared State / Description / ExecutionRoleArn even folds (so an OOB change surfaces as a
  // `remove`) is UNCONFIRMED live. Rather than silently omit the field — which keeps the live value
  // and non-converges (#913) — fail honestly; the declared-value case still converges via the
  // `add` path below. (Needs-live: confirm the fold + the exact clearing payload before turning any
  // of these into a real clear.)
  for (const o of ops) {
    const top = o.path.replace(/^\//, '').split('/')[0] ?? '';
    if (
      o.op === 'remove' &&
      (top === 'State' || top === 'Description' || top === 'ExecutionRoleArn')
    )
      throw new Error(
        `DLM LifecyclePolicy ${top} cannot be cleared via UpdateLifecyclePolicy (no safe clearing value; needs live confirmation); update it manually`
      );
  }
  const c = new DLMClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
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
  await new CloudWatchLogsClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
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
  await new Route53Client({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
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
  if (!op) throw new Error('Config rule InputParameters revert: op not found');
  // An OOB-ADDED InputParameters blob on a rule that declared none reverts as a `remove`. Config
  // stores InputParameters as a whole-rule field, and clearing it needs a re-PUT — but whether the
  // clear is "omit InputParameters" or "'{}'" is UNCONFIRMED live. Rather than silently drop the op
  // (a non-converge, #913), fail honestly; an `add` (declared value) converges below.
  if (op.op !== 'add')
    throw new Error(
      'Config rule InputParameters cannot be cleared via revert: PutConfigRule re-PUTs the whole rule and the exact clearing payload (omit vs empty {}) needs live confirmation; clear it manually'
    );
  const client = new ConfigServiceClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
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

// AWS::Config::ConfigurationRecorder — NON_PROVISIONABLE: Cloud Control throws
// UnsupportedActionException for its read AND write (#1553), so a declared drift (a changed
// RecordingGroup / RecordingMode / RoleARN — e.g. someone widening what Config records out of
// band) is reverted via config:PutConfigurationRecorder, a whole-recorder UPSERT. desiredModel
// re-reads the live recorder (the SDK override) and applies the revert ops, so we PUT the
// reverted-to-declared model, mapped PascalCase(CFn) -> camelCase(SDK). The recorder Name
// (createOnly) and RoleARN are preserved from the live read. RecordingStrategy is OMITTED from
// the PUT — AWS DERIVES it from the recording group and rejects an inconsistent one, so leaving
// it out lets AWS recompute it (the same value the reader folds atDefault). Live-verified
// 2026-07-13 (us-west-2). A whole-resource writer (SDK_WRITERS), so any declared-prop drift on
// the recorder routes here.
const writeConfigConfigurationRecorder: SdkWriter = async (ctx, ops) => {
  const desired = await desiredModel('AWS::Config::ConfigurationRecorder', ctx, ops);
  const name = str(desired.Name) ?? str(ctx.physicalId);
  const roleARN = str(desired.RoleARN);
  if (!name) throw new Error('cannot resolve Config recorder name for revert');
  if (!roleARN) throw new Error('cannot resolve Config recorder RoleARN for revert');
  const recorder: ConfigurationRecorder = { name, roleARN };
  const rg = desired.RecordingGroup as Record<string, unknown> | undefined;
  if (rg) {
    const group: NonNullable<ConfigurationRecorder['recordingGroup']> = {};
    if (typeof rg.AllSupported === 'boolean') group.allSupported = rg.AllSupported;
    if (typeof rg.IncludeGlobalResourceTypes === 'boolean')
      group.includeGlobalResourceTypes = rg.IncludeGlobalResourceTypes;
    if (Array.isArray(rg.ResourceTypes)) group.resourceTypes = rg.ResourceTypes as ResourceType[];
    const excl = rg.ExclusionByResourceTypes as Record<string, unknown> | undefined;
    if (excl && Array.isArray(excl.ResourceTypes) && excl.ResourceTypes.length > 0)
      group.exclusionByResourceTypes = { resourceTypes: excl.ResourceTypes as ResourceType[] };
    // RecordingStrategy is intentionally omitted — AWS re-derives it from the group above.
    recorder.recordingGroup = group;
  }
  const rm = desired.RecordingMode as Record<string, unknown> | undefined;
  if (rm && str(rm.RecordingFrequency)) {
    const mode: NonNullable<ConfigurationRecorder['recordingMode']> = {
      recordingFrequency: rm.RecordingFrequency as NonNullable<
        ConfigurationRecorder['recordingMode']
      >['recordingFrequency'],
    };
    const overrides = rm.RecordingModeOverrides;
    if (Array.isArray(overrides) && overrides.length > 0)
      mode.recordingModeOverrides = overrides.map((o): RecordingModeOverride => {
        const oo = o as Record<string, unknown>;
        return {
          resourceTypes: oo.ResourceTypes as ResourceType[],
          recordingFrequency: oo.RecordingFrequency as RecordingModeOverride['recordingFrequency'],
          ...(str(oo.Description) ? { description: oo.Description as string } : {}),
        };
      });
    recorder.recordingMode = mode;
  }
  await new ConfigServiceClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
    new PutConfigurationRecorderCommand({ ConfigurationRecorder: recorder })
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
  const c = new OpenSearchClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
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
  // #804 — EngineVersion / Tags (and any other prop outside OS_UPDATABLE_OPTIONS) are dropped
  // by UpdateDomainConfig here; report them not-reverted rather than a false `reverted:`.
  assertOpsConsumed('OpenSearch Domain', ops, OS_UPDATABLE_OPTIONS);
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
  const c = new CloudWatchLogsClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
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
  const c = new CognitoSyncClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
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
  const c = new APIGatewayClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
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
  // #804 — a silent `return` here (the only writer that did) prints a false `reverted:` when the
  // target cannot be resolved (a raw-CFn service on the DEFAULT cluster declares no Cluster).
  // Fail honestly like every sibling writer so the finding stays surfaced as not-reverted.
  if (!cluster || !service) throw new Error('cannot resolve ECS cluster/service for revert');
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
  const c = new ECSClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
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
  const client = new KafkaClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
  await client.send(
    new UpdateConfigurationCommand({
      Arn: arn,
      ServerProperties: new TextEncoder().encode(op.value),
    })
  );
};

// AWS::CodeBuild::ReportGroup — NON_PROVISIONABLE (read via BatchGetReportGroups; #530).
// codebuild:UpdateReportGroup re-supplies the two mutable props (exportConfig / tags) WHOLESALE
// — the reader's projected shape maps back 1:1 (PascalCase CFn → camelCase API). Always send both
// desired sub-objects so reverting a Tags-only drift never wipes the ExportConfig and vice-versa;
// they reflect the intended (declared-or-current) full state (desiredModel = live + revert ops).
// Type is create-only (not modifiable), so it never reaches here. #552.
const writeCodeBuildReportGroup: SdkWriter = async (ctx, ops) => {
  const arn = str(ctx.physicalId);
  if (!arn) throw new Error('cannot resolve CodeBuild ReportGroup ARN for revert');
  const desired = await desiredModel('AWS::CodeBuild::ReportGroup', ctx, ops);
  const input: { arn: string; exportConfig?: ReportExportConfig; tags?: CodeBuildTag[] } = { arn };
  const ec = desired.ExportConfig as Record<string, unknown> | undefined;
  if (ec) {
    const s3 = ec.S3Destination as Record<string, unknown> | undefined;
    input.exportConfig = {
      exportConfigType: ec.ExportConfigType as ReportExportConfig['exportConfigType'],
      ...(s3
        ? {
            s3Destination: {
              bucket: str(s3.Bucket),
              path: str(s3.Path),
              packaging: str(s3.Packaging) as
                | NonNullable<ReportExportConfig['s3Destination']>['packaging']
                | undefined,
              encryptionKey: str(s3.EncryptionKey),
              encryptionDisabled:
                typeof s3.EncryptionDisabled === 'boolean' ? s3.EncryptionDisabled : undefined,
            },
          }
        : {}),
    };
  }
  const tags = desired.Tags as { Key?: unknown; Value?: unknown }[] | undefined;
  // Always send tags (empty list clears them) so a removed/edited tag reverts; omitting it would
  // leave AWS's current tags untouched (UpdateReportGroup replaces the tag set wholesale).
  input.tags = Array.isArray(tags)
    ? tags.map((t) => ({ key: str(t.Key), value: str(t.Value) }))
    : [];
  await new CodeBuildClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
    new UpdateReportGroupCommand(input)
  );
};

// AWS::DAX::Cluster — NON_PROVISIONABLE (read via DescribeClusters; #534). dax:UpdateCluster is a
// PARTIAL modify (like ModifyDBCluster): send ONLY the drifted top-level props in the mutable
// allowlist, mapped CFn→API (NotificationTopicARN → NotificationTopicArn). NodeType/ClusterName/
// SubnetGroupName/IAMRoleARN/ClusterEndpointEncryptionType are create-only → never in the
// allowlist. #552.
const DAX_CLUSTER_MODIFY_PARAMS: Record<string, string> = {
  Description: 'Description',
  PreferredMaintenanceWindow: 'PreferredMaintenanceWindow',
  NotificationTopicARN: 'NotificationTopicArn',
  ParameterGroupName: 'ParameterGroupName',
  SecurityGroupIds: 'SecurityGroupIds',
};
const writeDaxCluster: SdkWriter = async (ctx, ops) => {
  const name = str(ctx.physicalId) ?? str(ctx.declared['ClusterName']);
  if (!name) throw new Error('cannot resolve DAX cluster name for revert');
  const desired = await desiredModel('AWS::DAX::Cluster', ctx, ops);
  const input: { ClusterName: string; [k: string]: unknown } = { ClusterName: name };
  let any = false;
  for (const op of ops) {
    const top = op.path.replace(/^\//, '').split('/')[0] ?? '';
    const apiKey = DAX_CLUSTER_MODIFY_PARAMS[top];
    if (!apiKey) continue;
    let val = desired[top];
    if (val === undefined) {
      // A `remove` op (the desired value is now ABSENT) needs an EXPLICIT clearing value, or
      // UpdateCluster — a selective modify — keeps the live value and the revert silently
      // non-converges (#913). NotificationTopicARN / Description clear with '' (detach / unset);
      // PreferredMaintenanceWindow / ParameterGroupName / SecurityGroupIds have NO selective clear
      // (their unset state is an AWS-assigned window / the default param group / the default VPC
      // security group — not expressible here), so bar them honestly.
      if (top === 'NotificationTopicARN' || top === 'Description') val = '';
      else
        throw new Error(
          `DAX Cluster ${top} cannot be cleared via UpdateCluster (its unset state is AWS-assigned, not expressible in a selective modify); update it manually`
        );
    }
    input[apiKey] = val;
    any = true;
  }
  if (!any) return;
  await new DAXClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
    new UpdateClusterCommand(input)
  );
};

// AWS::DAX::ParameterGroup — NON_PROVISIONABLE (read via DescribeParameters; #534).
// dax:UpdateParameterGroup updates ONLY the parameters passed (others untouched), so re-assert
// each DRIFTED parameter to its desired value. The CFn `ParameterNameValues` is a { name → value }
// map; the API takes a [{ ParameterName, ParameterValue }] list. #552.
const writeDaxParameterGroup: SdkWriter = async (ctx, ops) => {
  const name = str(ctx.physicalId) ?? str(ctx.declared['ParameterGroupName']);
  if (!name) throw new Error('cannot resolve DAX parameter-group name for revert');
  // Read the LIVE model directly (not just the post-ops desired): a whole-map `remove` op leaves
  // `desired.ParameterNameValues` empty, so the keys it would (fail to) clear are only knowable
  // from the live map. `desiredModel` = `applyOps(live, ops)`; DAX carries no PolicyDocument, so
  // its canonicalization is a no-op here and applying the ops locally is equivalent.
  const reader = SDK_OVERRIDES['AWS::DAX::ParameterGroup'];
  const live = (reader && (await reader(ctx))) ?? {};
  const liveValues = (live.ParameterNameValues as Record<string, unknown> | undefined) ?? {};
  const desired = applyOps(live, ops);
  const desiredValues = (desired.ParameterNameValues as Record<string, unknown> | undefined) ?? {};
  // Collect the parameter keys the revert ops touch (path `/ParameterNameValues/<key>`), plus a
  // whole-map op (`/ParameterNameValues`). Re-send each from the desired map.
  //
  // A `remove` op reverts an out-of-band-ADDED parameter back to unset. DAX has NO
  // ResetParameterGroup API (unlike ElastiCache/MemoryDB whose writers reset removed keys) —
  // UpdateParameterGroup can only re-assert a value, never clear one — so a `remove` is
  // UN-EXPRESSIBLE. Collect those keys and THROW once (the #928/#1002/#1102 pattern) rather than
  // silently dropping the op and reporting a false `reverted:` (the parameter would never clear).
  // Expressible add/set ops are applied FIRST so a convergeable sibling still lands even alongside
  // an un-expressible remove.
  const keys = new Set<string>();
  const unExpressible = new Set<string>();
  for (const op of ops) {
    const segs = op.path.replace(/^\//, '').split('/');
    if (segs[0] !== 'ParameterNameValues') continue;
    if (segs[1] !== undefined) {
      const key = segs[1].replace(/~1/g, '/').replace(/~0/g, '~');
      if (op.op === 'remove') unExpressible.add(key);
      else keys.add(key);
    } else if (op.op === 'remove') {
      // A whole-map remove clears every currently-set parameter — equally un-expressible. The
      // keys live in the LIVE map (`desiredValues` is already empty post-remove). If the live map
      // is empty there is nothing to clear, so it stays a genuine no-op (no throw).
      for (const k of Object.keys(liveValues)) unExpressible.add(k);
    } else for (const k of Object.keys(desiredValues)) keys.add(k);
  }
  const values = [...keys]
    .filter((k) => typeof desiredValues[k] === 'string')
    .map((k) => ({ ParameterName: k, ParameterValue: desiredValues[k] as string }));
  if (values.length > 0)
    await new DAXClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
      new UpdateDaxParameterGroupCommand({ ParameterGroupName: name, ParameterNameValues: values })
    );
  if (unExpressible.size > 0) {
    const names = [...unExpressible].join(', ');
    throw new Error(
      `DAX ParameterGroup parameter ${names} cannot be cleared via UpdateParameterGroup ` +
        `(DAX has no ResetParameterGroup API, so an out-of-band-added parameter's unset state is not expressible)` +
        `${values.length > 0 ? '; the other revert op(s) were applied' : ''}; ` +
        `update ${unExpressible.size > 1 ? 'them' : 'it'} manually`
    );
  }
};

// AWS::ElastiCache::ParameterGroup — read via an SDK override (describe-cache-parameters
// --source user), so revert needs a matching SDK writer. The CFn `Properties` is a { name →
// value } map. An `add` op reverts a DECLARED parameter that was changed out of band back to
// its desired value via ModifyCacheParameterGroup. A `remove` op reverts an out-of-band-ADDED
// parameter (one the template never declared) back to the family default via
// ResetCacheParameterGroup. Keyed on the `/Properties/<key>` path (or a whole-map `/Properties`
// op → every desired key).
const writeElastiCacheParameterGroup: SdkWriter = async (ctx, ops) => {
  const name = str(ctx.physicalId) ?? str(ctx.declared['CacheParameterGroupName']);
  if (!name) throw new Error('cannot resolve ElastiCache parameter-group name for revert');
  const desired = await desiredModel('AWS::ElastiCache::ParameterGroup', ctx, ops);
  const desiredValues = (desired.Properties as Record<string, unknown> | undefined) ?? {};
  const modifyKeys = new Set<string>();
  const resetKeys = new Set<string>();
  for (const op of ops) {
    const segs = op.path.replace(/^\//, '').split('/');
    if (segs[0] !== 'Properties') continue;
    const key = segs[1]?.replace(/~1/g, '/').replace(/~0/g, '~');
    if (op.op === 'remove') {
      // A whole-map remove is not meaningful here (the group always has the family defaults);
      // only a specific added key is reset.
      if (key !== undefined) resetKeys.add(key);
    } else if (key !== undefined) {
      modifyKeys.add(key);
    } else {
      for (const k of Object.keys(desiredValues)) modifyKeys.add(k);
    }
  }
  const c = new ElastiCacheClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
  const modify = [...modifyKeys]
    .filter((k) => typeof desiredValues[k] === 'string')
    .map((k) => ({ ParameterName: k, ParameterValue: desiredValues[k] as string }));
  if (modify.length > 0) {
    await c.send(
      new ModifyCacheParameterGroupCommand({
        CacheParameterGroupName: name,
        ParameterNameValues: modify,
      })
    );
  }
  const reset = [...resetKeys].map((k) => ({ ParameterName: k }));
  if (reset.length > 0) {
    await c.send(
      new ResetCacheParameterGroupCommand({
        CacheParameterGroupName: name,
        ResetAllParameters: false,
        ParameterNameValues: reset,
      })
    );
  }
};

// AWS::MemoryDB::ParameterGroup — the twin of the ElastiCache writer above, read via an
// SDK_SUPPLEMENTS reader. The CFn `Parameters` is a { name → value } map. An `add` op reverts a
// DECLARED parameter (including one the MemoryDB CFn provider never applied on create) to its
// deployed-template value via UpdateParameterGroup — which is exactly the API call the provider
// skips, so revert actually MATERIALIZES the declared intent. A `remove` op resets an
// out-of-band-added undeclared parameter to the family default via ResetParameterGroup (which
// takes bare `ParameterNames`, unlike ElastiCache's ParameterNameValues). Keyed on the
// `/Parameters/<key>` path (or a whole-map `/Parameters` op → every desired key).
const writeMemoryDbParameterGroup: SdkWriter = async (ctx, ops) => {
  const name = str(ctx.physicalId) ?? str(ctx.declared['ParameterGroupName']);
  if (!name) throw new Error('cannot resolve MemoryDB parameter-group name for revert');
  const desired = await desiredModel('AWS::MemoryDB::ParameterGroup', ctx, ops);
  const desiredValues = (desired.Parameters as Record<string, unknown> | undefined) ?? {};
  const modifyKeys = new Set<string>();
  const resetKeys = new Set<string>();
  for (const op of ops) {
    const segs = op.path.replace(/^\//, '').split('/');
    if (segs[0] !== 'Parameters') continue;
    const key = segs[1]?.replace(/~1/g, '/').replace(/~0/g, '~');
    if (op.op === 'remove') {
      if (key !== undefined) resetKeys.add(key);
    } else if (key !== undefined) {
      modifyKeys.add(key);
    } else {
      for (const k of Object.keys(desiredValues)) modifyKeys.add(k);
    }
  }
  const c = new MemoryDBClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
  const modify = [...modifyKeys]
    .filter((k) => typeof desiredValues[k] === 'string')
    .map((k) => ({ ParameterName: k, ParameterValue: desiredValues[k] as string }));
  if (modify.length > 0) {
    await c.send(
      new UpdateMemoryDbParameterGroupCommand({
        ParameterGroupName: name,
        ParameterNameValues: modify,
      })
    );
  }
  const reset = [...resetKeys];
  if (reset.length > 0) {
    await c.send(
      new ResetMemoryDbParameterGroupCommand({
        ParameterGroupName: name,
        AllParameters: false,
        ParameterNames: reset,
      })
    );
  }
};

// AWS::EC2::ClientVpnEndpoint — NON_PROVISIONABLE (read via DescribeClientVpnEndpoints; #534).
// ec2:ModifyClientVpnEndpoint is a PARTIAL modify: send ONLY the drifted top-level props in the
// mutable allowlist. Two props need reshaping vs the reader's projection: DnsServers (the read is
// a plain string[]; modify takes a DnsServersOptionsModifyStructure { CustomDnsServers, Enabled }),
// and SecurityGroupIds (the API requires VpcId alongside it). ServerCertificateArn/ClientCidrBlock/
// TransportProtocol/VpcId are create-only → not in the allowlist. #552.
const CLIENT_VPN_SCALAR_PARAMS = new Set([
  'Description',
  'SplitTunnel',
  'VpnPort',
  'SessionTimeoutHours',
  'DisconnectOnSessionTimeout',
]);
const writeEc2ClientVpnEndpoint: SdkWriter = async (ctx, ops) => {
  const id = str(ctx.physicalId);
  if (!id) throw new Error('cannot resolve Client VPN endpoint id for revert');
  const desired = await desiredModel('AWS::EC2::ClientVpnEndpoint', ctx, ops);
  const input: { ClientVpnEndpointId: string; [k: string]: unknown } = { ClientVpnEndpointId: id };
  let any = false;
  // Un-expressible clears (a `remove` whose unset state ModifyClientVpnEndpoint cannot express)
  // are COLLECTED here rather than thrown inline: a single un-expressible op must NOT abort the
  // whole batch and drop the CONVERGEABLE sibling ops (#1102 — a `SessionTimeoutHours` remove was
  // aborting the #912 VpnPort set-default that WOULD converge). We apply every expressible op
  // first, then throw ONCE naming what could not be reverted (its live value stays, surfaced by
  // the post-revert convergence re-read).
  const unExpressible: string[] = [];
  const tops = new Set(ops.map((op) => op.path.replace(/^\//, '').split('/')[0] ?? ''));
  // A `remove` op (revert of an OOB-added value back to unset) must send an EXPLICIT clearing value
  // — ModifyClientVpnEndpoint is a selective modify, so an omitted field keeps the live value and
  // the revert silently non-converges (#913). Some clears are expressible, some are not.
  const removed = (field: string): boolean =>
    ops.some((o) => o.op === 'remove' && (o.path.replace(/^\//, '').split('/')[0] ?? '') === field);
  for (const top of tops) {
    if (CLIENT_VPN_SCALAR_PARAMS.has(top)) {
      if (desired[top] !== undefined) {
        input[top] = desired[top];
        any = true;
      } else if (removed(top)) {
        // ModifyClientVpnEndpoint expresses a clear for Description ('') and the booleans
        // (SplitTunnel=false, DisconnectOnSessionTimeout=false); VpnPort / SessionTimeoutHours are
        // numbers with NO expressible unset, so bar them honestly (isolated, not batch-aborting).
        if (top === 'Description') {
          input.Description = '';
          any = true;
        } else if (top === 'SplitTunnel') {
          input.SplitTunnel = false;
          any = true;
        } else if (top === 'DisconnectOnSessionTimeout') {
          input.DisconnectOnSessionTimeout = false;
          any = true;
        } else unExpressible.push(top);
      }
    } else if (top === 'ConnectionLogOptions') {
      if (desired.ConnectionLogOptions !== undefined) {
        input.ConnectionLogOptions = desired.ConnectionLogOptions;
        any = true;
      } else if (removed('ConnectionLogOptions')) unExpressible.push('ConnectionLogOptions');
    } else if (top === 'DnsServers') {
      const list = desired.DnsServers as string[] | undefined;
      // An empty/absent desired list is itself an expressible clear ({Enabled:false}), so a
      // DnsServers `remove` converges honestly here — no bar needed.
      input.DnsServers =
        Array.isArray(list) && list.length > 0
          ? { CustomDnsServers: list, Enabled: true }
          : { Enabled: false };
      any = true;
    } else if (top === 'SecurityGroupIds') {
      const list = desired.SecurityGroupIds as string[] | undefined;
      const vpcId = str(desired.VpcId) ?? str(ctx.declared['VpcId']);
      if (Array.isArray(list) && list.length > 0 && vpcId) {
        input.SecurityGroupIds = list;
        input.VpcId = vpcId;
        any = true;
      } else if (removed('SecurityGroupIds')) unExpressible.push('SecurityGroupIds');
    }
  }
  // Apply the expressible ops FIRST so a convergeable op (e.g. the #912 VpnPort set-default) still
  // lands even alongside an un-expressible sibling; only then report what could not be reverted.
  if (any)
    await new EC2Client({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
      new ModifyClientVpnEndpointCommand(input)
    );
  if (unExpressible.length > 0)
    throw new Error(
      `EC2 ClientVpnEndpoint ${unExpressible.join(', ')} cannot be cleared via ModifyClientVpnEndpoint ` +
        `(unset state is not expressible in a selective modify)${any ? '; the other revert op(s) were applied' : ''}; ` +
        `update ${unExpressible.length > 1 ? 'them' : 'it'} manually`
    );
  // #804 — a prop the writer does not model at all (SelfServicePortal / ClientConnectOptions /
  // ClientLoginBannerOptions) is silently ignored above; report it not-reverted.
  assertOpsConsumed(
    'EC2 ClientVpnEndpoint',
    ops,
    (top) =>
      CLIENT_VPN_SCALAR_PARAMS.has(top) ||
      top === 'ConnectionLogOptions' ||
      top === 'DnsServers' ||
      top === 'SecurityGroupIds'
  );
};

// AWS::Lex::Bot `BotLocales` is the ENTIRE conversational model (locales → intents → slots +
// slot types), writeOnly in the registry schema and read back by supplementLexBot walking the
// lexv2-models DRAFT tree. Cloud Control cannot write it, so revert re-supplies the DECLARED
// model through the lexv2-models write APIs (#553). It converges each EXISTING node (locale
// settings / slot type / intent / slot) to its declared value via a read-modify-write (Describe
// → overlay the declared-projected fields → Update, preserving any un-projected setting), and
// FULLY REBUILDS the structure when the declared and live node-NAME sets differ (#564): a
// declared node missing from live is CREATED (CreateSlotType / CreateIntent / CreateSlot,
// resolving SlotTypeName→id and SlotPriorities after the slots exist) and a live node not in the
// declared set is DELETED (DeleteSlot / DeleteIntent / DeleteSlotType — never the auto-managed
// built-in FallbackIntent). Order: slot types → intents → slots for create (so references
// resolve) and the reverse for delete, then one BuildBotLocale per touched locale. This makes a
// revert able to rebuild the whole conversational model, not just update in place.
const LEX_CFN_TO_LEX_RESOLUTION_STRATEGY: Record<string, string> = {
  ORIGINAL_VALUE: 'OriginalValue',
  TOP_RESOLUTION: 'TopResolution',
  CONCATENATION: 'Concatenation',
};
type LexRec = Record<string, unknown>;
const lexStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
// Map a declared CFn SlotType's SlotTypeValues to the lexv2 slotTypeValues shape (used by both
// the create and update paths). Returns undefined when the property is not a declared array.
const lexMapSlotTypeValues = (dst: LexRec): { sampleValue: { value: string } }[] | undefined =>
  Array.isArray(dst.SlotTypeValues)
    ? (dst.SlotTypeValues as LexRec[]).map((v) => {
        const sv = (v.SampleValue as LexRec | undefined)?.Value;
        const syns = Array.isArray(v.Synonyms)
          ? (v.Synonyms as LexRec[])
              .map((s) => lexStr(s.Value))
              .filter((x): x is string => x !== undefined)
              .map((x) => ({ value: x }))
          : undefined;
        return {
          sampleValue: { value: lexStr(sv) ?? '' },
          ...(syns && syns.length > 0 ? { synonyms: syns } : {}),
        };
      })
    : undefined;
// The lexv2 valueSelectionSetting.resolutionStrategy for a declared SlotType (mapped from the
// CFn enum), or undefined when none is declared.
const lexResolutionStrategy = (dst: LexRec): string | undefined => {
  const strat = lexStr((dst.ValueSelectionSetting as LexRec | undefined)?.ResolutionStrategy);
  return strat === undefined ? undefined : (LEX_CFN_TO_LEX_RESOLUTION_STRATEGY[strat] ?? strat);
};
// Map a declared CFn intent's SampleUtterances to the lexv2 sampleUtterances shape, or undefined.
const lexMapUtterances = (di: LexRec): { utterance: string }[] | undefined =>
  Array.isArray(di.SampleUtterances)
    ? (di.SampleUtterances as LexRec[])
        .map((u) => lexStr(u.Utterance))
        .filter((x): x is string => x !== undefined)
        .map((utterance) => ({ utterance }))
    : undefined;
// Build the lexv2 promptSpecification from a declared CFn PromptSpecification (inverse of the
// reader's projectLexPrompt). Only the fields the reader projects are set.
const lexBuildPrompt = (declared: unknown): LexRec | undefined => {
  if (!declared || typeof declared !== 'object') return undefined;
  const d = declared as LexRec;
  const out: LexRec = {};
  if (typeof d.MaxRetries === 'number') out.maxRetries = d.MaxRetries;
  if (typeof d.AllowInterrupt === 'boolean') out.allowInterrupt = d.AllowInterrupt;
  if (Array.isArray(d.MessageGroupsList)) {
    out.messageGroups = d.MessageGroupsList.map((g) => {
      const value = (g as LexRec)?.Message as LexRec | undefined;
      const plain = value?.PlainTextMessage as LexRec | undefined;
      return { message: { plainTextMessage: { value: lexStr(plain?.Value) ?? '' } } };
    });
  }
  return out;
};
const writeLexBotLocales: SdkWriter = async (ctx, ops) => {
  const botId = str(ctx.physicalId);
  if (!botId) throw new Error('cannot resolve Lex Bot id for revert');
  const declaredLocales = ctx.declared['BotLocales'];
  if (!Array.isArray(declaredLocales))
    throw new Error('Lex BotLocales revert: declared BotLocales is not an array');
  void ops; // reconcile the WHOLE declared model (declared IS the desired target); ops only route.
  const c = new LexModelsV2Client({ region: ctx.region, ...CLIENT_TIMEOUTS });
  const botVersion = 'DRAFT';

  for (const rawLocale of declaredLocales) {
    if (!rawLocale || typeof rawLocale !== 'object') continue;
    const loc = rawLocale as LexRec;
    const localeId = lexStr(loc.LocaleId);
    if (!localeId) throw new Error('Lex BotLocales revert: a declared locale has no LocaleId');

    // --- slot types: name<->id (custom only; AMAZON.* are built-in), create missing / update ---
    // PAGINATE (lowercase `nextToken`): a locale with more slot types than one page would omit
    // page-2+ entities from the map — create-missing would then Create* an existing name (fails
    // mid-revert) and the delete-extra pass would never see extras beyond page 1 (#753).
    const slotTypeSummaries: SlotTypeSummary[] = [];
    {
      let nextToken: string | undefined;
      do {
        const r = await c.send(
          new ListSlotTypesCommand({ botId, botVersion, localeId, ...(nextToken && { nextToken }) })
        );
        slotTypeSummaries.push(...(r.slotTypeSummaries ?? []));
        nextToken = r.nextToken;
      } while (nextToken);
    }
    const slotTypeNameToId = new Map<string, string>();
    for (const s of slotTypeSummaries) {
      const id = lexStr(s.slotTypeId);
      const name = lexStr(s.slotTypeName);
      if (id && name && !id.startsWith('AMAZON.')) slotTypeNameToId.set(name, id);
    }
    const declaredSlotTypes = Array.isArray(loc.SlotTypes) ? (loc.SlotTypes as LexRec[]) : [];
    const declaredStNames = new Set(
      declaredSlotTypes.map((s) => lexStr(s.Name)).filter((n): n is string => n !== undefined)
    );
    // Live custom slot types NOT in the declared set are out-of-band additions — deleted AFTER
    // every referencing slot/intent is reconciled (a slot type in use cannot be deleted), so the
    // names are captured now (before create-missing mutates the map) and DeleteSlotType runs last.
    const extraSlotTypeNames = [...slotTypeNameToId.keys()].filter((n) => !declaredStNames.has(n));
    // A declared custom slot type missing from live was deleted out of band — recreate it first
    // (slots resolve SlotTypeName→id against this map). CreateSlotType needs a valueSelectionSetting
    // when it carries values; the update loop below then converges the full declared content.
    for (const dst of declaredSlotTypes) {
      const name = lexStr(dst.Name);
      if (!name || slotTypeNameToId.has(name)) continue;
      const created = await c.send(
        new CreateSlotTypeCommand({
          botId,
          botVersion,
          localeId,
          slotTypeName: name,
          description: lexStr(dst.Description),
          slotTypeValues: lexMapSlotTypeValues(dst),
          valueSelectionSetting: {
            resolutionStrategy: lexResolutionStrategy(dst) ?? 'OriginalValue',
          },
        } as unknown as CreateSlotTypeCommandInput)
      );
      const newId = lexStr(created.slotTypeId);
      if (newId) slotTypeNameToId.set(name, newId);
    }
    // resolve a declared SlotTypeName to a live slotTypeId (built-ins map to themselves)
    const resolveSlotTypeId = (name: string | undefined): string | undefined =>
      name === undefined
        ? undefined
        : name.startsWith('AMAZON.')
          ? name
          : slotTypeNameToId.get(name);

    for (const dst of declaredSlotTypes) {
      const name = lexStr(dst.Name);
      const slotTypeId = name ? slotTypeNameToId.get(name) : undefined;
      if (!slotTypeId || !name) continue;
      const live = await c.send(
        new DescribeSlotTypeCommand({ botId, botVersion, localeId, slotTypeId })
      );
      const input: LexRec = {
        botId,
        botVersion,
        localeId,
        slotTypeId,
        slotTypeName: name,
        parentSlotTypeSignature: live.parentSlotTypeSignature,
        externalSourceSetting: live.externalSourceSetting,
        compositeSlotTypeSetting: live.compositeSlotTypeSetting,
        description: lexStr(dst.Description),
        slotTypeValues: lexMapSlotTypeValues(dst) ?? live.slotTypeValues,
      };
      const strat = lexResolutionStrategy(dst);
      if (strat !== undefined)
        input.valueSelectionSetting = {
          ...(live.valueSelectionSetting ?? {}),
          resolutionStrategy: strat,
        };
      else input.valueSelectionSetting = live.valueSelectionSetting;
      await c.send(new UpdateSlotTypeCommand(input as unknown as UpdateSlotTypeCommandInput));
    }

    // --- intents: name<->id, create missing / delete extra (skip AMAZON.FallbackIntent-style
    // built-ins), then update each ---
    // PAGINATE (see slot-type note above, #753): an intent beyond page 1 must be in the map or
    // create-missing recreates it (Create fails on the existing name) and delete-extra misses it.
    const intentSummaries: IntentSummary[] = [];
    {
      let nextToken: string | undefined;
      do {
        const r = await c.send(
          new ListIntentsCommand({ botId, botVersion, localeId, ...(nextToken && { nextToken }) })
        );
        intentSummaries.push(...(r.intentSummaries ?? []));
        nextToken = r.nextToken;
      } while (nextToken);
    }
    const intentNameToId = new Map<string, string>();
    for (const i of intentSummaries) {
      const id = lexStr(i.intentId);
      const name = lexStr(i.intentName);
      if (id && name) intentNameToId.set(name, id);
    }
    const declaredIntents = Array.isArray(loc.Intents) ? (loc.Intents as LexRec[]) : [];
    // The built-in FallbackIntent is auto-created/managed by Lex — it is always present live and
    // its declaration is optional, so it is NOT a user-authored node that can be added/removed
    // out of band. Exclude it (and any AMAZON.* signature intent) from the structural check on
    // BOTH sides, and skip re-writing it below (reverting the auto-managed fallback is not a
    // target case). Compare only the USER intents.
    const isBuiltinIntent = (n: string): boolean =>
      n === 'FallbackIntent' || n.startsWith('AMAZON.');
    const declaredIntentNames = new Set(
      declaredIntents.map((i) => lexStr(i.Name)).filter((n): n is string => n !== undefined)
    );
    const liveUserIntents = [...intentNameToId.keys()].filter((n) => !isBuiltinIntent(n));
    // Live USER intents not in the declared set are out-of-band additions — deleted after the
    // per-intent loop (captured now, before create-missing mutates the map). The built-in
    // FallbackIntent is excluded on both sides, so it is never created or deleted.
    const extraIntentNames = liveUserIntents.filter((n) => !declaredIntentNames.has(n));
    // A declared USER intent missing from live was deleted out of band — recreate it before its
    // slots (CreateSlot needs the intent id). SlotPriorities are resolved in the UpdateIntent
    // below, once the slots exist.
    for (const di of declaredIntents) {
      const name = lexStr(di.Name);
      if (!name || isBuiltinIntent(name) || intentNameToId.has(name)) continue;
      const created = await c.send(
        new CreateIntentCommand({
          botId,
          botVersion,
          localeId,
          intentName: name,
          description: lexStr(di.Description),
          parentIntentSignature: lexStr(di.ParentIntentSignature),
          sampleUtterances: lexMapUtterances(di),
        } satisfies CreateIntentCommandInput)
      );
      const newId = lexStr(created.intentId);
      if (newId) intentNameToId.set(name, newId);
    }

    for (const di of declaredIntents) {
      const iName = lexStr(di.Name);
      const intentId = iName ? intentNameToId.get(iName) : undefined;
      if (!intentId || !iName || isBuiltinIntent(iName)) continue;

      // slots for this intent: name<->id, create missing / delete extra, then update each.
      // PAGINATE (see slot-type note above, #753): a slot beyond page 1 must be in the map or
      // create-missing recreates it (Create fails on the existing name) and delete-extra misses it.
      const slotSummaries: SlotSummary[] = [];
      {
        let nextToken: string | undefined;
        do {
          const r = await c.send(
            new ListSlotsCommand({
              botId,
              botVersion,
              localeId,
              intentId,
              ...(nextToken && { nextToken }),
            })
          );
          slotSummaries.push(...(r.slotSummaries ?? []));
          nextToken = r.nextToken;
        } while (nextToken);
      }
      const slotNameToId = new Map<string, string>();
      for (const s of slotSummaries) {
        const id = lexStr(s.slotId);
        const name = lexStr(s.slotName);
        if (id && name) slotNameToId.set(name, id);
      }
      const declaredSlots = Array.isArray(di.Slots) ? (di.Slots as LexRec[]) : [];
      const declaredSlotNames = new Set(
        declaredSlots.map((s) => lexStr(s.Name)).filter((n): n is string => n !== undefined)
      );
      // A declared slot missing from live was deleted out of band — recreate it (a slot always
      // has a valueElicitationSetting with a SlotConstraint; default to Optional when the declared
      // model omits it). The update loop below then converges the full declared content, and the
      // UpdateIntent resolves SlotPriorities against the now-complete slot map.
      for (const ds of declaredSlots) {
        const sName = lexStr(ds.Name);
        if (!sName || slotNameToId.has(sName)) continue;
        const declaredElic = ds.ValueElicitationSetting as LexRec | undefined;
        const elic: LexRec = { slotConstraint: lexStr(declaredElic?.SlotConstraint) ?? 'Optional' };
        const prompt = lexBuildPrompt(declaredElic?.PromptSpecification);
        if (prompt !== undefined) elic.promptSpecification = prompt;
        const created = await c.send(
          new CreateSlotCommand({
            botId,
            botVersion,
            localeId,
            intentId,
            slotName: sName,
            slotTypeId: resolveSlotTypeId(lexStr(ds.SlotTypeName)),
            description: lexStr(ds.Description),
            valueElicitationSetting: elic as unknown as SlotValueElicitationSetting,
          } satisfies CreateSlotCommandInput)
        );
        const newId = lexStr(created.slotId);
        if (newId) slotNameToId.set(sName, newId);
      }
      // Live slots not in the declared set are out-of-band additions — delete them (their intent
      // is kept, so they must be removed individually before the locale is rebuilt).
      for (const [name, slotId] of slotNameToId) {
        if (declaredSlotNames.has(name)) continue;
        await c.send(new DeleteSlotCommand({ botId, botVersion, localeId, intentId, slotId }));
        slotNameToId.delete(name);
      }

      for (const ds of declaredSlots) {
        const sName = lexStr(ds.Name);
        const slotId = sName ? slotNameToId.get(sName) : undefined;
        if (!slotId || !sName) continue;
        const live = await c.send(
          new DescribeSlotCommand({ botId, botVersion, localeId, intentId, slotId })
        );
        const declaredElic = ds.ValueElicitationSetting as LexRec | undefined;
        const liveElic = (live.valueElicitationSetting ?? {}) as LexRec;
        const elic: LexRec = { ...liveElic };
        if (declaredElic) {
          const constraint = lexStr(declaredElic.SlotConstraint);
          if (constraint !== undefined) elic.slotConstraint = constraint;
          const prompt = lexBuildPrompt(declaredElic.PromptSpecification);
          if (prompt !== undefined) elic.promptSpecification = prompt;
        }
        await c.send(
          new UpdateSlotCommand({
            botId,
            botVersion,
            localeId,
            intentId,
            slotId,
            slotName: sName,
            slotTypeId: resolveSlotTypeId(lexStr(ds.SlotTypeName)) ?? live.slotTypeId,
            description: lexStr(ds.Description) ?? live.description,
            obfuscationSetting: live.obfuscationSetting,
            multipleValuesSetting: live.multipleValuesSetting,
            subSlotSetting: live.subSlotSetting,
            // valueElicitationSetting is REQUIRED; a slot always has one (SlotConstraint).
            valueElicitationSetting: elic as unknown as SlotValueElicitationSetting,
          })
        );
      }

      // intent itself: overlay declared fields onto the live intent, resolve SlotPriorities.
      const live = await c.send(
        new DescribeIntentCommand({ botId, botVersion, localeId, intentId })
      );
      const slotPriorities = Array.isArray(di.SlotPriorities)
        ? (di.SlotPriorities as LexRec[])
            .map((p) => {
              const sid = slotNameToId.get(lexStr(p.SlotName) ?? '');
              return typeof p.Priority === 'number' && sid
                ? { priority: p.Priority, slotId: sid }
                : undefined;
            })
            .filter((x): x is { priority: number; slotId: string } => x !== undefined)
        : live.slotPriorities;
      await c.send(
        new UpdateIntentCommand({
          botId,
          botVersion,
          localeId,
          intentId,
          intentName: iName,
          description: lexStr(di.Description) ?? live.description,
          parentIntentSignature: lexStr(di.ParentIntentSignature) ?? live.parentIntentSignature,
          sampleUtterances: Array.isArray(di.SampleUtterances)
            ? (di.SampleUtterances as LexRec[])
                .map((u) => lexStr(u.Utterance))
                .filter((x): x is string => x !== undefined)
                .map((utterance) => ({ utterance }))
            : live.sampleUtterances,
          slotPriorities,
          // preserve un-projected live settings (code hooks, confirmation, contexts, …)
          dialogCodeHook: live.dialogCodeHook,
          fulfillmentCodeHook: live.fulfillmentCodeHook,
          intentConfirmationSetting: live.intentConfirmationSetting,
          intentClosingSetting: live.intentClosingSetting,
          inputContexts: live.inputContexts,
          outputContexts: live.outputContexts,
          kendraConfiguration: live.kendraConfiguration,
          initialResponseSetting: live.initialResponseSetting,
        })
      );
    }

    // --- deletes (reverse of create order so references resolve): extra USER intents first
    // (DeleteIntent cascades their slots), then the now-unreferenced extra custom slot types. ---
    for (const name of extraIntentNames) {
      const intentId = intentNameToId.get(name);
      if (intentId)
        await c.send(new DeleteIntentCommand({ botId, botVersion, localeId, intentId }));
    }
    for (const name of extraSlotTypeNames) {
      const slotTypeId = slotTypeNameToId.get(name);
      if (slotTypeId)
        await c.send(new DeleteSlotTypeCommand({ botId, botVersion, localeId, slotTypeId }));
    }

    // --- locale-level settings (Description / NluConfidenceThreshold / VoiceSettings) ---
    const liveLocale = await c.send(new DescribeBotLocaleCommand({ botId, botVersion, localeId }));
    const voice = loc.VoiceSettings as LexRec | undefined;
    await c.send(
      new UpdateBotLocaleCommand({
        botId,
        botVersion,
        localeId,
        description: lexStr(loc.Description) ?? liveLocale.description,
        // nluIntentConfidenceThreshold is REQUIRED; fall back to the live value.
        nluIntentConfidenceThreshold:
          typeof loc.NluConfidenceThreshold === 'number'
            ? loc.NluConfidenceThreshold
            : liveLocale.nluIntentConfidenceThreshold,
        voiceSettings: voice
          ? ({
              voiceId: lexStr(voice.VoiceId) ?? '',
              engine: lexStr(voice.Engine),
            } as VoiceSettings)
          : liveLocale.voiceSettings,
      } satisfies UpdateBotLocaleCommandInput)
    );

    // Rebuild the DRAFT locale so the reverted model is consistent (best-effort, bounded wait).
    await c.send(new BuildBotLocaleCommand({ botId, botVersion, localeId }));
    for (let i = 0; i < 30; i++) {
      const s = await c.send(new DescribeBotLocaleCommand({ botId, botVersion, localeId }));
      if (s.botLocaleStatus !== 'Building' && s.botLocaleStatus !== 'Processing') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
};

// AWS::ElasticBeanstalk::Application / ::Environment — Cloud Control CAN read these, but
// its UpdateResource echoes a spurious "Parameter ServiceRole is invalid. Must be a valid
// IAM Role ARN" GeneralServiceException (the CC handler injects a ServiceRole it cannot
// resolve) even though the patch itself is applicable — the revert prints a FAILED line
// but happens to converge. Route revert through EB's own UpdateApplication /
// UpdateEnvironment (PARTIAL updates) so ONLY the drifted, mutable top-level props are sent
// and no spurious ServiceRole validation is triggered. The declared model IS the revert
// target; an op that REMOVES a prop clears it (EB treats an empty Description as cleared).
//
// The revertable declared surface is thin: ApplicationName / EnvironmentName are create-only
// identities, the Environment's Tier is create-only, and its OptionSettings is write-only
// (read gap) — so a DECLARED drift only ever lands on Description. ResourceLifecycleConfig
// (Application) needs a separate UpdateApplicationResourceLifecycle call (below).
const EB_APPLICATION_MODIFY_PARAMS = new Set(['Description']);
// #1295 — AWS::ElasticBeanstalk::Application.ResourceLifecycleConfig is mutable out of band
// (`aws elasticbeanstalk update-application-resource-lifecycle` — e.g. enabling a MaxCountRule
// that auto-deletes application versions) and folds atDefault when undeclared. An OOB change
// therefore surfaces as drift whose revert op lands on this writer, but UpdateApplication cannot
// set ResourceLifecycleConfig, so before this fix the op hit the #804 assertOpsConsumed
// honest-fail ("update it manually") and the drift could never converge in-tool. Route it
// through its OWN UpdateApplicationResourceLifecycle call. The revert-to-default value (for a
// `remove` on an undeclared, at-default finding) mirrors the KNOWN_DEFAULTS service default in
// src/normalize/noise.ts — kept as a local constant here so this writer stays self-contained:
// a version-lifecycle policy carrying both rules present but DISABLED (so no ServiceRole is
// required). A declared drift writes the declared intent instead.
const EB_APPLICATION_DEFAULT_RESOURCE_LIFECYCLE: Record<string, unknown> = {
  VersionLifecycleConfig: {
    MaxCountRule: { DeleteSourceFromS3: false, Enabled: false, MaxCount: 200 },
    MaxAgeRule: { DeleteSourceFromS3: false, MaxAgeInDays: 180, Enabled: false },
  },
};
const asObject = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const writeElasticBeanstalkApplication: SdkWriter = async (ctx, ops) => {
  const name = str(ctx.physicalId) ?? str(ctx.declared['ApplicationName']);
  if (!name) throw new Error('cannot resolve Elastic Beanstalk ApplicationName for revert');
  const client = new ElasticBeanstalkClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
  const input: { ApplicationName: string; Description?: string } = { ApplicationName: name };
  let any = false;
  let lifecycle: Record<string, unknown> | undefined;
  for (const op of ops) {
    const top = op.path.replace(/^\//, '').split('/')[0];
    if (top && EB_APPLICATION_MODIFY_PARAMS.has(top)) {
      // add -> declared value; remove -> clear (empty string, which EB reads as unset)
      input[top as 'Description'] = op.op === 'remove' ? '' : (str(ctx.declared[top]) ?? '');
      any = true;
    } else if (top === 'ResourceLifecycleConfig') {
      // remove -> the at-default service default (undeclared finding reverting to default);
      // add/replace -> the declared intent (whole object), falling back to the op's carried
      // value then the default. The declared object is preferred over op.value so a NESTED
      // op path still writes the complete, coherent config rather than a leaf fragment.
      // op.value is only the WHOLE ResourceLifecycleConfig when the op targets the object
      // itself (`/ResourceLifecycleConfig`); a nested set-default op (#1437 —
      // `/ResourceLifecycleConfig/VersionLifecycleConfig`, emitted since the object is now
      // DESCENDED) carries only that sub-block, so writing op.value there would send a
      // wrapper-less fragment as the whole config. Trust op.value ONLY for the whole-object op;
      // otherwise fall to the declared object then the default (the coherent whole either way).
      const targetsWholeObject = op.path.replace(/^\//, '') === 'ResourceLifecycleConfig';
      lifecycle =
        op.op === 'remove'
          ? EB_APPLICATION_DEFAULT_RESOURCE_LIFECYCLE
          : (asObject(ctx.declared['ResourceLifecycleConfig']) ??
            (targetsWholeObject ? asObject(op.value) : undefined) ??
            EB_APPLICATION_DEFAULT_RESOURCE_LIFECYCLE);
    }
  }
  if (any) await client.send(new UpdateApplicationCommand(input));
  if (lifecycle !== undefined)
    await client.send(
      new UpdateApplicationResourceLifecycleCommand({
        ApplicationName: name,
        ResourceLifecycleConfig: lifecycle,
      })
    );
  // Any other prop outside the handled set (Description + ResourceLifecycleConfig) is NOT
  // applied here; report it not-reverted (#804) instead of silently succeeding.
  assertOpsConsumed(
    'ElasticBeanstalk Application',
    ops,
    new Set([...EB_APPLICATION_MODIFY_PARAMS, 'ResourceLifecycleConfig'])
  );
};

const EB_ENVIRONMENT_MODIFY_PARAMS = new Set(['Description']);
const writeElasticBeanstalkEnvironment: SdkWriter = async (ctx, ops) => {
  const name = str(ctx.physicalId) ?? str(ctx.declared['EnvironmentName']);
  if (!name) throw new Error('cannot resolve Elastic Beanstalk EnvironmentName for revert');
  const input: { EnvironmentName: string; Description?: string } = { EnvironmentName: name };
  let any = false;
  for (const op of ops) {
    const top = op.path.replace(/^\//, '').split('/')[0];
    if (top && EB_ENVIRONMENT_MODIFY_PARAMS.has(top)) {
      input[top as 'Description'] = op.op === 'remove' ? '' : (str(ctx.declared[top]) ?? '');
      any = true;
    }
  }
  if (any)
    await new ElasticBeanstalkClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
      new UpdateEnvironmentCommand(input)
    );
  // #804 — VersionLabel / PlatformArn / SolutionStackName (the common OOB console-deploy /
  // platform drift) are NOT in the allowlist and are not applied here; report them
  // not-reverted rather than print a false `reverted:`.
  assertOpsConsumed('ElasticBeanstalk Environment', ops, EB_ENVIRONMENT_MODIFY_PARAMS);
};

// Kinesis Video Stream / SignalingChannel: Cloud Control UpdateResource REJECTS ANY patch
// with `ValidationException: #/Tags: expected minimum item count: 1, found: 0` — the KVS CFn
// schema requires a non-empty Tags array in the model CC reconstructs — so a folded MUTABLE
// prop (#624: DataRetentionInHours / MessageTtlSeconds) cannot be reverted through Cloud
// Control at all. Revert via the service's own granular update API instead. The revert TARGET
// is the KNOWN_DEFAULTS default (a plain `remove` back to default); an explicit `add`/replace
// carries the value. Live-proven follow-up (a `remove` revert of an out-of-band retention/TTL
// FAILED on the Tags validation until routed here).
const KVS_STREAM_RETENTION_DEFAULT = 0;
const KVS_CHANNEL_MESSAGE_TTL_DEFAULT = 60;
// DescribeStream / UpdateDataRetention accept EITHER StreamName or StreamARN — pick by shape
// (the CFn physical id may be an ARN).
const kvsStreamRef = (id: string): { StreamName: string } | { StreamARN: string } =>
  id.startsWith('arn:') ? { StreamARN: id } : { StreamName: id };
const kvsChannelDescribeRef = (id: string): { ChannelName: string } | { ChannelARN: string } =>
  id.startsWith('arn:') ? { ChannelARN: id } : { ChannelName: id };

const writeKinesisVideoStreamRetention: SdkWriter = async (ctx, ops) => {
  const id = str(ctx.physicalId) ?? str(ctx.declared['Name']);
  if (!id) throw new Error('cannot resolve Kinesis Video stream for revert');
  const op = ops.find((o) => o.path.replace(/^\//, '') === 'DataRetentionInHours');
  if (!op) return;
  const target =
    op.op === 'add' && typeof op.value === 'number' ? op.value : KVS_STREAM_RETENTION_DEFAULT;
  const kv = new KinesisVideoClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
  const desc = await kv.send(new DescribeStreamCommand(kvsStreamRef(id)));
  const current = desc.StreamInfo?.DataRetentionInHours ?? 0;
  const version = desc.StreamInfo?.Version;
  if (version === undefined) throw new Error(`cannot resolve stream version for ${id}`);
  if (target === current) return;
  // UpdateDataRetention is a DELTA API (increase/decrease by N hours), so translate the
  // absolute target into the signed change from the current live value.
  await kv.send(
    new UpdateDataRetentionCommand({
      ...kvsStreamRef(id),
      CurrentVersion: version,
      Operation: target > current ? 'INCREASE_DATA_RETENTION' : 'DECREASE_DATA_RETENTION',
      DataRetentionChangeInHours: Math.abs(target - current),
    })
  );
};

const writeKinesisVideoSignalingChannel: SdkWriter = async (ctx, ops) => {
  const id = str(ctx.physicalId) ?? str(ctx.declared['Name']);
  if (!id) throw new Error('cannot resolve Kinesis Video signaling channel for revert');
  const op = ops.find((o) => o.path.replace(/^\//, '') === 'MessageTtlSeconds');
  if (!op) return;
  const target =
    op.op === 'add' && typeof op.value === 'number' ? op.value : KVS_CHANNEL_MESSAGE_TTL_DEFAULT;
  const kv = new KinesisVideoClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
  const desc = await kv.send(new DescribeSignalingChannelCommand(kvsChannelDescribeRef(id)));
  const arn = desc.ChannelInfo?.ChannelARN;
  const version = desc.ChannelInfo?.Version;
  if (arn === undefined || version === undefined)
    throw new Error(`cannot resolve signaling channel ARN/version for ${id}`);
  // UpdateSignalingChannel addresses the channel by ARN and takes the absolute TTL.
  await kv.send(
    new UpdateSignalingChannelCommand({
      ChannelARN: arn,
      CurrentVersion: version,
      SingleMasterConfiguration: { MessageTtlSeconds: target },
    })
  );
};

// KVS Stream StreamStorageConfiguration.DefaultStorageTier — mutable via its own dedicated
// UpdateStreamStorageConfiguration API, and (like the other KVS props) unrevertable through
// Cloud Control (the Tags-min-items ValidationException). A nested-path writer: on a `remove`
// it restores the "HOT" default; an explicit `add` carries the value. Live-proven follow-up (a
// DefaultStorageTier changed to WARM out of band FAILED the CC Tags validation until routed here).
const KVS_STREAM_STORAGE_TIER_DEFAULT = 'HOT';
const writeKinesisVideoStreamStorage: SdkWriter = async (ctx, ops) => {
  const id = str(ctx.physicalId) ?? str(ctx.declared['Name']);
  if (!id) throw new Error('cannot resolve Kinesis Video stream for revert');
  const op = ops.find((o) =>
    o.path.replace(/^\//, '').replace(/\//g, '.').endsWith('DefaultStorageTier')
  );
  if (!op) return;
  const target = (
    op.op === 'add' && typeof op.value === 'string' ? op.value : KVS_STREAM_STORAGE_TIER_DEFAULT
  ) as DefaultStorageTier;
  const kv = new KinesisVideoClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
  const desc = await kv.send(new DescribeStreamCommand(kvsStreamRef(id)));
  const version = desc.StreamInfo?.Version;
  if (version === undefined) throw new Error(`cannot resolve stream version for ${id}`);
  await kv.send(
    new UpdateStreamStorageConfigurationCommand({
      ...kvsStreamRef(id),
      CurrentVersion: version,
      StreamStorageConfiguration: { DefaultStorageTier: target },
    })
  );
};

// AWS::ApiGatewayV2::Stage — Cloud Control CAN read this type, but its UpdateResource
// REJECTS ANY patch on a stage with AutoDeploy=true: the CC handler applies our scoped
// patch to the FULL current model — which includes the AWS-materialized DeploymentId — and
// calls UpdateStage with DeploymentId set, and an auto-deploy stage rejects any explicit
// DeploymentId write ("Deployment ID cannot be set on this stage because AutoDeploy is
// enabled"). CDK's L2 WebSocketStage and the HTTP-API default stage BOTH set autoDeploy:true
// by default, so in practice EVERY ApiGatewayV2 stage a CDK user deploys is un-revertable
// via CC. The poison (DeploymentId) is injected by the CC handler itself, so stripping on our
// side can't fix it → bypass CC and call apigatewayv2:UpdateStage DIRECTLY with ONLY the
// drifted properties (NEVER DeploymentId). #667.
//
// The CFn Stage property names (DefaultRouteSettings / RouteSettings / AccessLogSettings /
// Description / StageVariables / ClientCertificateId) map 1:1 onto UpdateStageRequest's typed
// fields (same PascalCase, same nested RouteSettings shape), so reconstruct the desired value
// from the DECLARED template + revert ops and send only the top-level properties the ops touch
// — a partial update that leaves every other live stage setting untouched. Applies to WebSocket
// AND HTTP API stages. The composite identifier is `ApiId|StageName` (ctx.identifier, resolved
// by CC_IDENTIFIER_ADAPTERS on the read side); the bare CFn physical id is only the StageName.
//
// #806 — CLEARING a field cannot be expressed by omission (an absent value in the
// UpdateStage input is dropped by the serializer, so the live value SURVIVES — the
// revert never converges). Each field needs a DISTINCT clearing mechanism, all
// live-verified in the issue:
//   - StageVariables: UpdateStage MERGES the map, and an empty map is a NO-OP. A key is
//     removed ONLY by sending it with an empty-string value. So a clear sends every
//     to-be-removed key (the live `prior` keys the revert drops) as `""`.
//   - AccessLogSettings: an empty object is a no-op; the ONLY clearing path is the
//     dedicated DeleteAccessLogSettings API.
//   - RouteSettings (per-route overrides): cleared via DeleteRouteSettings per route key.
//   - Description: the API has NO clearing path (`""` leaves the old value); a removed
//     Description is left untouched (documented API limitation).
// A `remove` op (revert-to-absent) carries `prior` = the live value being cleared. An
// `add` op carries the desired value to SET. We inspect the ops per field to tell a
// clear apart from a set — the desired-model reconstruction alone cannot (a cleared
// field and an untouched-and-absent field both look absent).
const APIGWV2_STAGE_UPDATE_FIELDS = new Set([
  'DefaultRouteSettings',
  'RouteSettings',
  'AccessLogSettings',
  'Description',
  'StageVariables',
  'ClientCertificateId',
  'AutoDeploy',
]);
const writeApiGatewayV2Stage: SdkWriter = async (ctx, ops) => {
  // Prefer the resolved composite identifier (`ApiId|StageName`); fall back to declared
  // ApiId + the physical-id StageName when no identifier was threaded.
  const [apiIdFromComposite, stageFromComposite] = (ctx.identifier ?? '').split('|');
  const apiId = str(apiIdFromComposite) ?? str(ctx.declared['ApiId']);
  const stageName =
    str(stageFromComposite) ?? str(ctx.physicalId) ?? str(ctx.declared['StageName']);
  if (!apiId || !stageName)
    throw new Error('cannot resolve ApiId|StageName for ApiGatewayV2 Stage revert');
  // Reconstruct the desired model = declared intent + revert ops. A `remove` back to a
  // default is expressed by the declared value's absence (the field is simply omitted).
  const desired = applyOps({ ...ctx.declared }, ops);
  const touched = new Set(
    ops.map((o) => o.path.replace(/^\//, '').split('/')[0]).filter((p): p is string => !!p)
  );
  // A field is being CLEARED (reverted to absent) when the desired value is absent AND at
  // least one op under that field is a `remove`. It is being SET otherwise. We compute the
  // exact keys/routes to clear from the `remove` ops (whole-field remove: the live `prior`
  // keys; per-key remove: the key from the op path).
  const isCleared = (field: string): boolean =>
    desired[field as keyof typeof desired] === undefined &&
    ops.some((o) => o.op === 'remove' && o.path.replace(/^\//, '').split('/')[0] === field);
  // The keys of a StageVariables/RouteSettings clear: the live keys the revert drops.
  const clearedSubKeys = (field: string): string[] => {
    const keys = new Set<string>();
    for (const o of ops) {
      if (o.op !== 'remove') continue;
      const segs = o.path.replace(/^\//, '').split('/');
      if (segs[0] !== field) continue;
      if (segs.length >= 2 && segs[1]) {
        // per-key remove: `/StageVariables/<key>`
        keys.add(segs[1]);
      } else {
        // whole-field remove: every live key (from `prior`).
        for (const k of Object.keys(asRecord(o.prior))) keys.add(k);
      }
    }
    return [...keys];
  };

  const client = new ApiGatewayV2Client({ region: ctx.region, ...CLIENT_TIMEOUTS });

  // AccessLogSettings clear -> DeleteAccessLogSettings (empty object is a no-op).
  if (touched.has('AccessLogSettings') && isCleared('AccessLogSettings')) {
    await client.send(new DeleteAccessLogSettingsCommand({ ApiId: apiId, StageName: stageName }));
  }
  // RouteSettings clear -> DeleteRouteSettings per dropped route key.
  if (touched.has('RouteSettings') && isCleared('RouteSettings')) {
    for (const routeKey of clearedSubKeys('RouteSettings')) {
      await client.send(
        new DeleteRouteSettingsCommand({ ApiId: apiId, StageName: stageName, RouteKey: routeKey })
      );
    }
  }

  // Build the UpdateStage input for the SET fields + the StageVariables clear (empty-string
  // tombstones). Fields with a dedicated clearing API above are NOT re-sent here.
  const input: Record<string, unknown> = { ApiId: apiId, StageName: stageName };
  for (const p of touched) {
    if (!APIGWV2_STAGE_UPDATE_FIELDS.has(p)) continue;
    if (p === 'AccessLogSettings' && isCleared('AccessLogSettings')) continue; // handled above.
    if (p === 'RouteSettings' && isCleared('RouteSettings')) continue; // handled above.
    if (p === 'StageVariables' && isCleared('StageVariables')) {
      // Clear each dropped key with an empty-string tombstone (an empty/omitted map is a
      // no-op; MERGE semantics mean unlisted live keys survive, so we must name them).
      const tombstones: Record<string, string> = {};
      for (const k of clearedSubKeys('StageVariables')) tombstones[k] = '';
      if (Object.keys(tombstones).length > 0) input.StageVariables = tombstones;
      continue;
    }
    if (isCleared(p)) {
      // Description (and any other field with no clearing path): omission leaves the live
      // value. Skip it rather than send an ineffective payload — the API cannot clear it.
      continue;
    }
    // Send the desired value to SET. NEVER DeploymentId.
    input[p] = desired[p as keyof typeof desired] as unknown;
  }
  // Only issue UpdateStage if it carries a settable field (beyond the identity pair). A
  // clear-only revert (AccessLogSettings/RouteSettings) may have already converged above.
  if (Object.keys(input).length > 2) {
    await client.send(
      new UpdateApiGatewayV2StageCommand(
        input as { ApiId: string; StageName: string; DefaultRouteSettings?: RouteSettings }
      )
    );
  }
  // #804 — Tags (and any prop outside APIGWV2_STAGE_UPDATE_FIELDS) are not applied by
  // UpdateStage/DeleteRouteSettings/DeleteAccessLogSettings here; report them not-reverted.
  assertOpsConsumed('ApiGatewayV2 Stage', ops, APIGWV2_STAGE_UPDATE_FIELDS);
};

// AWS::ApiGateway::RestApi `Policy` — the RestApi resource policy is held in the Cloud
// Control live model as a JSON STRING, while classify/diff parses it for comparison and
// produces findings under object sub-paths (e.g. `Policy.Statement`). The revert planner's
// sub-path patch (`/Policy/Statement`) is then rejected by the CC handler ("parent is not a
// container in source" — the parent `Policy` is a string, not an object). The #389 JSON-string
// class, but routed HERE (an SDK writer) rather than the noise.ts JSON_STRING_PROPS table.
// apigateway:UpdateRestApi with a single `replace /policy` patchOperation carrying the WHOLE
// desired policy document serialized to a compact JSON string is live-verified to converge.
// The desired policy is the DECLARED template value (the object form); a revert to an ABSENT
// declared policy clears it (empty string). The RestApi physical id IS its RestApiId. #677.
const writeApiGatewayRestApiPolicy: SdkWriter = async (ctx) => {
  const restApiId = str(ctx.physicalId) ?? str(ctx.declared['RestApiId']);
  if (!restApiId) throw new Error('cannot resolve RestApiId for RestApi Policy revert');
  const declaredPolicy = ctx.declared['Policy'];
  // The declared policy is an object; serialize it whole. An absent declared policy reverts
  // to the empty string (UpdateRestApi with `replace /policy value=""` clears it).
  const value =
    declaredPolicy === undefined || declaredPolicy === null
      ? ''
      : typeof declaredPolicy === 'string'
        ? declaredPolicy
        : JSON.stringify(declaredPolicy);
  await new APIGatewayClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
    new UpdateRestApiCommand({
      restApiId,
      patchOperations: [{ op: 'replace', path: '/policy', value } satisfies PatchOperation],
    })
  );
};

export const SDK_WRITERS: Record<string, SdkWriter> = {
  'AWS::ApiGatewayV2::Stage': writeApiGatewayV2Stage,
  'AWS::ElasticBeanstalk::Application': writeElasticBeanstalkApplication,
  'AWS::ElasticBeanstalk::Environment': writeElasticBeanstalkEnvironment,
  'AWS::CodeBuild::ReportGroup': writeCodeBuildReportGroup,
  'AWS::DAX::Cluster': writeDaxCluster,
  'AWS::DAX::ParameterGroup': writeDaxParameterGroup,
  'AWS::ElastiCache::ParameterGroup': writeElastiCacheParameterGroup,
  'AWS::MemoryDB::ParameterGroup': writeMemoryDbParameterGroup,
  'AWS::EC2::ClientVpnEndpoint': writeEc2ClientVpnEndpoint,
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
  'AWS::Config::ConfigurationRecorder': writeConfigConfigurationRecorder,
};

// Property-scoped SDK writers: CC-writable types where ONE property must be
// reverted via the type's own SDK instead of a Cloud Control patch. Keyed by
// resource type -> EXACT top-level finding path. Deeper paths (e.g. a declared
// drift at Policies.0...) still go through Cloud Control as before.
export const SDK_PROP_WRITERS: Record<string, Record<string, SdkWriter>> = {
  'AWS::Cognito::IdentityPool': { CognitoEvents: writeCognitoIdentityPoolEvents },
  'AWS::Config::ConfigRule': { InputParameters: writeConfigRuleInputParameters },
  'AWS::KinesisVideo::Stream': { DataRetentionInHours: writeKinesisVideoStreamRetention },
  'AWS::KinesisVideo::SignalingChannel': {
    MessageTtlSeconds: writeKinesisVideoSignalingChannel,
  },
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

// Poll a Cloud Control UpdateResource ProgressEvent to a terminal state. Cloud Control
// ACCEPTS the request synchronously and runs the resource-handler asynchronously — the
// initial ProgressEvent is IN_PROGRESS, so returning here would print a false `reverted:`
// while the operation may still FAIL (async validation / downstream throttle / handler
// AccessDenied). The FAILED event's StatusMessage is the ONLY place the reason exists
// (#1065). Mirror the generic CC path's pollToCompletion (src/revert/apply.ts): poll via
// GetResourceRequestStatus on the RequestToken until SUCCESS / FAILED / CANCEL_COMPLETE,
// throwing on FAILED with the StatusMessage so the stack-actions.ts writer wrapper
// classifies/retries it exactly like every other writer failure. That private helper lives
// in apply.ts (not importable without touching a peer-owned file), so the poll is inlined
// here reusing the shared transient classifier (classifyTransient) to avoid re-sending the
// mutation on a transient POLL-read failure (#1064).
const NESTED_POLL_INTERVAL_MS = 2000;
// Generous ceiling — a Secrets Manager replica change takes tens of seconds, a Backup plan
// version a few. pollToCompletion returns as soon as the op is terminal, so a high ceiling
// never slows the common case; it only bounds a never-terminating op.
const NESTED_POLL_TIMEOUT_MS = 15 * 60 * 1000;
// Bound consecutive TRANSIENT poll-read failures so a persistent poll outage still
// terminates. Each throw here follows the SDK's own internal retries.
const NESTED_MAX_POLL_READ_FAILURES = 10;

const nestedSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Injectable clock/sleep so tests exercise the poll loop without real 2s waits.
export interface NestedPollOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// Poll to a terminal ProgressEvent; throw on FAILED / CANCEL_COMPLETE / timeout carrying the
// StatusMessage (or the reason). Resolves on SUCCESS. Exported for unit tests.
export async function pollNestedToCompletion(
  cc: CloudControlClient,
  first: ProgressEvent | undefined,
  poll: NestedPollOptions = {}
): Promise<void> {
  const doSleep = poll.sleep ?? nestedSleep;
  const clock = poll.now ?? Date.now;
  let event = first;
  const token = event?.RequestToken;
  if (!token) throw new Error('Cloud Control UpdateResource returned no request token');
  const deadline = clock() + NESTED_POLL_TIMEOUT_MS;
  let pollFailures = 0;
  while (clock() < deadline) {
    const status = event?.OperationStatus;
    if (status === 'SUCCESS') return;
    if (status === 'FAILED' || status === 'CANCEL_COMPLETE') {
      // StatusMessage carries the service code (e.g. RSLVR-00705); ErrorCode is a coarser
      // CC enum, appended when present. This is the ONLY place the async-failure reason lives.
      const msg = event?.StatusMessage ?? status;
      const code = event?.ErrorCode;
      throw new Error(code && !msg.includes(code) ? `${code}: ${msg}` : msg);
    }
    await doSleep(NESTED_POLL_INTERVAL_MS);
    try {
      const polled = await cc.send(new GetResourceRequestStatusCommand({ RequestToken: token }));
      event = polled.ProgressEvent;
      pollFailures = 0;
    } catch (e) {
      // A poll-READ error, NOT an operation failure — the mutation is still in flight. A
      // terminal poll error (e.g. an invalid/expired RequestToken) cannot be resolved by
      // re-reading, so surface it. Keep polling the SAME token only for transient poll errors.
      const text = errorText(e);
      if (!classifyTransient(text).transient) throw new Error(text);
      if (++pollFailures >= NESTED_MAX_POLL_READ_FAILURES) {
        // Persistent poll outage: do NOT let this bubble as a mutation failure that would be
        // re-sent — report a terminal failure whose wording omits the transient keyword.
        throw new Error(
          `unable to confirm Cloud Control request status after ${NESTED_MAX_POLL_READ_FAILURES} poll attempts`
        );
      }
      // else: re-poll the same request token (event unchanged → still non-terminal).
    }
  }
  throw new Error('timed out waiting for Cloud Control request');
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
  const cc = new CloudControlClient({ region: ctx.region, ...CLIENT_TIMEOUTS });
  const got = await cc.send(new GetResourceCommand({ TypeName: type, Identifier: identifier }));
  const live = JSON.parse(got.ResourceDescription?.Properties ?? '{}') as Record<string, unknown>;
  const patch = ops.map((op) => {
    const path = reindexNestedPointer(op.path, live, type);
    return op.op === 'remove' ? { op: op.op, path } : { op: op.op, path, value: op.value };
  });
  const res = await cc.send(
    new UpdateResourceCommand({
      TypeName: type,
      Identifier: identifier,
      PatchDocument: JSON.stringify(patch),
    })
  );
  // Cloud Control ACCEPTED the request but the handler runs ASYNCHRONOUSLY — poll the
  // ProgressEvent to a terminal state before returning, so a later async FAILURE surfaces
  // as a genuine writer error (carrying the StatusMessage) instead of a false `reverted:`.
  await pollNestedToCompletion(cc, res.ProgressEvent);
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
  // KVS Stream StreamStorageConfiguration is descended (a fully-undeclared object whose
  // DefaultStorageTier folds to its schema default), so an out-of-band tier change surfaces at
  // the nested path — unrevertable via CC (Tags validation), reverted via UpdateStreamStorage-
  // Configuration instead.
  'AWS::KinesisVideo::Stream': {
    match: (p) => p === 'StreamStorageConfiguration' || p.startsWith('StreamStorageConfiguration.'),
    writer: writeKinesisVideoStreamStorage,
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
  // The RestApi resource `Policy` reads back from Cloud Control as a JSON STRING, so a
  // sub-path patch (`/Policy/Statement`) is rejected ("parent is not a container"). Any drift
  // under Policy re-serializes the WHOLE declared policy and replaces `/policy` via
  // apigateway:UpdateRestApi. Scoped to Policy only — other RestApi props stay on Cloud
  // Control. #677.
  'AWS::ApiGateway::RestApi': {
    match: (p) => p === 'Policy' || p.startsWith('Policy.') || p.startsWith('Policy['),
    writer: writeApiGatewayRestApiPolicy,
  },
  // Any drift UNDER the writeOnly BotLocales (an utterance / slot / slot-type / prompt edit, OR a
  // whole intent / slot / slot type added or removed out of band) re-supplies the DECLARED
  // conversational model via the lexv2-models write APIs — CC cannot write the writeOnly prop. It
  // updates existing nodes and creates/deletes structurally-diverged ones (see writeLexBotLocales).
  // #553 (update-only) + #564 (structural create/delete).
  'AWS::Lex::Bot': {
    match: (p) => p === 'BotLocales' || p.startsWith('BotLocales.') || p.startsWith('BotLocales['),
    writer: writeLexBotLocales,
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

// ── SDK deleters (#1386) ─────────────────────────────────────────────────────
// Type-specific SDK DELETE for an `added` (out-of-band) resource whose type Cloud
// Control cannot delete: CC DeleteResource throws UnsupportedActionException for it
// even though the child enumerator can detect it. The delete analog of SDK_WRITERS —
// first entry AWS::AppSync::ApiKey (#1386); the same seam covers any future
// enumerated child type without a CC DELETE handler (the #1312 Route53 class
// precedent for type-specific SDK routing).

// What a deleter gets. `physicalId` is the finding's CC primaryIdentifier (the same
// identifier the CC path would have deleted — for an AppSync ApiKey the BARE ApiKeyId
// the enumerator emitted). `parentPhysicalId` is the ENUMERATING PARENT resource's CFn
// physical id, recovered by the caller from the added finding's synthesized logicalId
// (`${parentLogicalId}/${identifier}`, gather.ts) — an API-scoped delete (DeleteApiKey
// needs `apiId`) derives its container id from it.
export interface SdkDeleteCtx {
  physicalId: string;
  parentPhysicalId?: string | undefined;
  region: string;
}

export type SdkDeleter = (ctx: SdkDeleteCtx) => Promise<void>;

// AWS::AppSync::ApiKey: CC has no DELETE handler (UnsupportedActionException), so an
// added key found by the GraphQLApi child enumerator (#1367) is deleted via the
// service's own DeleteApiKey, which addresses the key as { apiId, id }. `id` is the
// bare ApiKeyId the finding carries; `apiId` comes from the parent GraphQLApi's CFn
// physical id — its ARN `arn:...:apis/<apiId>` — by taking the trailing segment
// (mirrors the unexported bareApiId transform in read/child-enumerators.ts; a bare
// id without '/' already IS the ApiId).
const deleteAppSyncApiKey: SdkDeleter = async (ctx) => {
  const parent = ctx.parentPhysicalId;
  if (!parent) {
    throw new Error('cannot resolve the parent GraphQLApi id for the AppSync ApiKey delete');
  }
  const apiId = parent.includes('/') ? parent.slice(parent.lastIndexOf('/') + 1) : parent;
  await new AppSyncClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
    new DeleteApiKeyCommand({ apiId, id: ctx.physicalId })
  );
};

// AWS::Route53::RecordSet: NON_PROVISIONABLE — CC DeleteResource throws
// UnsupportedActionException (#1312), so an out-of-band record found by the HostedZone child
// enumerator is deleted via Route53 ChangeResourceRecordSets with Action DELETE (#1431). A
// DELETE change must carry the record's EXACT current ResourceRecordSet (Name/Type/TTL + all
// ResourceRecords / AliasTarget / routing fields) or Route53 rejects it, so re-read the zone's
// live records and match the one whose reconstructed identifier equals the finding's — robust
// against '_' in record names (`_dmarc.example.com`), which a split-based parse of the composite
// identifier could not disambiguate. The zone id is the enumerating parent HostedZone's physical
// id (parentPhysicalId, recovered at the stack-actions call site from the finding's synthesized
// `${parentLogicalId}/${identifier}` logicalId). A record already gone (no match) is the delete
// goal state — return without a change (applyRevertDeleteSdk treats it as success).
const deleteRoute53RecordSet: SdkDeleter = async (ctx) => {
  const zoneId = ctx.parentPhysicalId;
  if (!zoneId) {
    throw new Error('cannot resolve the parent HostedZone id for the Route53 RecordSet delete');
  }
  const client = new Route53Client({ region: ctx.region, ...CLIENT_TIMEOUTS });
  const records = await pageResourceRecordSets(client, zoneId);
  const target = records.find(
    (r) =>
      r.Name !== undefined &&
      r.Type !== undefined &&
      route53RecordSetIdentifier(zoneId, r.Name, r.Type, r.SetIdentifier) === ctx.physicalId
  );
  if (!target) return; // already gone — nothing to delete
  await client.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      ChangeBatch: { Changes: [{ Action: 'DELETE', ResourceRecordSet: target }] },
    })
  );
};

// AWS::SQS::QueuePolicy: CC has no usable delete for an out-of-band policy (its
// primaryIdentifier is a service-generated `Id` the policy-set never produces), so an added
// queue policy found by the SQS child enumerator (#835) is removed via SetQueueAttributes with
// an EMPTY `Policy` — the same API the declared `writeSqsQueuePolicy` uses to converge a policy,
// here clearing it entirely. The finding carries the QUEUE URL as its physicalId (the enumerator
// identity), which is exactly the SetQueueAttributes target. An already-cleared policy is the
// delete goal state (applyRevertDeleteSdk treats a no-op / already-gone as success).
const deleteSqsQueuePolicy: SdkDeleter = async (ctx) => {
  await new SQSClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
    new SetQueueAttributesCommand({ QueueUrl: ctx.physicalId, Attributes: { Policy: '' } })
  );
};

// AWS::SecretsManager::ResourcePolicy: CC has no usable delete for an out-of-band policy (its
// primaryIdentifier is a service-generated `Id` the `put-resource-policy` never produces), so an
// added secret resource policy found by the Secrets Manager child enumerator (#835) is removed via
// the service's own DeleteResourcePolicy — a TRUE delete that detaches the policy entirely. The
// finding carries the SECRET ARN as its physicalId (the enumerator identity), which is exactly the
// DeleteResourcePolicy `SecretId` target. An already-detached policy is the delete goal state
// (applyRevertDeleteSdk treats a no-op / already-gone as success).
const deleteSecretsManagerResourcePolicy: SdkDeleter = async (ctx) => {
  await new SecretsManagerClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
    new SecretsDeleteResourcePolicyCommand({ SecretId: ctx.physicalId })
  );
};

// AWS::SNS::TopicPolicy: CC has no usable delete for an out-of-band policy (its primaryIdentifier
// is a service-generated `Id` the `set-topic-attributes Policy=…` never produces), so an added
// topic policy found by the SNS child enumerator (#835) is reverted via SetTopicAttributes. UNLIKE
// SQS (whose empty-Policy set removes it) SNS REJECTS an empty Policy (`InvalidParameter: Policy is
// empty`, verified live) and a topic ALWAYS carries a policy — so the "delete" here RESTORES the
// AWS-DEFAULT access policy (the one every fresh topic gets: the owner granted the eight default
// actions gated on `AWS:SourceOwner`, Resource = the topic ARN). This is the exact state a clean
// topic is in, so a subsequent `check` folds it (isDefaultSnsTopicPolicy) and reports CLEAN. The
// finding carries the TOPIC ARN as its physicalId (the enumerator identity), from which the owner
// account is parsed to rebuild the default. Re-setting an already-default policy is idempotent
// (the delete goal state; applyRevertDeleteSdk treats it as success).
const deleteSnsTopicPolicy: SdkDeleter = async (ctx) => {
  const topicArn = ctx.physicalId;
  const seg = topicArn.split(':');
  const account = seg.length >= 6 ? seg[4] : undefined;
  if (!account) throw new Error('cannot resolve the owner account for the SNS TopicPolicy revert');
  const defaultPolicy = JSON.stringify({
    Version: '2008-10-17',
    Id: '__default_policy_ID',
    Statement: [
      {
        Sid: '__default_statement_ID',
        Effect: 'Allow',
        Principal: { AWS: '*' },
        Action: [
          'SNS:GetTopicAttributes',
          'SNS:SetTopicAttributes',
          'SNS:AddPermission',
          'SNS:RemovePermission',
          'SNS:DeleteTopic',
          'SNS:Subscribe',
          'SNS:ListSubscriptionsByTopic',
          'SNS:Publish',
        ],
        Resource: topicArn,
        Condition: { StringEquals: { 'AWS:SourceOwner': account } },
      },
    ],
  });
  await new SNSClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
    new SetTopicAttributesCommand({
      TopicArn: topicArn,
      AttributeName: 'Policy',
      AttributeValue: defaultPolicy,
    })
  );
};

// AWS::KMS::Grant: a SYNTHETIC type — a KMS grant is not a CloudFormation/CC resource, so it has
// no CC delete handler. An out-of-band grant found by the KMS key child enumerator (#835) is
// removed via the service's own RevokeGrant, which addresses the grant as { KeyId, GrantId }.
// `GrantId` is the finding's physicalId (the enumerator identity); `KeyId` is the enumerating
// parent KMS Key's CFn physical id (parentPhysicalId, recovered at the stack-actions call site
// from the finding's synthesized `${parentLogicalId}/${GrantId}` logicalId). A grant already gone
// (RevokeGrant on a missing grant) is the delete goal state — applyRevertDeleteSdk treats a
// NotFoundException as success.
const deleteKmsGrant: SdkDeleter = async (ctx) => {
  const keyId = ctx.parentPhysicalId;
  if (!keyId) throw new Error('cannot resolve the parent KMS Key id for the grant revoke');
  await new KMSClient({ region: ctx.region, ...CLIENT_TIMEOUTS }).send(
    new RevokeGrantCommand({ KeyId: keyId, GrantId: ctx.physicalId })
  );
};

export const SDK_DELETERS: Record<string, SdkDeleter> = {
  'AWS::AppSync::ApiKey': deleteAppSyncApiKey,
  'AWS::Route53::RecordSet': deleteRoute53RecordSet,
  'AWS::SQS::QueuePolicy': deleteSqsQueuePolicy,
  'AWS::SecretsManager::ResourcePolicy': deleteSecretsManagerResourcePolicy,
  'AWS::SNS::TopicPolicy': deleteSnsTopicPolicy,
  'AWS::KMS::Grant': deleteKmsGrant,
};

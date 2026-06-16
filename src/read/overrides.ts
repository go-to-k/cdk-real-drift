// SDK-override readers for common CFn types that Cloud Control API cannot read
// (GetResource → UnsupportedActionException). Read logic mirrors cdkd's SDK
// providers, but keyed off the resolved DECLARED properties (Bucket / Topics /
// Queues / Roles / FunctionName / policy ARN) — NOT the CloudFormation physical
// id, because CFn assigns these policy-attachment resources physical ids that
// differ from the underlying target. Returns CFn-shaped properties for the
// classifier; undefined when the target can't be resolved/read (→ skipped).

import { BudgetsClient, DescribeBudgetCommand } from '@aws-sdk/client-budgets';
import { BatchGetProjectsCommand, CodeBuildClient } from '@aws-sdk/client-codebuild';
import {
  CloudWatchLogsClient,
  DescribeMetricFiltersCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { DescribeAddressesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { GetTableCommand, GlueClient } from '@aws-sdk/client-glue';
import {
  ListResourceRecordSetsCommand,
  type RRType,
  Route53Client,
} from '@aws-sdk/client-route-53';
import {
  GetGroupPolicyCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetRolePolicyCommand,
  GetUserPolicyCommand,
  IAMClient,
} from '@aws-sdk/client-iam';
import { LambdaClient, GetPolicyCommand as LambdaGetPolicyCommand } from '@aws-sdk/client-lambda';
import { GetBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';
import { GetScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { GetTopicAttributesCommand, SNSClient } from '@aws-sdk/client-sns';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { READ_RETRY } from './client-config.js';

export interface OverrideCtx {
  physicalId: string;
  declared: Record<string, unknown>;
  region: string;
  accountId: string;
}
export type OverrideReader = (ctx: OverrideCtx) => Promise<Record<string, unknown> | undefined>;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const firstStr = (v: unknown): string | undefined => (Array.isArray(v) ? str(v[0]) : str(v));
function parsePolicy(s: string | undefined): unknown {
  if (!s) return undefined;
  for (const c of [s, safeDecode(s)]) {
    try {
      return JSON.parse(c);
    } catch {
      /* keep trying */
    }
  }
  return s;
}
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const readS3BucketPolicy: OverrideReader = async ({ declared, region }) => {
  const bucket = str(declared.Bucket);
  if (!bucket) return undefined;
  const c = new S3Client({ region, ...READ_RETRY });
  const r = await c.send(new GetBucketPolicyCommand({ Bucket: bucket }));
  return { Bucket: bucket, PolicyDocument: parsePolicy(r.Policy) };
};

const readSnsTopicPolicy: OverrideReader = async ({ declared, region }) => {
  const topic = firstStr(declared.Topics);
  if (!topic) return undefined;
  const c = new SNSClient({ region, ...READ_RETRY });
  const r = await c.send(new GetTopicAttributesCommand({ TopicArn: topic }));
  return { Topics: declared.Topics, PolicyDocument: parsePolicy(r.Attributes?.Policy) };
};

const readSqsQueuePolicy: OverrideReader = async ({ declared, region }) => {
  const queue = firstStr(declared.Queues);
  if (!queue) return undefined;
  const c = new SQSClient({ region, ...READ_RETRY });
  const r = await c.send(
    new GetQueueAttributesCommand({ QueueUrl: queue, AttributeNames: ['Policy'] })
  );
  return { Queues: declared.Queues, PolicyDocument: parsePolicy(r.Attributes?.Policy) };
};

const readIamPolicy: OverrideReader = async ({ declared, region }) => {
  const name = str(declared.PolicyName);
  if (!name) return undefined;
  const c = new IAMClient({ region, ...READ_RETRY });
  const role = firstStr(declared.Roles);
  const user = firstStr(declared.Users);
  const group = firstStr(declared.Groups);
  let doc: string | undefined;
  if (role)
    doc = (await c.send(new GetRolePolicyCommand({ RoleName: role, PolicyName: name })))
      .PolicyDocument;
  else if (user)
    doc = (await c.send(new GetUserPolicyCommand({ UserName: user, PolicyName: name })))
      .PolicyDocument;
  else if (group)
    doc = (await c.send(new GetGroupPolicyCommand({ GroupName: group, PolicyName: name })))
      .PolicyDocument;
  else return undefined;
  return {
    PolicyName: name,
    PolicyDocument: parsePolicy(doc),
    ...(role
      ? { Roles: declared.Roles }
      : user
        ? { Users: declared.Users }
        : { Groups: declared.Groups }),
  };
};

const readIamManagedPolicy: OverrideReader = async ({ physicalId, region }) => {
  // CFn physical id for a managed policy IS its ARN.
  if (!physicalId.startsWith('arn:')) return undefined;
  const c = new IAMClient({ region, ...READ_RETRY });
  const p = (await c.send(new GetPolicyCommand({ PolicyArn: physicalId }))).Policy;
  if (!p) return undefined;
  const ver = (
    await c.send(
      new GetPolicyVersionCommand({ PolicyArn: physicalId, VersionId: p.DefaultVersionId })
    )
  ).PolicyVersion;
  // GetPolicy OMITS Description when it is empty, while CDK templates declare
  // `Description: ""` — an undefined-valued key here read as `desired="" actual=
  // undefined` false declared drift (first live policies integ run, R69). An
  // absent live description IS the empty description.
  return {
    PolicyDocument: parsePolicy(ver?.Document),
    Path: p.Path,
    Description: p.Description ?? '',
  };
};

const readLambdaPermission: OverrideReader = async ({ declared, region }) => {
  const fn = str(declared.FunctionName);
  if (!fn) return undefined;
  const c = new LambdaClient({ region, ...READ_RETRY });
  // GetPolicy throws ResourceNotFoundException when the function has NO resource
  // policy at all — i.e. the permission was deleted out of band. Let it propagate
  // so the router maps it to `deleted` rather than swallowing it as skipped.
  const policy = parsePolicy(
    (await c.send(new LambdaGetPolicyCommand({ FunctionName: fn }))).Policy
  );
  const stmts = (policy as { Statement?: Array<Record<string, unknown>> })?.Statement ?? [];
  // best-effort match by Action + Principal against the declared permission
  const want = { action: str(declared.Action), principal: str(declared.Principal) };
  const m = stmts.find(
    (s) =>
      (!want.action || s.Action === want.action) &&
      (!want.principal || JSON.stringify(s.Principal).includes(String(want.principal)))
  );
  // No match while the policy itself exists = the specific statement was removed out
  // of band (but other statements remain). Return undefined → router maps it to
  // `skipped` (target not resolvable), NOT `deleted`: safely asserting THIS statement
  // is gone needs its StatementId, which the best-effort Action+Principal match lacks.
  // A wholly-deleted resource policy throws ResourceNotFoundException above → `deleted`.
  if (!m) return undefined;
  // Return the MATCHED statement's REAL fields — never echo the declared template
  // (an echoed Principal makes a Principal drift structurally undetectable).
  // Normalize the statement Principal to CFn shape: {Service:"x"}/{AWS:"x"} -> "x",
  // a plain string stays as-is.
  const cond = m.Condition as
    | { ArnLike?: Record<string, unknown>; StringEquals?: Record<string, unknown> }
    | undefined;
  const sourceArn = str(cond?.ArnLike?.['AWS:SourceArn']);
  const sourceAccount = str(cond?.StringEquals?.['AWS:SourceAccount']);
  return {
    FunctionName: fn,
    Action: m.Action,
    Principal: normalizeLambdaPrincipal(m.Principal),
    // omit SourceArn/SourceAccount when absent (→ readGap, honest; never fabricate)
    ...(sourceArn !== undefined && { SourceArn: sourceArn }),
    ...(sourceAccount !== undefined && { SourceAccount: sourceAccount }),
  };
};

// Lambda resource-policy Principal -> CFn Principal shape. AWS stores it as
// {Service:"x"} or {AWS:"x"}; CFn declares the bare string. A plain string (or
// anything else) is returned unchanged.
function normalizeLambdaPrincipal(p: unknown): unknown {
  if (p && typeof p === 'object') {
    const o = p as Record<string, unknown>;
    if (typeof o.Service === 'string') return o.Service;
    if (typeof o.AWS === 'string') return o.AWS;
  }
  return p;
}

const readBudget: OverrideReader = async ({ physicalId, declared, accountId, region }) => {
  // The CFn physical id of AWS::Budgets::Budget IS the budget name — and unlike
  // declared.Budget.BudgetName it is always present, including the common case
  // where the template declares no name and CFn generates one
  // (`<logicalId>-<region>-<ts>-...`). Resolving by declared name only skipped
  // exactly those budgets whole-resource (dogfood, R65); declared name stays as
  // the fallback for safety.
  const budget = declared.Budget as Record<string, unknown> | undefined;
  const name = str(physicalId) || str(budget?.BudgetName);
  if (!name || !accountId) return undefined;
  const c = new BudgetsClient({ region, ...READ_RETRY });
  const r = await c.send(new DescribeBudgetCommand({ AccountId: accountId, BudgetName: name }));
  const b = r.Budget;
  if (!b) return undefined;
  // BudgetLimit is in the projection (R67): once R65 made budgets readable, a
  // declared BudgetLimit compared against a projection WITHOUT it reported
  // `desired={...} actual=undefined` false drift. The live Amount is a string
  // ("5.0") vs the declared number (5) — isStringlyEqualScalar's numeric arm folds that.
  //
  // CostFilters is the budget's SCOPE — which services/accounts/tags it watches.
  // Omitting it made an out-of-band scope change (e.g. narrowing a budget from all
  // services to one) undetectable: a declared CostFilters became a `readGap` (not
  // compared) and an undeclared one was wholly invisible. FP-safe to add: DescribeBudget
  // returns `{}` (or omits it) for an unfiltered budget, which `isTrivialEmpty`
  // suppresses, so a budget that declares no filters stays CLEAN; a declared filter set
  // is compared, and one added out of band surfaces. The projection still stays thin
  // where it must: COMPUTED fields (CalculatedSpend) and AWS-defaulted blobs (TimePeriod's
  // 2087 end date, the full CostTypes default set) are deliberately NOT offered — they
  // would be live-only noise.
  return {
    Budget: {
      BudgetName: b.BudgetName,
      BudgetType: b.BudgetType,
      TimeUnit: b.TimeUnit,
      ...(b.BudgetLimit !== undefined && { BudgetLimit: b.BudgetLimit }),
      ...(b.CostFilters !== undefined && { CostFilters: b.CostFilters }),
    },
  };
};

// AWS::EC2::EIP — Cloud Control API GetResource throws ValidationException for
// this type, so read it via EC2 DescribeAddresses. The CFn physical id is the
// allocation id (eipalloc-...) for VPC EIPs, or the public IP for classic EIPs.
const readEc2Eip: OverrideReader = async ({ physicalId, region }) => {
  const id = str(physicalId);
  if (!id) return undefined;
  const c = new EC2Client({ region, ...READ_RETRY });
  const input = id.startsWith('eipalloc-') ? { AllocationIds: [id] } : { PublicIps: [id] };
  // Not-found surfaces as InvalidAddress.NotFound / InvalidAllocationID.NotFound;
  // let it propagate so the router maps it to `deleted` (the EIP was released out
  // of band) instead of being silently swallowed as an empty model.
  const r = await c.send(new DescribeAddressesCommand(input));
  const addr = r.Addresses?.[0];
  if (!addr) return undefined;
  const tags = Array.isArray(addr.Tags)
    ? addr.Tags.filter((t) => str(t.Key) !== undefined).map((t) => ({
        Key: t.Key as string,
        Value: t.Value ?? '',
      }))
    : undefined;
  const model: Record<string, unknown> = {};
  if (str(addr.Domain)) model.Domain = addr.Domain;
  if (str(addr.NetworkBorderGroup)) model.NetworkBorderGroup = addr.NetworkBorderGroup;
  if (str(addr.PublicIp)) model.PublicIp = addr.PublicIp;
  if (str(addr.InstanceId)) model.InstanceId = addr.InstanceId;
  if (str(addr.NetworkInterfaceId)) model.NetworkInterfaceId = addr.NetworkInterfaceId;
  if (tags && tags.length > 0) model.Tags = tags;
  return model;
};

// Align a live DNS value's trailing dot to the declared value's style, so AWS's
// always-trailing-dot form ("x.cloudfront.net.") is not false drift against a
// declared value without the dot (a GetAtt-resolved DomainName has no dot). Real
// drift to a different name still differs.
const alignTrailingDot = (live: string | undefined, declared: unknown): string | undefined => {
  if (live === undefined) return undefined;
  const declHasDot = typeof declared === 'string' && declared.endsWith('.');
  return declHasDot ? (live.endsWith('.') ? live : `${live}.`) : live.replace(/\.$/, '');
};

// AWS::Route53::RecordSet — CC API GetResource throws UnsupportedActionException.
// Read via Route53 ListResourceRecordSets (the CFn physical id is
// `<HostedZoneId>_<Name>_<Type>`; declared values are preferred, id is the fallback).
const readRoute53RecordSet: OverrideReader = async ({ physicalId, declared, region }) => {
  const parts = physicalId.split('_');
  const hasIdParts = parts.length >= 3;
  const hostedZoneId = str(declared.HostedZoneId) ?? (hasIdParts ? parts[0] : undefined);
  const name = str(declared.Name) ?? (hasIdParts ? parts[1] : undefined);
  const type = str(declared.Type) ?? (hasIdParts ? parts[parts.length - 1] : undefined);
  if (!hostedZoneId || !name || !type) return undefined;
  const c = new Route53Client({ region, ...READ_RETRY });
  const r = await c.send(
    new ListResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      StartRecordName: name,
      StartRecordType: type as RRType,
      MaxItems: 1,
    })
  );
  const canon = (s: string): string => s.replace(/\.$/, '').toLowerCase();
  const rec = r.ResourceRecordSets?.find(
    (x) => x.Type === type && x.Name && canon(x.Name) === canon(name)
  );
  if (!rec) return undefined;
  const model: Record<string, unknown> = {
    Name: alignTrailingDot(rec.Name, declared.Name),
    Type: rec.Type,
    HostedZoneId: hostedZoneId,
  };
  if (rec.TTL !== undefined) model.TTL = String(rec.TTL); // CFn TTL is a string
  const records = rec.ResourceRecords?.map((rr) => rr.Value).filter((v): v is string => !!v);
  if (records && records.length > 0) model.ResourceRecords = records;
  if (rec.AliasTarget) {
    const declAlias = declared.AliasTarget as Record<string, unknown> | undefined;
    model.AliasTarget = {
      DNSName: alignTrailingDot(rec.AliasTarget.DNSName, declAlias?.DNSName),
      HostedZoneId: rec.AliasTarget.HostedZoneId,
      EvaluateTargetHealth: rec.AliasTarget.EvaluateTargetHealth ?? false,
    };
  }
  return model;
};

// AWS::Glue::Table — CC API GetResource throws UnsupportedActionException. Read via
// Glue GetTable. Maps the live Table back to the CFn `{ CatalogId?, DatabaseName,
// TableInput }` shape, returning ONLY the TableInput sub-fields CFn models —
// AWS-managed fields (CreateTime / UpdateTime / CreatedBy / VersionId /
// IsRegisteredWithLakeFormation / DatabaseName / CatalogId inside Table) are dropped
// as they are not declarable and would be pure noise.
const readGlueTable: OverrideReader = async ({ physicalId, declared, region }) => {
  const idParts = physicalId.split('|');
  const dbName = str(declared.DatabaseName) ?? (idParts.length >= 2 ? idParts[0] : undefined);
  const tableInput = declared.TableInput as Record<string, unknown> | undefined;
  const name =
    str(tableInput?.Name) ?? (idParts.length >= 2 ? idParts[idParts.length - 1] : undefined);
  if (!dbName || !name) return undefined;
  const catalogId = str(declared.CatalogId);
  const c = new GlueClient({ region, ...READ_RETRY });
  const r = await c.send(
    new GetTableCommand({
      DatabaseName: dbName,
      Name: name,
      ...(catalogId && { CatalogId: catalogId }),
    })
  );
  const t = r.Table;
  if (!t) return undefined;
  const ti: Record<string, unknown> = { Name: t.Name };
  const copy = <K extends keyof typeof t>(k: K, as: string): void => {
    if (t[k] !== undefined) ti[as] = t[k];
  };
  copy('Description', 'Description');
  copy('Owner', 'Owner');
  copy('Retention', 'Retention');
  copy('TableType', 'TableType');
  copy('Parameters', 'Parameters');
  copy('PartitionKeys', 'PartitionKeys');
  copy('StorageDescriptor', 'StorageDescriptor');
  copy('ViewOriginalText', 'ViewOriginalText');
  copy('ViewExpandedText', 'ViewExpandedText');
  const model: Record<string, unknown> = { DatabaseName: dbName, TableInput: ti };
  if (catalogId) model.CatalogId = catalogId;
  return model;
};

// AWS::Logs::MetricFilter — CC API GetResource throws ValidationException. Read via
// CloudWatch Logs DescribeMetricFilters. The CFn physical id IS the filter name;
// the log group comes from the declared (GetAtt-resolved) LogGroupName.
const readMetricFilter: OverrideReader = async ({ physicalId, declared, region }) => {
  const logGroup = str(declared.LogGroupName);
  const filterName = str(physicalId) ?? str(declared.FilterName);
  if (!logGroup || !filterName) return undefined;
  const c = new CloudWatchLogsClient({ region, ...READ_RETRY });
  const r = await c.send(
    new DescribeMetricFiltersCommand({ logGroupName: logGroup, filterNamePrefix: filterName })
  );
  const mf = r.metricFilters?.find((m) => m.filterName === filterName);
  if (!mf) return undefined;
  return {
    LogGroupName: logGroup,
    FilterName: filterName,
    FilterPattern: mf.filterPattern ?? '',
    MetricTransformations: (mf.metricTransformations ?? []).map((t) => ({
      MetricName: t.metricName,
      MetricNamespace: t.metricNamespace,
      MetricValue: t.metricValue,
      ...(t.defaultValue !== undefined && { DefaultValue: t.defaultValue }),
      ...(t.unit !== undefined && { Unit: t.unit }),
      ...(t.dimensions !== undefined && { Dimensions: t.dimensions }),
    })),
  };
};

// AWS::Scheduler::Schedule — Cloud Control CAN read this type, but its
// primaryIdentifier is the bare Name and the read handler only looks in the
// DEFAULT schedule group: a schedule in any other group reads as not-found and
// falsely reports DELETED (proven live on the harvest3 fixture, R74 — Name-only,
// "group/name", "group|name", and the full ARN were all tried against CC).
// Read via Scheduler GetSchedule with the declared GroupName instead. The CFn
// physical id IS the schedule name.
const readSchedulerSchedule: OverrideReader = async ({ physicalId, declared, region }) => {
  const name = str(physicalId) ?? str(declared.Name);
  if (!name) return undefined;
  const group = str(declared.GroupName); // omitted -> service default group
  const c = new SchedulerClient({ region, ...READ_RETRY });
  // Not-found propagates so the router maps a genuinely deleted schedule to `deleted`.
  const s = await c.send(
    new GetScheduleCommand({ Name: name, ...(group && { GroupName: group }) })
  );
  // Project ONLY CFn-modeled props — Arn/CreationDate/LastModificationDate are
  // AWS-managed noise the classifier should never see from an SDK reader.
  return {
    Name: s.Name,
    ...(s.GroupName !== undefined && { GroupName: s.GroupName }),
    ...(s.ScheduleExpression !== undefined && { ScheduleExpression: s.ScheduleExpression }),
    ...(s.ScheduleExpressionTimezone !== undefined && {
      ScheduleExpressionTimezone: s.ScheduleExpressionTimezone,
    }),
    ...(s.FlexibleTimeWindow !== undefined && { FlexibleTimeWindow: s.FlexibleTimeWindow }),
    ...(s.State !== undefined && { State: s.State }),
    ...(s.Description !== undefined && { Description: s.Description }),
    ...(s.KmsKeyArn !== undefined && { KmsKeyArn: s.KmsKeyArn }),
    ...(s.ActionAfterCompletion !== undefined && {
      ActionAfterCompletion: s.ActionAfterCompletion,
    }),
    ...(s.StartDate !== undefined && { StartDate: s.StartDate.toISOString() }),
    ...(s.EndDate !== undefined && { EndDate: s.EndDate.toISOString() }),
    ...(s.Target !== undefined && { Target: s.Target }),
  };
};

// AWS::CodeBuild::Project — Cloud Control GetResource throws
// UnsupportedActionException (R84/R85, observed live on the harvest6 fixture).
// Read via CodeBuild BatchGetProjects — the CFn physical id IS the project name.
// Maps the camelCase SDK Project back to the CFn PascalCase shape, projecting
// ONLY CFn-modeled props (Arn / Created / LastModified / Badge URL are
// AWS-managed noise). The declared compare is subset-based, so nested fields the
// template never set are ignored; an absent project returns undefined (-> skip).
const readCodeBuildProject: OverrideReader = async ({ physicalId, declared, region }) => {
  const name = str(physicalId) ?? str(declared.Name);
  if (!name) return undefined;
  const c = new CodeBuildClient({ region, ...READ_RETRY });
  const r = await c.send(new BatchGetProjectsCommand({ names: [name] }));
  const p = r.projects?.[0];
  if (!p) return undefined;
  const model: Record<string, unknown> = { Name: p.name };
  if (p.serviceRole !== undefined) model.ServiceRole = p.serviceRole;
  if (p.description !== undefined) model.Description = p.description;
  if (p.timeoutInMinutes !== undefined) model.TimeoutInMinutes = p.timeoutInMinutes;
  if (p.queuedTimeoutInMinutes !== undefined)
    model.QueuedTimeoutInMinutes = p.queuedTimeoutInMinutes;
  if (p.encryptionKey !== undefined) model.EncryptionKey = p.encryptionKey;
  const src = p.source;
  if (src)
    model.Source = {
      ...(src.type !== undefined && { Type: src.type }),
      ...(src.location !== undefined && { Location: src.location }),
      ...(src.buildspec !== undefined && { BuildSpec: src.buildspec }),
      ...(src.gitCloneDepth !== undefined && { GitCloneDepth: src.gitCloneDepth }),
    };
  const art = p.artifacts;
  if (art)
    model.Artifacts = {
      ...(art.type !== undefined && { Type: art.type }),
      ...(art.location !== undefined && { Location: art.location }),
    };
  const env = p.environment;
  if (env)
    model.Environment = {
      ...(env.type !== undefined && { Type: env.type }),
      ...(env.computeType !== undefined && { ComputeType: env.computeType }),
      ...(env.image !== undefined && { Image: env.image }),
      ...(env.privilegedMode !== undefined && { PrivilegedMode: env.privilegedMode }),
      ...(env.imagePullCredentialsType !== undefined && {
        ImagePullCredentialsType: env.imagePullCredentialsType,
      }),
      ...(env.environmentVariables !== undefined && {
        EnvironmentVariables: env.environmentVariables.map((v) => ({
          Name: v.name,
          Value: v.value,
          ...(v.type !== undefined && { Type: v.type }),
        })),
      }),
    };
  return model;
};

export const SDK_OVERRIDES: Record<string, OverrideReader> = {
  'AWS::CodeBuild::Project': readCodeBuildProject,
  'AWS::S3::BucketPolicy': readS3BucketPolicy,
  'AWS::SNS::TopicPolicy': readSnsTopicPolicy,
  'AWS::SQS::QueuePolicy': readSqsQueuePolicy,
  'AWS::IAM::Policy': readIamPolicy,
  'AWS::IAM::ManagedPolicy': readIamManagedPolicy,
  'AWS::Lambda::Permission': readLambdaPermission,
  'AWS::Budgets::Budget': readBudget,
  'AWS::EC2::EIP': readEc2Eip,
  'AWS::Route53::RecordSet': readRoute53RecordSet,
  'AWS::Glue::Table': readGlueTable,
  'AWS::Logs::MetricFilter': readMetricFilter,
  'AWS::Scheduler::Schedule': readSchedulerSchedule,
};

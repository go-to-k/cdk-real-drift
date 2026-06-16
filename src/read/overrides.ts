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
  type MetricFilter,
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
import { ResourceGoneError } from '../aws-errors.js';
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
  // Security-scoping conditions that were NOT projected, so an out-of-band widening
  // was invisible: PrincipalOrgID restricts invocation to an AWS Organization
  // (dropping it opens the function to any matching principal), and
  // FunctionUrlAuthType gates a function-URL permission (a flip from AWS_IAM to NONE
  // makes the URL public). Both are stored under the verbatim global/service
  // condition keys (lowercase `aws:`/`lambda:`, unlike Lambda's own capitalized
  // `AWS:Source*`). Absent unless the permission uses them → omitted, no noise.
  const principalOrgId = str(cond?.StringEquals?.['aws:PrincipalOrgID']);
  const functionUrlAuthType = str(cond?.StringEquals?.['lambda:FunctionUrlAuthType']);
  return {
    FunctionName: fn,
    Action: m.Action,
    Principal: normalizeLambdaPrincipal(m.Principal),
    // omit SourceArn/SourceAccount when absent (→ readGap, honest; never fabricate)
    ...(sourceArn !== undefined && { SourceArn: sourceArn }),
    ...(sourceAccount !== undefined && { SourceAccount: sourceAccount }),
    ...(principalOrgId !== undefined && { PrincipalOrgID: principalOrgId }),
    ...(functionUrlAuthType !== undefined && { FunctionUrlAuthType: functionUrlAuthType }),
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
  // PlannedBudgetLimits — a time-phased budget's per-period limits. Omitting it made an
  // out-of-band change to a future month's limit invisible (a declared one became a
  // readGap; an undeclared one wholly invisible). FP-safe: DescribeBudget returns it ONLY
  // for a budget created WITH planned limits (SDK-documented absent-when-unused), so a
  // plain fixed budget stays CLEAN; the inner Spend.Amount string ("40.0") vs the declared
  // number is folded by isStringlyEqualScalar, exactly like BudgetLimit.
  //
  // AutoAdjustData — switching a budget to auto-adjusting (or changing its look-back) was
  // undetectable. Projected THIN: only the user-settable AutoAdjustType + HistoricalOptions
  // .BudgetAdjustmentPeriod. The COMPUTED fields (LastAutoAdjustTime, the auto-calculated
  // HistoricalOptions.LookBackAvailablePeriods) are deliberately NOT offered — they would
  // be live-only noise. Absent for a fixed budget, so no first-run noise there.
  const aad = b.AutoAdjustData;
  return {
    Budget: {
      BudgetName: b.BudgetName,
      BudgetType: b.BudgetType,
      TimeUnit: b.TimeUnit,
      ...(b.BudgetLimit !== undefined && { BudgetLimit: b.BudgetLimit }),
      ...(b.PlannedBudgetLimits !== undefined && { PlannedBudgetLimits: b.PlannedBudgetLimits }),
      ...(b.CostFilters !== undefined && { CostFilters: b.CostFilters }),
      ...(aad && {
        AutoAdjustData: {
          ...(aad.AutoAdjustType !== undefined && { AutoAdjustType: aad.AutoAdjustType }),
          ...(aad.HistoricalOptions?.BudgetAdjustmentPeriod !== undefined && {
            HistoricalOptions: {
              BudgetAdjustmentPeriod: aad.HistoricalOptions.BudgetAdjustmentPeriod,
            },
          }),
        },
      }),
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
  // A name+type can have MANY records that differ only by SetIdentifier (weighted,
  // latency, failover, geolocation, multivalue routing — an L1 CfnRecordSet pattern).
  // MaxItems:1 returned only the FIRST one at the cursor, so the declared variant was
  // either read as the WRONG record (false positive/negative against the wrong values)
  // or missed entirely. Drop the cap (Route53's default page is 100 records from the
  // StartRecord cursor, which holds all variants of one name+type consecutively) and
  // disambiguate by SetIdentifier below.
  const c = new Route53Client({ region, ...READ_RETRY });
  const r = await c.send(
    new ListResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      StartRecordName: name,
      StartRecordType: type as RRType,
    })
  );
  const canon = (s: string): string => s.replace(/\.$/, '').toLowerCase();
  // Match the declared SetIdentifier too: a simple record declares none and AWS
  // returns none (undefined === undefined), while a weighted/latency variant matches
  // its specific identifier instead of whichever sibling happened to come first.
  const declSetId = str(declared.SetIdentifier);
  const rec = r.ResourceRecordSets?.find(
    (x) =>
      x.Type === type &&
      x.Name &&
      canon(x.Name) === canon(name) &&
      (x.SetIdentifier ?? undefined) === declSetId
  );
  // The zone was listed successfully but the declared name+type(+SetIdentifier) record
  // is absent — it was deleted out of band. Distinct from the "couldn't resolve the
  // target" guard above (which returns undefined → skipped): here we KNOW it is gone.
  if (!rec)
    throw new ResourceGoneError(
      `Route53 RecordSet ${name} ${type} absent from zone ${hostedZoneId}`
    );
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
  // Routing-policy fields — projected away before, so a console change to a weight /
  // failover role / health check was invisible. All absent for a simple record (the
  // common case) so they add no noise; present only on the routing variant the user
  // declared, which is now matched correctly via SetIdentifier above.
  if (rec.SetIdentifier !== undefined) model.SetIdentifier = rec.SetIdentifier;
  if (rec.Weight !== undefined) model.Weight = rec.Weight;
  if (rec.Region !== undefined) model.Region = rec.Region;
  if (rec.Failover !== undefined) model.Failover = rec.Failover;
  if (rec.MultiValueAnswer !== undefined) model.MultiValueAnswer = rec.MultiValueAnswer;
  if (rec.HealthCheckId !== undefined) model.HealthCheckId = rec.HealthCheckId;
  const geo = rec.GeoLocation;
  if (geo)
    model.GeoLocation = {
      ...(geo.ContinentCode !== undefined && { ContinentCode: geo.ContinentCode }),
      ...(geo.CountryCode !== undefined && { CountryCode: geo.CountryCode }),
      ...(geo.SubdivisionCode !== undefined && { SubdivisionCode: geo.SubdivisionCode }),
    };
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
  // TargetTable — a Glue resource-link table points at another catalog/db/table; it
  // was the one CFn-modeled TableInput field the projection omitted, so an out-of-band
  // repoint was undetectable. Absent for a normal (non-link) table, so adding it is
  // inert there (no FP) and only the resource-link case gains coverage.
  copy('TargetTable', 'TargetTable');
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
  // `filterNamePrefix: filterName` narrows each page to filters that START WITH this
  // name — but when many filters share the prefix (a name that is also a prefix of
  // others), the EXACT-named one can be paginated past the first page. Follow
  // nextToken until it is found, so a present filter is never misread as deleted (a
  // false negative). Stops as soon as the exact match appears.
  let mf: MetricFilter | undefined;
  let nextToken: string | undefined;
  do {
    const r = await c.send(
      new DescribeMetricFiltersCommand({
        logGroupName: logGroup,
        filterNamePrefix: filterName,
        ...(nextToken && { nextToken }),
      })
    );
    mf = r.metricFilters?.find((m) => m.filterName === filterName);
    nextToken = r.nextToken;
  } while (!mf && nextToken);
  // The log group was described successfully (every page) but the exact-named filter is
  // absent — it was deleted out of band. (A deleted LOG GROUP instead throws
  // ResourceNotFoundException above → also `deleted`; an unresolvable target returned
  // undefined → skipped before the describe.)
  if (!mf)
    throw new ResourceGoneError(`MetricFilter ${filterName} absent from log group ${logGroup}`);
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
  // R(this) — these CFn-modeled props were OMITTED from the projection, so an
  // out-of-band change to them was undetectable (a declared one became a benign
  // readGap; an undeclared one was invisible). All FP-safe to add:
  //   Visibility   — PRIVATE/PUBLIC_READ; security-relevant (a project flipped to
  //                  PUBLIC_READ exposes build logs/artifacts). Always present; the
  //                  PRIVATE default is folded via KNOWN_DEFAULTS so it is atDefault,
  //                  not first-run noise.
  //   VpcConfig    — absent unless the project runs in a VPC → no noise when unused.
  //   ConcurrentBuildLimit / SourceVersion — absent unless set → no noise.
  if (p.projectVisibility !== undefined) model.Visibility = p.projectVisibility;
  if (p.concurrentBuildLimit !== undefined) model.ConcurrentBuildLimit = p.concurrentBuildLimit;
  if (p.sourceVersion !== undefined) model.SourceVersion = p.sourceVersion;
  // LogsConfig — CloudWatch/S3 build-log destinations. Security/observability
  // relevant (enabling S3 logs writes build output to a bucket; a custom CloudWatch
  // group/stream redirects audit data) and commonly toggled in the console, yet it
  // was projected away entirely, so an out-of-band logging change was undetectable.
  // FP-safe: BatchGetProjects returns logsConfig=null (absent) when the project was
  // never configured with logging, and otherwise echoes EXACTLY the configured shape
  // with NO server-added siblings (verified live: setting only cloudWatchLogs does
  // not materialize an s3Logs default, and vice versa). So a never-configured project
  // emits nothing and a declared one matches its template. The lone always-present
  // extra is s3Logs.encryptionDisabled=false, which isTrivialEmpty suppresses — no
  // KNOWN_DEFAULTS entry needed.
  const logs = p.logsConfig;
  if (logs) {
    const cw = logs.cloudWatchLogs;
    const s3 = logs.s3Logs;
    model.LogsConfig = {
      ...(cw && {
        CloudWatchLogs: {
          ...(cw.status !== undefined && { Status: cw.status }),
          ...(cw.groupName !== undefined && { GroupName: cw.groupName }),
          ...(cw.streamName !== undefined && { StreamName: cw.streamName }),
        },
      }),
      ...(s3 && {
        S3Logs: {
          ...(s3.status !== undefined && { Status: s3.status }),
          ...(s3.location !== undefined && { Location: s3.location }),
          ...(s3.encryptionDisabled !== undefined && { EncryptionDisabled: s3.encryptionDisabled }),
        },
      }),
    };
  }
  // BadgeEnabled — a public build-status badge exposes build state; console-toggleable.
  // badge.badgeEnabled is false when off → isTrivialEmpty suppresses it (no first-run
  // noise); flipping it true surfaces. badge.badgeRequestUrl is a read-only computed
  // URL, deliberately not projected.
  if (p.badge?.badgeEnabled !== undefined) model.BadgeEnabled = p.badge.badgeEnabled;
  const vpc = p.vpcConfig;
  if (vpc && (vpc.vpcId || vpc.subnets?.length || vpc.securityGroupIds?.length))
    model.VpcConfig = {
      ...(vpc.vpcId !== undefined && { VpcId: vpc.vpcId }),
      ...(vpc.subnets !== undefined && { Subnets: vpc.subnets }),
      ...(vpc.securityGroupIds !== undefined && { SecurityGroupIds: vpc.securityGroupIds }),
    };
  // Cache — was omitted, so an out-of-band switch to/from S3 caching (a cost + a
  // cross-project cache-sharing surface) was undetectable. BatchGetProjects ALWAYS
  // returns cache (default `{type:'NO_CACHE'}`), so the never-configured case is
  // folded to atDefault via KNOWN_DEFAULTS (`Cache: {Type:'NO_CACHE'}`); a declared
  // S3/LOCAL cache projects its real shape and matches the template. Modes/Location
  // are projected only when present so the NO_CACHE default is exactly `{Type:'NO_CACHE'}`
  // (else it would not fold). A declared cache change still surfaces.
  const cache = p.cache;
  if (cache)
    model.Cache = {
      ...(cache.type !== undefined && { Type: cache.type }),
      ...(cache.location !== undefined && { Location: cache.location }),
      ...(cache.modes?.length && { Modes: cache.modes }),
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

// SDK-override readers for common CFn types that Cloud Control API cannot read
// (GetResource → UnsupportedActionException). Read logic mirrors cdkd's SDK
// providers, but keyed off the resolved DECLARED properties (Bucket / Topics /
// Queues / Roles / FunctionName / policy ARN) — NOT the CloudFormation physical
// id, because CFn assigns these policy-attachment resources physical ids that
// differ from the underlying target. Returns CFn-shaped properties for the
// classifier; undefined when the target can't be resolved/read (→ skipped).

import { AppSyncClient, ListApiKeysCommand } from '@aws-sdk/client-appsync';
import { BudgetsClient, DescribeBudgetCommand } from '@aws-sdk/client-budgets';
import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { CognitoSyncClient, GetCognitoEventsCommand } from '@aws-sdk/client-cognito-sync';
import { BatchGetProjectsCommand, CodeBuildClient } from '@aws-sdk/client-codebuild';
import { DescribeServicesCommand, ECSClient } from '@aws-sdk/client-ecs';
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  DocDBClient,
} from '@aws-sdk/client-docdb';
import {
  CloudWatchLogsClient,
  DescribeMetricFiltersCommand,
  type MetricFilter,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  DescribeAddressesCommand,
  DescribeLaunchTemplateVersionsCommand,
  DescribeNetworkAclsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import {
  GetClassifierCommand,
  GetConnectionCommand,
  GetTableCommand,
  GetWorkflowCommand,
  GlueClient,
} from '@aws-sdk/client-glue';
import {
  ListResourceRecordSetsCommand,
  type ListResourceRecordSetsCommandOutput,
  type ResourceRecordSet,
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
  ListEntitiesForPolicyCommand,
} from '@aws-sdk/client-iam';
import { LambdaClient, GetPolicyCommand as LambdaGetPolicyCommand } from '@aws-sdk/client-lambda';
import { GetBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DescribeCacheClustersCommand,
  DescribeReplicationGroupsCommand,
  DescribeUsersCommand as DescribeCacheUsersCommand,
  ElastiCacheClient,
} from '@aws-sdk/client-elasticache';
import {
  DescribeUsersCommand as DescribeMemoryDbUsersCommand,
  MemoryDBClient,
} from '@aws-sdk/client-memorydb';
import {
  type AnomalyDetector,
  CloudWatchClient,
  DescribeAnomalyDetectorsCommand,
} from '@aws-sdk/client-cloudwatch';
import { DLMClient, GetLifecyclePolicyCommand } from '@aws-sdk/client-dlm';
import {
  DatabaseMigrationServiceClient,
  DescribeEndpointsCommand,
  DescribeReplicationSubnetGroupsCommand,
} from '@aws-sdk/client-database-migration-service';
import {
  GetJobTemplateCommand,
  GetQueueCommand,
  MediaConvertClient,
} from '@aws-sdk/client-mediaconvert';
import { GetWorkgroupCommand, RedshiftServerlessClient } from '@aws-sdk/client-redshift-serverless';
import { GetScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import {
  DescribeReceiptRuleCommand,
  DescribeReceiptRuleSetCommand,
  ListReceiptFiltersCommand,
  type ReceiptRule,
  SESClient,
} from '@aws-sdk/client-ses';
import { DescribeParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  GetNamespaceCommand,
  GetServiceCommand,
  ServiceDiscoveryClient,
} from '@aws-sdk/client-servicediscovery';
import { GetTopicAttributesCommand, SNSClient } from '@aws-sdk/client-sns';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ResourceGoneError } from '../aws-errors.js';
import { READ_RETRY } from './client-config.js';

export interface OverrideCtx {
  physicalId: string;
  declared: Record<string, unknown>;
  region: string;
  accountId: string;
  // The resource's CloudFormation type — set on the REVERT (SdkWriter) path so a
  // type-agnostic writer (the Cloud Control index-revert for nested array-element values)
  // can GetResource/UpdateResource it. Unused by the read (OverrideReader) path.
  resourceType?: string;
  // The Cloud Control identifier — the composite the READ path resolves via
  // CC_IDENTIFIER_ADAPTERS (e.g. AWS::ApiGateway::Stage = `RestApiId|StageName`), set on the
  // REVERT (SdkWriter) path. A Cloud-Control-routed writer (writeCloudControlIndexNested)
  // MUST address the resource by this, not the bare CFn physical id, or GetResource /
  // UpdateResource ValidationException. Falls back to `physicalId` when no adapter applies.
  identifier?: string;
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
  // Live attachment lists (the Roles/Users/Groups this policy is attached to). Read
  // them so classify can detect an out-of-band DETACH of a member the template
  // DECLARES — but the comparison is ASYMMETRIC (declared∖live only): the live set is
  // a UNION that legitimately exceeds any one stack's intent (a role's
  // `ManagedPolicyArns`, another stack, the console), so live-only members are never
  // a finding (see IAM_ATTACHMENT_SUBSET in diff/classify.ts). Names, not ARNs —
  // matching the CFn `Roles`/`Users`/`Groups` property shape (a Ref to a role
  // resolves to the role NAME). Paginated: a popular managed policy can be attached
  // to far more than one page of entities.
  const roles: string[] = [];
  const users: string[] = [];
  const groups: string[] = [];
  let marker: string | undefined;
  do {
    const e = await c.send(
      new ListEntitiesForPolicyCommand({ PolicyArn: physicalId, Marker: marker })
    );
    for (const r of e?.PolicyRoles ?? []) if (r.RoleName) roles.push(r.RoleName);
    for (const u of e?.PolicyUsers ?? []) if (u.UserName) users.push(u.UserName);
    for (const g of e?.PolicyGroups ?? []) if (g.GroupName) groups.push(g.GroupName);
    marker = e?.IsTruncated ? e.Marker : undefined;
  } while (marker);
  // GetPolicy OMITS Description when it is empty, while CDK templates declare
  // `Description: ""` — an undefined-valued key here read as `desired="" actual=
  // undefined` false declared drift (first live policies integ run, R69). An
  // absent live description IS the empty description.
  return {
    PolicyDocument: parsePolicy(ver?.Document),
    Path: p.Path,
    Description: p.Description ?? '',
    Roles: roles,
    Users: users,
    Groups: groups,
  };
};

const readLambdaPermission: OverrideReader = async ({ declared, physicalId, region }) => {
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
  // The CFn physical id of an AWS::Lambda::Permission IS its statement `Sid` — match on
  // it FIRST so the correct statement is read back unambiguously. This matters when one
  // function carries SEVERAL permissions that share Action + Principal: the CDK API
  // Gateway integration emits two (the deployment-stage permission and a parallel
  // `test-invoke-stage` one), both `lambda:InvokeFunction` for `apigateway.amazonaws.com`,
  // differing ONLY in SourceArn. The Action+Principal fallback below returns the FIRST
  // match for BOTH, so the deployment-stage permission read back the `test-invoke-stage`
  // SourceArn — a false `declared` drift on every clean deploy.
  const byId = physicalId ? stmts.find((s) => s.Sid === physicalId) : undefined;
  // best-effort fallback match by Action + Principal against the declared permission
  // (a permission whose physical id is not the live Sid, or a renamed statement).
  const want = { action: str(declared.Action), principal: str(declared.Principal) };
  const m =
    byId ??
    stmts.find(
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
  // NOTE: NetworkInterfaceId is NOT projected — it is not a declarable CFn property of
  // AWS::EC2::EIP (verified against the registry schema: the property set has no
  // NetworkInterfaceId), so it is neither readOnly-stripped nor a known default. AWS
  // populates it for any EIP associated with an ENI, so projecting it false-flagged an
  // `undeclared` drift on EVERY associated EIP on the first check.
  if (str(addr.PublicIpv4Pool)) model.PublicIpv4Pool = addr.PublicIpv4Pool; // declarable; absent for AWS-pool EIPs (FP-safe)
  if (tags && tags.length > 0) model.Tags = tags;
  return model;
};

// AWS::EC2::NetworkAclEntry — Cloud Control has no read handler for this type
// (GetResource throws UnsupportedActionException), so every NACL entry was silently
// `skipped`: a NACL rule changed out of band (a CidrBlock widened, an action flipped
// allow->deny) was invisible. Read the parent NACL via EC2 DescribeNetworkAcls and pick
// the entry by its identity (RuleNumber + Egress — a NACL holds at most one entry per
// (RuleNumber, Egress) pair). The EC2 entry shape mirrors the CFn property shape, except
// Protocol comes back as a STRING ("6") while CFn declares it as an INTEGER (6) — coerce
// it to a number so a tcp/udp/icmp rule does not false-drift on a typed-vs-string Protocol.
// AWS::CloudWatch::AnomalyDetector — NON_PROVISIONABLE in the registry (no Cloud
// Control read handler), so every declared anomaly detector was a silent `skipped`
// read-gap (issue #461) despite being a standard CloudWatch pattern. The CFn physical
// id is an opaque generated id no CloudWatch API accepts, so identity comes from the
// DECLARED model. Two declaration styles exist (a nested SingleMetricAnomalyDetector /
// MetricMathAnomalyDetector, or the legacy top-level Namespace/MetricName/Stat/
// Dimensions); the live model is emitted in the SAME style the template used so the
// compare is shape-stable. Field mapping: the CW API spells the timezone
// `MetricTimezone` while CFn spells it `MetricTimeZone`; ExcludedTimeRanges come back
// as Date objects and are projected in the CFn Range pattern — the registry schema
// enforces `YYYY-MM-DDTHH:MM:SS` (zone-less UTC; a trailing `Z` is REJECTED at deploy,
// live-proven), so a full-ISO projection would false-flag every declared range
// (`desired="…T00:00:00" actual="…T00:00:00.000Z"`). Only projected when present
// (FP-safe: an unset Configuration stays absent on both sides).
const dimSetEqual = (a: unknown, b: unknown): boolean => {
  const norm = (v: unknown): string =>
    JSON.stringify(
      (Array.isArray(v) ? (v as { Name?: unknown; Value?: unknown }[]) : [])
        .map((d) => [str(d.Name) ?? '', str(d.Value) ?? ''])
        .sort()
    );
  return norm(a) === norm(b);
};
// CFn Range pattern: `YYYY-MM-DDTHH:MM:SS` in UTC (the schema rejects a zone suffix).
const cfnRangeTime = (v: unknown): unknown =>
  v instanceof Date ? v.toISOString().slice(0, 19) : v;
const readCloudWatchAnomalyDetector: OverrideReader = async ({ declared, region }) => {
  const singleDecl = declared.SingleMetricAnomalyDetector as Record<string, unknown> | undefined;
  const mathDecl = declared.MetricMathAnomalyDetector as Record<string, unknown> | undefined;
  const ns = str(singleDecl?.Namespace) ?? str(declared.Namespace);
  const metric = str(singleDecl?.MetricName) ?? str(declared.MetricName);
  const stat = str(singleDecl?.Stat) ?? str(declared.Stat);
  const dims = singleDecl?.Dimensions ?? declared.Dimensions;
  if (!mathDecl && (!ns || !metric || !stat)) return undefined; // unresolved identity -> skipped

  const c = new CloudWatchClient({ region, ...READ_RETRY });
  // Namespace/MetricName filters match only single-metric detectors. A math
  // detector MUST request AnomalyDetectorTypes=METRIC_MATH explicitly: the API
  // DEFAULTS to SINGLE_METRIC when the field is omitted, so an "unfiltered"
  // listing never returns math detectors — every metric-math detector then
  // false-reported "deleted out of band" on a fresh stack (live-caught; the
  // unit-test mock returned detectors regardless of the filter, masking it).
  const filters = mathDecl
    ? { AnomalyDetectorTypes: ['METRIC_MATH' as const] }
    : { Namespace: ns, MetricName: metric };
  const detectors: AnomalyDetector[] = [];
  let nextToken: string | undefined;
  do {
    const r = await c.send(
      new DescribeAnomalyDetectorsCommand({ ...filters, NextToken: nextToken })
    );
    detectors.push(...(r.AnomalyDetectors ?? []));
    nextToken = r.NextToken;
  } while (nextToken);

  const found = detectors.find((d) => {
    if (mathDecl) {
      const q = d.MetricMathAnomalyDetector?.MetricDataQueries;
      const declQ = mathDecl.MetricDataQueries;
      const ids = (v: unknown): string =>
        JSON.stringify(
          (Array.isArray(v) ? (v as { Id?: unknown }[]) : []).map((x) => str(x.Id) ?? '').sort()
        );
      return q !== undefined && ids(q) === ids(declQ);
    }
    const s = d.SingleMetricAnomalyDetector;
    const dNs = s?.Namespace ?? d.Namespace;
    const dMetric = s?.MetricName ?? d.MetricName;
    const dStat = s?.Stat ?? d.Stat;
    const dDims = s?.Dimensions ?? d.Dimensions;
    return dNs === ns && dMetric === metric && dStat === stat && dimSetEqual(dDims, dims ?? []);
  });
  if (!found) throw new ResourceGoneError(`AnomalyDetector ${ns ?? 'math'}/${metric ?? ''} absent`);

  const model: Record<string, unknown> = {};
  if (mathDecl) {
    model.MetricMathAnomalyDetector = found.MetricMathAnomalyDetector;
  } else if (singleDecl) {
    const s = found.SingleMetricAnomalyDetector;
    model.SingleMetricAnomalyDetector = {
      // AccountId is projected ONLY when the template declares it (cross-account
      // monitoring): the API echoes the OWN account id on every detector, which would
      // otherwise surface as undeclared first-run noise.
      ...(str(singleDecl.AccountId) !== undefined &&
        str(s?.AccountId) !== undefined && { AccountId: s?.AccountId }),
      Namespace: s?.Namespace ?? found.Namespace,
      MetricName: s?.MetricName ?? found.MetricName,
      Stat: s?.Stat ?? found.Stat,
      ...((s?.Dimensions ?? found.Dimensions ?? []).length > 0 && {
        Dimensions: s?.Dimensions ?? found.Dimensions,
      }),
    };
  } else {
    model.Namespace = found.SingleMetricAnomalyDetector?.Namespace ?? found.Namespace;
    model.MetricName = found.SingleMetricAnomalyDetector?.MetricName ?? found.MetricName;
    model.Stat = found.SingleMetricAnomalyDetector?.Stat ?? found.Stat;
    const legacyDims = found.SingleMetricAnomalyDetector?.Dimensions ?? found.Dimensions;
    if ((legacyDims ?? []).length > 0) model.Dimensions = legacyDims;
  }
  const cfg = found.Configuration;
  if (cfg !== undefined) {
    const out: Record<string, unknown> = {};
    if (str(cfg.MetricTimezone)) out.MetricTimeZone = cfg.MetricTimezone;
    if ((cfg.ExcludedTimeRanges ?? []).length > 0)
      out.ExcludedTimeRanges = (cfg.ExcludedTimeRanges ?? []).map((rng) => ({
        StartTime: cfnRangeTime(rng.StartTime),
        EndTime: cfnRangeTime(rng.EndTime),
      }));
    if (Object.keys(out).length > 0) model.Configuration = out;
  }
  if (found.MetricCharacteristics !== undefined)
    model.MetricCharacteristics = found.MetricCharacteristics;
  return model;
};

// AWS::DLM::LifecyclePolicy — NON_PROVISIONABLE in the registry (no Cloud Control read
// handler; issue #468), so every Data Lifecycle Manager policy — a common EBS snapshot /
// AMI backup-schedule staple — came back a silent `skipped` read-gap. The CFn physical id
// IS the DLM policy id (`policy-0abc…`), which dlm:GetLifecyclePolicy accepts directly. The
// DLM API models the policy in the SAME PascalCase shape the CFn registry uses
// (PolicyDetails / Schedules / CreateRule / RetainRule / CrossRegionCopyRules / …), so the
// live PolicyDetails is emitted verbatim for the classifier (like the Glue family — a
// whole-object read). Two declaration styles exist: a full custom policy (declared
// PolicyDetails) and the default-policy shorthand (top-level CreateInterval / RetainInterval
// / CopyTags / …, which the API folds INTO PolicyDetails); the live model is emitted in the
// SAME style the template used so the compare is shape-stable. Tags are a `{k: v}` map on
// the API but a `[{Key,Value}]` list in CFn, so they are not projected here (the shape
// mismatch would false-drift; `aws:*` tag noise is handled elsewhere). A deleted policy
// throws ResourceNotFoundException → the router maps it to `deleted`.
export const DLM_DEFAULT_POLICY_SHORTHAND = [
  'CreateInterval',
  'RetainInterval',
  'CopyTags',
  'ExtendDeletion',
  'CrossRegionCopyTargets',
  'Exclusions',
] as const;
const readDlmLifecyclePolicy: OverrideReader = async ({ physicalId, declared, region }) => {
  const id = str(physicalId);
  if (!id) return undefined;
  const c = new DLMClient({ region, ...READ_RETRY });
  // Not-found (ResourceNotFoundException) propagates so the router maps a deleted policy
  // to `deleted` rather than an empty model.
  const p = (await c.send(new GetLifecyclePolicyCommand({ PolicyId: id }))).Policy;
  if (!p) throw new ResourceGoneError(`DLM LifecyclePolicy ${id} absent`);
  const model: Record<string, unknown> = {};
  if (str(p.Description) !== undefined) model.Description = p.Description;
  if (str(p.State) !== undefined) model.State = p.State;
  if (str(p.ExecutionRoleArn) !== undefined) model.ExecutionRoleArn = p.ExecutionRoleArn;
  const details = (p.PolicyDetails ?? {}) as Record<string, unknown>;
  // Emit in the template's style. The default-policy shorthand declares the schedule
  // knobs at the TOP level and no PolicyDetails; the API folds them into PolicyDetails, so
  // project just those keys back up. Every other case is a custom policy → PolicyDetails.
  const usesShorthand =
    declared.PolicyDetails === undefined &&
    DLM_DEFAULT_POLICY_SHORTHAND.some((k) => declared[k] !== undefined);
  if (usesShorthand) {
    for (const k of DLM_DEFAULT_POLICY_SHORTHAND)
      if (details[k] !== undefined) model[k] = details[k];
  } else if (Object.keys(details).length > 0) {
    model.PolicyDetails = details;
  }
  return model;
};

// AWS::DMS::Endpoint — NON_PROVISIONABLE in the registry (no Cloud Control read handler;
// issue #497), so every DMS endpoint — 2 of which every migration/CDC pipeline declares —
// was a silent `skipped` read-gap. Connection attributes people tweak in the console
// (ExtraConnectionAttributes, ServerName, Port, engine settings) were invisible. The CFn
// physical id (Ref → `Id`) IS the EndpointArn, which DMS DescribeEndpoints filters on via
// `endpoint-arn`; a bare identifier (older stacks / imports) filters on `endpoint-id`. The
// DMS API models the endpoint in the SAME PascalCase shape the CFn registry uses, so the
// CFn-declarable scalars are projected 1:1. The per-engine *Settings blobs
// (S3Settings/KinesisSettings/…) are NOT projected: the SDK returns them under DIFFERENT key
// casing than the CFn schema (e.g. CFn MongoDbSettings vs API MongoDbSettings sub-field
// drift) and AWS default-fills them, so a passthrough would false-flag; scalar coverage is
// the deliverable. Read-ONLY: a ModifyEndpoint writer is deferred to a follow-up (revert of
// connection settings needs per-engine care). A deleted endpoint surfaces as
// ResourceNotFoundException → the router maps it to `deleted`.
const readDmsEndpoint: OverrideReader = async ({ physicalId, region }) => {
  const id = str(physicalId);
  if (!id) return undefined;
  const c = new DatabaseMigrationServiceClient({ region, ...READ_RETRY });
  const filterName = id.startsWith('arn:') ? 'endpoint-arn' : 'endpoint-id';
  // ResourceNotFoundException propagates so a deleted endpoint maps to `deleted`.
  const r = await c.send(
    new DescribeEndpointsCommand({ Filters: [{ Name: filterName, Values: [id] }] })
  );
  const e = r.Endpoints?.[0];
  if (!e) throw new ResourceGoneError(`DMS Endpoint ${id} absent`);
  const model: Record<string, unknown> = {};
  if (str(e.EndpointIdentifier)) model.EndpointIdentifier = e.EndpointIdentifier;
  if (str(e.EndpointType)) model.EndpointType = e.EndpointType;
  if (str(e.EngineName)) model.EngineName = e.EngineName;
  if (str(e.Username)) model.Username = e.Username;
  if (str(e.ServerName)) model.ServerName = e.ServerName;
  if (typeof e.Port === 'number') model.Port = e.Port;
  if (str(e.DatabaseName)) model.DatabaseName = e.DatabaseName;
  if (str(e.ExtraConnectionAttributes))
    model.ExtraConnectionAttributes = e.ExtraConnectionAttributes;
  if (str(e.KmsKeyId)) model.KmsKeyId = e.KmsKeyId;
  if (str(e.CertificateArn)) model.CertificateArn = e.CertificateArn;
  if (str(e.SslMode)) model.SslMode = e.SslMode;
  return model;
};

// AWS::DMS::ReplicationSubnetGroup — NON_PROVISIONABLE (no Cloud Control read handler; issue
// #497), paired with the endpoints above in every migration pipeline. The CFn physical id
// (Ref → `Id`) IS the ReplicationSubnetGroupIdentifier, which DMS
// DescribeReplicationSubnetGroups filters on via `replication-subnet-group-id`. The API
// returns Subnets as a list of `{SubnetIdentifier}` objects, while CFn declares a flat
// `SubnetIds` string list — project the SubnetIdentifier values (SORTED, so a live-vs-declared
// order difference is not false drift; DMS does not preserve the declared order). Read-ONLY
// (ModifyReplicationSubnetGroup deferred). AWS lowercases the identifier, and CFn's Ref
// resolves to that lowercased form, so the identity round-trips.
const readDmsReplicationSubnetGroup: OverrideReader = async ({ physicalId, region }) => {
  const id = str(physicalId);
  if (!id) return undefined;
  const c = new DatabaseMigrationServiceClient({ region, ...READ_RETRY });
  const r = await c.send(
    new DescribeReplicationSubnetGroupsCommand({
      Filters: [{ Name: 'replication-subnet-group-id', Values: [id] }],
    })
  );
  const g = r.ReplicationSubnetGroups?.[0];
  if (!g) throw new ResourceGoneError(`DMS ReplicationSubnetGroup ${id} absent`);
  const model: Record<string, unknown> = {};
  if (str(g.ReplicationSubnetGroupIdentifier))
    model.ReplicationSubnetGroupIdentifier = g.ReplicationSubnetGroupIdentifier;
  if (str(g.ReplicationSubnetGroupDescription))
    model.ReplicationSubnetGroupDescription = g.ReplicationSubnetGroupDescription;
  const subnetIds = (g.Subnets ?? [])
    .map((s) => str(s.SubnetIdentifier))
    .filter((v): v is string => v !== undefined)
    .sort();
  if (subnetIds.length > 0) model.SubnetIds = subnetIds;
  return model;
};

// AWS::MediaConvert::Queue — NON_PROVISIONABLE (no Cloud Control read handler; issue #497), a
// video-pipeline staple whose `Status` (ACTIVE/PAUSED) is a classic console-toggled prop that
// was invisible. The CFn physical id (Ref → `Id`) IS the queue Name, which mc:GetQueue accepts
// directly. Project the CFn-declarable scalars (Name/Description/PricingPlan/Status). The
// computed/reserved fields (Arn/CreatedAt/LastUpdated/ConcurrentJobs/MaximumConcurrentFeeds/
// ReservationPlan/*JobsCount/ServiceOverrides/Type) are dropped — not user-declarable scalars,
// pure noise. Read-ONLY (UpdateQueue deferred). A deleted queue surfaces as
// NotFoundException → the router maps it to `deleted`.
const readMediaConvertQueue: OverrideReader = async ({ physicalId, region }) => {
  const name = str(physicalId);
  if (!name) return undefined;
  const c = new MediaConvertClient({ region, ...READ_RETRY });
  const q = (await c.send(new GetQueueCommand({ Name: name }))).Queue;
  if (!q) throw new ResourceGoneError(`MediaConvert Queue ${name} absent`);
  const model: Record<string, unknown> = {};
  if (str(q.Name)) model.Name = q.Name;
  if (str(q.Description)) model.Description = q.Description;
  if (str(q.PricingPlan)) model.PricingPlan = q.PricingPlan;
  if (str(q.Status)) model.Status = q.Status;
  return model;
};

// AWS::MediaConvert::JobTemplate — NON_PROVISIONABLE (no Cloud Control read handler; issue
// #497). The CFn physical id (Ref → `Id`) IS the template Name, which mc:GetJobTemplate accepts
// directly. Project the CFn-declarable props; `SettingsJson` is a large free-form JSON blob
// that CFn declares as an opaque object and the API returns as the structured `Settings` object
// — read it back FAITHFULLY (verbatim passthrough) so an out-of-band settings change surfaces.
// AccelerationSettings/HopDestinations/StatusUpdateInterval/Category/Queue/Priority mirror the
// CFn shape 1:1. Computed/managed fields (Arn/CreatedAt/LastUpdated/Type) are dropped. Read-ONLY
// (UpdateJobTemplate deferred). A deleted template surfaces as NotFoundException → `deleted`.
const readMediaConvertJobTemplate: OverrideReader = async ({ physicalId, region }) => {
  const name = str(physicalId);
  if (!name) return undefined;
  const c = new MediaConvertClient({ region, ...READ_RETRY });
  const t = (await c.send(new GetJobTemplateCommand({ Name: name }))).JobTemplate;
  if (!t) throw new ResourceGoneError(`MediaConvert JobTemplate ${name} absent`);
  const model: Record<string, unknown> = {};
  if (str(t.Name)) model.Name = t.Name;
  if (str(t.Description)) model.Description = t.Description;
  if (str(t.Category)) model.Category = t.Category;
  if (str(t.Queue)) model.Queue = t.Queue;
  if (typeof t.Priority === 'number') model.Priority = t.Priority;
  if (str(t.StatusUpdateInterval)) model.StatusUpdateInterval = t.StatusUpdateInterval;
  if (t.AccelerationSettings !== undefined) model.AccelerationSettings = t.AccelerationSettings;
  if (Array.isArray(t.HopDestinations) && t.HopDestinations.length > 0)
    model.HopDestinations = t.HopDestinations;
  // SettingsJson: CFn declares it as an opaque JSON object; the API returns the structured
  // `Settings` object. Faithful passthrough so a console-side transcode-settings change is
  // detectable.
  if (t.Settings !== undefined) model.SettingsJson = t.Settings;
  return model;
};

const readEc2NetworkAclEntry: OverrideReader = async ({ declared, region }) => {
  const naclId = str(declared.NetworkAclId);
  const ruleNumber = declared.RuleNumber;
  const egress = declared.Egress;
  // RuleNumber + Egress are required identity; an unresolved NetworkAclId (Symbol) or a
  // missing identity field -> skipped (fail-open, never a false read).
  if (!naclId || typeof ruleNumber !== 'number' || typeof egress !== 'boolean') return undefined;

  const c = new EC2Client({ region, ...READ_RETRY });
  // InvalidNetworkAclID.NotFound surfaces if the NACL itself was deleted out of band —
  // let it propagate so the router maps it to `deleted`.
  const r = await c.send(new DescribeNetworkAclsCommand({ NetworkAclIds: [naclId] }));
  const nacl = r.NetworkAcls?.[0];
  if (!nacl) return undefined;
  const entry = nacl.Entries?.find((e) => e.RuleNumber === ruleNumber && e.Egress === egress);
  if (!entry)
    throw new ResourceGoneError(
      `NetworkAclEntry rule=${ruleNumber} egress=${egress} absent from NACL ${naclId}`
    );

  const model: Record<string, unknown> = {
    NetworkAclId: naclId,
    RuleNumber: entry.RuleNumber,
    Egress: entry.Egress,
    RuleAction: entry.RuleAction,
  };
  // Protocol: EC2 returns a numeric STRING; CFn declares an integer.
  if (entry.Protocol !== undefined && entry.Protocol !== null)
    model.Protocol = Number(entry.Protocol);
  if (str(entry.CidrBlock)) model.CidrBlock = entry.CidrBlock;
  if (str(entry.Ipv6CidrBlock)) model.Ipv6CidrBlock = entry.Ipv6CidrBlock;
  // PortRange (TCP/UDP) and Icmp (ICMP/ICMPv6) are mutually exclusive and protocol-derived;
  // project each only when AWS returns it so a non-port / non-icmp rule stays absent (FP-safe).
  if (entry.PortRange) model.PortRange = { From: entry.PortRange.From, To: entry.PortRange.To };
  // EC2 names the ICMP field IcmpTypeCode; the CFn property is Icmp (same {Code, Type}).
  if (entry.IcmpTypeCode)
    model.Icmp = { Code: entry.IcmpTypeCode.Code, Type: entry.IcmpTypeCode.Type };
  return model;
};

// AWS::EC2::LaunchTemplate — Cloud Control reads the resource but its entire
// `LaunchTemplateData` body is writeOnly in the registry schema, so CC returns only
// ids/version numbers and the data was a permanent `readGap` (declared but
// unverifiable). Read the DEFAULT version's data via EC2
// DescribeLaunchTemplateVersions — the CFn physical id IS the LaunchTemplateId — and
// project `LaunchTemplateData` so cdkrd can finally detect drift on it (e.g. a new
// default version someone published out of band with a changed InstanceType / block
// device / metadata option). The EC2 `ResponseLaunchTemplateData` shape mirrors the
// CFn `LaunchTemplateData` shape (same PascalCase keys, same nesting) and AWS returns
// it FAITHFULLY — it does NOT inject defaults (a probe confirmed a minimal template
// reads back exactly as declared), so this is essentially a pass-through with low FP
// risk. `schema-strip.ts` exempts `LaunchTemplateData` from the writeOnly strip for
// this type (OVERRIDE_READABLE_WRITEONLY) so the projected value is actually compared.
// LaunchTemplateName (createOnly, readable) is projected too; VersionDescription and
// the top-level resource TagSpecifications stay writeOnly readGaps (not projected).
const readEc2LaunchTemplate: OverrideReader = async ({ physicalId, region }) => {
  const id = str(physicalId);
  if (!id) return undefined;
  const c = new EC2Client({ region, ...READ_RETRY });
  // Not-found (InvalidLaunchTemplateId.NotFound) propagates so the router maps a
  // deleted launch template to `deleted` rather than an empty model.
  const r = await c.send(
    new DescribeLaunchTemplateVersionsCommand({ LaunchTemplateId: id, Versions: ['$Default'] })
  );
  const v = r.LaunchTemplateVersions?.[0];
  if (!v) return undefined;
  const model: Record<string, unknown> = {};
  if (str(v.LaunchTemplateName)) model.LaunchTemplateName = v.LaunchTemplateName;
  if (v.LaunchTemplateData !== undefined)
    model.LaunchTemplateData = v.LaunchTemplateData as Record<string, unknown>;
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

// Route53 stores/returns special characters in a record name as octal escapes
// (`\ooo`): a wildcard `*.example.net` comes back as `\052.example.net.`, and space
// → `\040`, etc. The declared/template name uses the literal character, so a
// verbatim compare misreads the wildcard record as absent — throwing ResourceGoneError
// → a FALSE `deleted` finding (and leaving the record's returned Name as false
// declared drift). Unescape before matching AND in the returned model so both the
// existence check and the value compare see the literal form. See
// https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DomainNameFormat.html
const unescapeRoute53Name = (s: string): string =>
  s.replace(/\\(\d{3})/g, (_m, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)));

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
  const canon = (s: string): string => unescapeRoute53Name(s).replace(/\.$/, '').toLowerCase();
  // Match the declared SetIdentifier too: a simple record declares none and AWS
  // returns none (undefined === undefined), while a weighted/latency variant matches
  // its specific identifier instead of whichever sibling happened to come first.
  const declSetId = str(declared.SetIdentifier);
  const isOurNameType = (x: ResourceRecordSet): boolean =>
    x.Type === type && !!x.Name && canon(x.Name) === canon(name);
  const isExact = (x: ResourceRecordSet): boolean =>
    isOurNameType(x) && (x.SetIdentifier ?? undefined) === declSetId;
  // PAGINATE: a name+type with many SetIdentifier variants (weighted/latency/geo/failover/
  // multivalue), or a name that sorts past the default ~300-record page, can land the
  // declared record on a LATER page. Reading only page 1 would misread a PRESENT record as
  // absent and throw ResourceGoneError → a FALSE `deleted` (and revert would then recreate
  // an existing record). Page from the name+type cursor until the exact record is found.
  // Early-stop once our name+type's records are exhausted: Route53 returns records sorted,
  // so all variants of one name+type are contiguous — once we've seen them and a page has
  // none, the declared SetIdentifier is genuinely absent.
  let rec: ResourceRecordSet | undefined;
  let sawOurNameType = false;
  let startName: string | undefined = name;
  let startType: RRType | undefined = type as RRType;
  let startId: string | undefined;
  for (;;) {
    const r: ListResourceRecordSetsCommandOutput = await c.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        StartRecordName: startName,
        StartRecordType: startType,
        ...(startId !== undefined && { StartRecordIdentifier: startId }),
      })
    );
    const page = r.ResourceRecordSets ?? [];
    rec = page.find(isExact);
    if (rec) break;
    const pageHasOurNameType = page.some(isOurNameType);
    if (pageHasOurNameType) sawOurNameType = true;
    // exhausted our name+type's contiguous run, or the whole listing -> genuinely absent
    if ((sawOurNameType && !pageHasOurNameType) || !r.IsTruncated) break;
    startName = r.NextRecordName;
    startType = r.NextRecordType as RRType | undefined;
    startId = r.NextRecordIdentifier;
  }
  // The zone was listed successfully (every page) but the declared name+type(+SetIdentifier)
  // record is absent — it was deleted out of band. Distinct from the "couldn't resolve the
  // target" guard above (returns undefined → skipped): here we KNOW it is gone.
  if (!rec)
    throw new ResourceGoneError(
      `Route53 RecordSet ${name} ${type} absent from zone ${hostedZoneId}`
    );
  const model: Record<string, unknown> = {
    Name: alignTrailingDot(
      rec.Name === undefined ? undefined : unescapeRoute53Name(rec.Name),
      declared.Name
    ),
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
  // Geoproximity + CIDR routing-policy fields — the two newer routing variants, projected
  // away before so an out-of-band change to a geoproximity Bias/region or a CIDR
  // collection/location was invisible. Both objects exist ONLY on a record using that
  // routing policy (absent on a simple/weighted/latency/geo/failover record), so they add
  // no noise to the common case. Bias defaults to 0 when omitted — folded via
  // KNOWN_DEFAULT_PATHS so a record declaring only AWSRegion stays CLEAN.
  const geoProx = rec.GeoProximityLocation;
  if (geoProx)
    model.GeoProximityLocation = {
      ...(geoProx.AWSRegion !== undefined && { AWSRegion: geoProx.AWSRegion }),
      ...(geoProx.LocalZoneGroup !== undefined && { LocalZoneGroup: geoProx.LocalZoneGroup }),
      ...(geoProx.Coordinates !== undefined && {
        Coordinates: {
          ...(geoProx.Coordinates.Latitude !== undefined && {
            Latitude: geoProx.Coordinates.Latitude,
          }),
          ...(geoProx.Coordinates.Longitude !== undefined && {
            Longitude: geoProx.Coordinates.Longitude,
          }),
        },
      }),
      ...(geoProx.Bias !== undefined && { Bias: geoProx.Bias }),
    };
  const cidr = rec.CidrRoutingConfig;
  if (cidr)
    model.CidrRoutingConfig = {
      ...(cidr.CollectionId !== undefined && { CollectionId: cidr.CollectionId }),
      ...(cidr.LocationName !== undefined && { LocationName: cidr.LocationName }),
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

// AWS::Glue::Classifier — CC API GetResource throws UnsupportedActionException, so the
// classifier was silently `skipped` and any out-of-band change to it (a delimiter, a grok
// pattern, a JSON path) was invisible. Read via Glue GetClassifier. The CFn physical id is
// the classifier name; the live `Classifier` is a one-of union ({CsvClassifier |
// GrokClassifier | JsonClassifier | XMLClassifier}) that mirrors the CFn shape — project
// the present member, dropping the AWS-managed Version / CreationTime / LastUpdated fields
// (not CFn-declarable, pure noise).
// `Serde` is a CsvClassifier field GetClassifier returns as "None" by default but the CFn
// schema does NOT model (verified live — it surfaced as a bogus [Potential Drift] value); a
// user can never declare it, so projecting it would be a permanent undeclared false
// inventory. Dropped alongside the AWS-managed Version / CreationTime / LastUpdated.
const GLUE_CLASSIFIER_MANAGED = new Set(['Version', 'CreationTime', 'LastUpdated', 'Serde']);
const readGlueClassifier: OverrideReader = async ({ physicalId, declared, region }) => {
  const declMember = (declared.CsvClassifier ??
    declared.GrokClassifier ??
    declared.JsonClassifier ??
    declared.XMLClassifier) as Record<string, unknown> | undefined;
  const name = str(physicalId) ?? str(declMember?.Name);
  if (!name) return undefined;
  const c = new GlueClient({ region, ...READ_RETRY });
  const r = await c.send(new GetClassifierCommand({ Name: name }));
  const cl = r.Classifier;
  if (!cl) return undefined;
  const project = (o: object): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(o as Record<string, unknown>).filter(([k]) => !GLUE_CLASSIFIER_MANAGED.has(k))
    );
  const out: Record<string, unknown> = {};
  if (cl.CsvClassifier) out.CsvClassifier = project(cl.CsvClassifier);
  if (cl.GrokClassifier) out.GrokClassifier = project(cl.GrokClassifier);
  if (cl.JsonClassifier) out.JsonClassifier = project(cl.JsonClassifier);
  if (cl.XMLClassifier) out.XMLClassifier = project(cl.XMLClassifier);
  return out;
};

// AWS::Glue::Workflow — CC API GetResource throws UnsupportedActionException, so the
// workflow was silently `skipped` and an out-of-band change to its Description /
// DefaultRunProperties / MaxConcurrentRuns was invisible. Read via Glue GetWorkflow. The
// CFn physical id is the workflow name; project the CFn-modeled scalar/map props, dropping
// AWS-managed run/graph state (CreatedOn / LastModifiedOn / LastRun / Graph) and `Tags`
// (handled by the shared aws:* tag strip). MaxConcurrentRuns is a number CFn declares.
const readGlueWorkflow: OverrideReader = async ({ physicalId, declared, region }) => {
  const name = str(physicalId) ?? str(declared.Name);
  if (!name) return undefined;
  const c = new GlueClient({ region, ...READ_RETRY });
  const r = await c.send(new GetWorkflowCommand({ Name: name }));
  const w = r.Workflow;
  if (!w) return undefined;
  const out: Record<string, unknown> = { Name: w.Name };
  if (w.Description !== undefined) out.Description = w.Description;
  if (w.DefaultRunProperties !== undefined) out.DefaultRunProperties = w.DefaultRunProperties;
  if (w.MaxConcurrentRuns !== undefined) out.MaxConcurrentRuns = w.MaxConcurrentRuns;
  return out;
};

// AWS::Glue::Connection — CC API GetResource throws UnsupportedActionException, so the
// connection was silently `skipped` and an out-of-band change to its network/JDBC settings
// (ConnectionType, PhysicalConnectionRequirements [subnet/SG/AZ], ConnectionProperties,
// Description) was invisible — a security-relevant FN on a common ETL data-source resource.
// Read via Glue GetConnection with HidePassword:true so NO credential ever enters the
// baseline. Project the CFn `ConnectionInput` shape, dropping AWS-managed status/timestamps.
// SECRET note: any returned ConnectionProperties.*PASSWORD key is dropped (HidePassword
// returns the encrypted blob on some paths, and a secret must never land in the .cdkrd
// baseline). `SECRET_ID` is KEPT — it is a Secrets Manager ARN (config, not a secret), so
// an out-of-band repoint to a different secret stays detectable. The modern SECRET_ID /
// NETWORK pattern carries no inline password, so this is FP-clean there; a legacy
// inline-PASSWORD connection's password just stays a readGap. Read-ONLY (no SDK writer):
// closing the FN [detection] is the value; a revert that omitted an un-read credential
// could clear a JDBC password, so it is deferred.
const GLUE_CONNECTION_MANAGED = new Set([
  'CreationTime',
  'LastUpdatedTime',
  'LastUpdatedBy',
  'Status',
  'StatusReason',
  'LastConnectionValidationTime',
  'ConnectionSchemaVersion',
]);
const GLUE_CONNECTION_SECRET_KEYS = /PASSWORD/i;
const readGlueConnection: OverrideReader = async ({ physicalId, declared, region }) => {
  const declInput = declared.ConnectionInput as Record<string, unknown> | undefined;
  const name = str(physicalId) ?? str(declInput?.Name);
  if (!name) return undefined;
  const catalogId = str(declared.CatalogId);
  const c = new GlueClient({ region, ...READ_RETRY });
  const r = await c.send(
    new GetConnectionCommand({
      Name: name,
      HidePassword: true,
      ...(catalogId && { CatalogId: catalogId }),
    })
  );
  const conn = r.Connection;
  if (!conn) return undefined;
  const ci: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(conn)) {
    if (GLUE_CONNECTION_MANAGED.has(k) || k === 'Name') continue;
    ci[k] = v;
  }
  ci.Name = conn.Name;
  // never let a credential into the baseline, regardless of HidePassword behaviour
  if (ci.ConnectionProperties && typeof ci.ConnectionProperties === 'object') {
    ci.ConnectionProperties = Object.fromEntries(
      Object.entries(ci.ConnectionProperties as Record<string, unknown>).filter(
        ([k]) => !GLUE_CONNECTION_SECRET_KEYS.test(k)
      )
    );
  }
  const out: Record<string, unknown> = { ConnectionInput: ci };
  if (catalogId) out.CatalogId = catalogId;
  return out;
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
    // ApplyOnTransformedLogs (CFn AWS::Logs::MetricFilter prop) controls whether the
    // filter evaluates the TRANSFORMED log events instead of the originals — toggling it
    // out of band silently changes what the metric counts. It was omitted, so that change
    // was invisible. FP-safe: projected only when present; a live false is a top-level
    // undeclared value that isTrivialEmpty drops, so a never-set filter stays CLEAN and
    // only an out-of-band flip to true surfaces.
    ...(mf.applyOnTransformedLogs !== undefined && {
      ApplyOnTransformedLogs: mf.applyOnTransformedLogs,
    }),
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
      // Security-relevant source flags omitted before, so an out-of-band flip was
      // invisible: InsecureSsl disables TLS verification when cloning the source;
      // ReportBuildStatus posts build status back to the source provider. Both default
      // false and are projected only when present; a live false folds via isTrivialEmpty
      // (nested undeclared), so a never-set project stays CLEAN and only a flip to true
      // surfaces.
      ...(src.insecureSsl !== undefined && { InsecureSsl: src.insecureSsl }),
      ...(src.reportBuildStatus !== undefined && { ReportBuildStatus: src.reportBuildStatus }),
    };
  const art = p.artifacts;
  if (art)
    model.Artifacts = {
      ...(art.type !== undefined && { Type: art.type }),
      ...(art.location !== undefined && { Location: art.location }),
      // The remaining CFn-declarable S3-artifact fields. They were omitted, so for an
      // S3-artifacts project the template's declared Name / NamespaceType / Packaging /
      // Path / ArtifactIdentifier had NO live counterpart → a false declared drift
      // (actual=undefined), live-caught here. AWS echoes exactly the declared values, so
      // projecting them makes the declared compare match; absent (CODEPIPELINE/NO_ARTIFACTS)
      // → skipped, so no new noise. OverrideArtifactName is a boolean that folds via
      // isTrivialEmpty when false.
      ...(art.name !== undefined && { Name: art.name }),
      ...(art.namespaceType !== undefined && { NamespaceType: art.namespaceType }),
      ...(art.packaging !== undefined && { Packaging: art.packaging }),
      ...(art.path !== undefined && { Path: art.path }),
      ...(art.artifactIdentifier !== undefined && { ArtifactIdentifier: art.artifactIdentifier }),
      ...(art.overrideArtifactName !== undefined && {
        OverrideArtifactName: art.overrideArtifactName,
      }),
      // EncryptionDisabled turns OFF artifact encryption (security-relevant); omitted
      // before, so disabling encryption out of band was undetectable. Same FP-safe shape
      // as S3Logs.EncryptionDisabled below: a live false folds via isTrivialEmpty, true
      // surfaces.
      ...(art.encryptionDisabled !== undefined && { EncryptionDisabled: art.encryptionDisabled }),
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
  // ResourceAccessRole — the role CodeBuild assumes for batch builds / report groups;
  // absent unless set, so no noise. FileSystemLocations — EFS mounts into the build
  // (Identifier/Type/Location/MountPoint/MountOptions are all USER-specified, no server
  // default), absent unless the project mounts a file system. Both were omitted, so an
  // out-of-band change was invisible. (secondarySources / secondaryArtifacts /
  // buildBatchConfig / autoRetryLimit are deliberately NOT projected yet: the read shapes
  // diverge from the declared CFn shapes [secondaryArtifacts reads as BuildArtifacts —
  // missing Type/Name/NamespaceType/Packaging], carry server defaults [autoRetryLimit=0,
  // batch nested defaults], or are order-sensitive arrays — each needs its own FP-safe
  // handling, added when a real gap surfaces per the "widen coverage as gaps surface" rule.)
  if (p.resourceAccessRole !== undefined) model.ResourceAccessRole = p.resourceAccessRole;
  if (p.fileSystemLocations !== undefined && p.fileSystemLocations.length > 0)
    model.FileSystemLocations = p.fileSystemLocations.map((f) => ({
      ...(f.type !== undefined && { Type: f.type }),
      ...(f.location !== undefined && { Location: f.location }),
      ...(f.mountPoint !== undefined && { MountPoint: f.mountPoint }),
      ...(f.identifier !== undefined && { Identifier: f.identifier }),
      ...(f.mountOptions !== undefined && { MountOptions: f.mountOptions }),
    }));
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

// AWS::ServiceDiscovery::HttpNamespace / ::PrivateDnsNamespace / ::PublicDnsNamespace —
// the whole ServiceDiscovery family is a CC read gap (GetResource UnsupportedActionException,
// confirmed live). Read via Cloud Map GetNamespace — the CFn physical id IS the namespace
// Id (ns-xxxx). Project the CFn-modeled Name / Description AND the readOnly `Arn` / `Id`:
// Arn and Id are schema-stripped from the COMPARISON (so they never false-flag) but kept in
// `liveAttrs`, which is what an `Fn::GetAtt [<ns>, Arn]` resolves against. An ECS Service's
// `ServiceConnectConfiguration.Namespace` is declared as that GetAtt (for ANY namespace
// type), so without the namespace's Arn in liveAttrs the whole ServiceConnect config
// resolves to UNRESOLVED and its drift is never detected. (ServiceCount / CreateDate /
// Properties / a DNS namespace's Vpc stay readGaps — not projected.)
const readServiceDiscoveryNamespace: OverrideReader = async ({ physicalId, region }) => {
  const id = str(physicalId);
  if (!id) return undefined;
  const c = new ServiceDiscoveryClient({ region, ...READ_RETRY });
  const r = await c.send(new GetNamespaceCommand({ Id: id }));
  const ns = r.Namespace;
  if (!ns) return undefined;
  const model: Record<string, unknown> = {};
  if (ns.Name !== undefined) model.Name = ns.Name;
  if (ns.Description !== undefined) model.Description = ns.Description;
  if (ns.Arn !== undefined) model.Arn = ns.Arn; // readOnly: stripped from compare, kept for GetAtt
  if (ns.Id !== undefined) model.Id = ns.Id; // readOnly: ditto (a GetAtt [ns, Id] consumer)
  return model;
};

// AWS::ServiceDiscovery::Service — same CC read gap. Read via Cloud Map GetService;
// the CFn physical id IS the service Id (srv-xxxx). Project the CFn-modeled props,
// mapping the SDK shapes back to CFn PascalCase. DnsConfig.NamespaceId is a
// deprecated/read-only echo, deliberately not projected (a service in an HTTP
// namespace has no DnsConfig at all). HealthCheck* are projected only when present
// so an HTTP service stays CLEAN. Id / Arn / InstanceCount / CreateDate are noise.
const readServiceDiscoveryService: OverrideReader = async ({ physicalId, region }) => {
  const id = str(physicalId);
  if (!id) return undefined;
  const c = new ServiceDiscoveryClient({ region, ...READ_RETRY });
  const r = await c.send(new GetServiceCommand({ Id: id }));
  const s = r.Service;
  if (!s) return undefined;
  const model: Record<string, unknown> = {};
  if (s.Name !== undefined) model.Name = s.Name;
  if (s.Description !== undefined) model.Description = s.Description;
  if (s.NamespaceId !== undefined) model.NamespaceId = s.NamespaceId;
  if (s.Type !== undefined) model.Type = s.Type;
  if (s.DnsConfig)
    model.DnsConfig = {
      ...(s.DnsConfig.RoutingPolicy !== undefined && { RoutingPolicy: s.DnsConfig.RoutingPolicy }),
      ...(s.DnsConfig.DnsRecords !== undefined && {
        DnsRecords: s.DnsConfig.DnsRecords.map((d) => ({ Type: d.Type, TTL: d.TTL })),
      }),
    };
  if (s.HealthCheckConfig)
    model.HealthCheckConfig = {
      ...(s.HealthCheckConfig.Type !== undefined && { Type: s.HealthCheckConfig.Type }),
      ...(s.HealthCheckConfig.ResourcePath !== undefined && {
        ResourcePath: s.HealthCheckConfig.ResourcePath,
      }),
      ...(s.HealthCheckConfig.FailureThreshold !== undefined && {
        FailureThreshold: s.HealthCheckConfig.FailureThreshold,
      }),
    };
  if (s.HealthCheckCustomConfig)
    model.HealthCheckCustomConfig = {
      ...(s.HealthCheckCustomConfig.FailureThreshold !== undefined && {
        FailureThreshold: s.HealthCheckCustomConfig.FailureThreshold,
      }),
    };
  return model;
};

// AWS::DocDB::DBCluster — Cloud Control GetResource throws
// UnsupportedActionException (the DocumentDB family is a CC read gap, confirmed
// live; before this the cluster + its props were `skipped`). Read via DocDB
// DescribeDBClusters — the CFn physical id IS the DBClusterIdentifier. Project the
// CFn-modeled props, mapping the SDK names back to CFn (EnabledCloudwatchLogsExports
// -> EnableCloudwatchLogsExports, DBClusterParameterGroup -> DBClusterParameterGroupName,
// VpcSecurityGroups[].VpcSecurityGroupId -> VpcSecurityGroupIds). Endpoint / Status /
// ClusterCreateTime / DBClusterArn etc. are AWS-managed noise. AvailabilityZones is
// deliberately NOT projected — it is create-only and AWS may reorder it, an FP surface
// with no detection benefit (same rule as Subnet AZ). An absent cluster returns
// undefined (-> skipped; a genuinely deleted one throws DBClusterNotFoundFault -> deleted).
const readDocDbCluster: OverrideReader = async ({ physicalId, declared, region }) => {
  const id = str(physicalId) ?? str(declared.DBClusterIdentifier);
  if (!id) return undefined;
  const c = new DocDBClient({ region, ...READ_RETRY });
  const r = await c.send(new DescribeDBClustersCommand({ DBClusterIdentifier: id }));
  const cl = r.DBClusters?.[0];
  if (!cl) return undefined;
  const model: Record<string, unknown> = {};
  if (cl.DBClusterIdentifier !== undefined) model.DBClusterIdentifier = cl.DBClusterIdentifier;
  if (cl.BackupRetentionPeriod !== undefined)
    model.BackupRetentionPeriod = cl.BackupRetentionPeriod;
  if (cl.Port !== undefined) model.Port = cl.Port;
  if (cl.EngineVersion !== undefined) model.EngineVersion = cl.EngineVersion;
  if (cl.MasterUsername !== undefined) model.MasterUsername = cl.MasterUsername;
  if (cl.PreferredBackupWindow !== undefined)
    model.PreferredBackupWindow = cl.PreferredBackupWindow;
  if (cl.PreferredMaintenanceWindow !== undefined)
    model.PreferredMaintenanceWindow = cl.PreferredMaintenanceWindow;
  if (cl.StorageEncrypted !== undefined) model.StorageEncrypted = cl.StorageEncrypted;
  if (cl.KmsKeyId !== undefined) model.KmsKeyId = cl.KmsKeyId;
  if (cl.DeletionProtection !== undefined) model.DeletionProtection = cl.DeletionProtection;
  if (cl.EnabledCloudwatchLogsExports !== undefined)
    model.EnableCloudwatchLogsExports = cl.EnabledCloudwatchLogsExports;
  if (cl.DBClusterParameterGroup !== undefined)
    model.DBClusterParameterGroupName = cl.DBClusterParameterGroup;
  const sgs = (cl.VpcSecurityGroups ?? [])
    .map((g) => g.VpcSecurityGroupId)
    .filter((s): s is string => s !== undefined);
  if (sgs.length > 0) model.VpcSecurityGroupIds = sgs;
  return model;
};

// AWS::DocDB::DBInstance — same CC read gap. Read via DescribeDBInstances; the CFn
// physical id IS the DBInstanceIdentifier. Project the CFn-modeled props, mapping
// PerformanceInsightsEnabled -> EnablePerformanceInsights. AvailabilityZone is
// create-only and not projected. Endpoint / Status / InstanceCreateTime are noise.
const readDocDbInstance: OverrideReader = async ({ physicalId, declared, region }) => {
  const id = str(physicalId) ?? str(declared.DBInstanceIdentifier);
  if (!id) return undefined;
  const c = new DocDBClient({ region, ...READ_RETRY });
  const r = await c.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: id }));
  const inst = r.DBInstances?.[0];
  if (!inst) return undefined;
  const model: Record<string, unknown> = {};
  if (inst.DBInstanceIdentifier !== undefined)
    model.DBInstanceIdentifier = inst.DBInstanceIdentifier;
  if (inst.DBInstanceClass !== undefined) model.DBInstanceClass = inst.DBInstanceClass;
  if (inst.DBClusterIdentifier !== undefined) model.DBClusterIdentifier = inst.DBClusterIdentifier;
  if (inst.AutoMinorVersionUpgrade !== undefined)
    model.AutoMinorVersionUpgrade = inst.AutoMinorVersionUpgrade;
  if (inst.PreferredMaintenanceWindow !== undefined)
    model.PreferredMaintenanceWindow = inst.PreferredMaintenanceWindow;
  if (inst.CACertificateIdentifier !== undefined)
    model.CACertificateIdentifier = inst.CACertificateIdentifier;
  if (inst.PerformanceInsightsEnabled !== undefined)
    model.EnablePerformanceInsights = inst.PerformanceInsightsEnabled;
  return model;
};

// AWS::AppSync::ApiKey — Cloud Control GetResource throws UnsupportedActionException
// (NON_PROVISIONABLE; confirmed live), so a declared API key was `skipped`. Read via
// AppSync ListApiKeys. The CFn physical id is the ARN
// `arn:aws:appsync:<region>:<acct>:apis/<apiId>/apikeys/<keyId>` — parse BOTH ids from
// it (fall back to declared.ApiId). Project the CFn-modeled props: ApiId, Description,
// Expires (epoch seconds). Description is omitted when AWS returns none/"" so a
// no-description key stays CLEAN; Expires is undeclared in the common auto-key case
// (-> recorded, not a declared FP).
const readAppSyncApiKey: OverrideReader = async ({ physicalId, declared, region }) => {
  const m = /apis\/([^/]+)\/apikeys\/([^/]+)/.exec(str(physicalId) ?? '');
  const apiId = m?.[1] ?? str(declared.ApiId);
  const keyId = m?.[2];
  if (!apiId) return undefined;
  const c = new AppSyncClient({ region, ...READ_RETRY });
  const keys = (await c.send(new ListApiKeysCommand({ apiId }))).apiKeys ?? [];
  const k = keyId ? keys.find((x) => x.id === keyId) : keys[0];
  if (!k) return undefined; // key deleted out of band -> router maps undefined to skipped
  const model: Record<string, unknown> = { ApiId: apiId };
  if (k.description !== undefined && k.description !== '') model.Description = k.description;
  if (k.expires !== undefined) model.Expires = k.expires;
  return model;
};

// AWS::Cognito::IdentityPool — Cloud Control reads every property EXCEPT the three
// writeOnly ones (CognitoEvents / PushSync / CognitoStreams), so an out-of-band
// "Cognito Events" Sync trigger (a Lambda wired to the pool) is a silent read-gap that
// `check` cannot see. CC has no GetResource gap for the base model, so read the base via
// CC unchanged (low FP risk — identical to the default path) and ENRICH only with
// CognitoEvents from the (deprecated but live) cognito-sync API. PushSync/CognitoStreams
// stay writeOnly readGaps — they are not projected, so they can never false-positive.
// (CognitoEvents is exempted from the writeOnly strip via OVERRIDE_READABLE_WRITEONLY so
// the projected value is actually compared.)
const readCognitoIdentityPool: OverrideReader = async ({ physicalId, region }) => {
  const id = str(physicalId);
  if (!id) return undefined;
  const cc = new CloudControlClient({ region, ...READ_RETRY });
  // A deleted pool throws ResourceNotFound here, which the router maps to `deleted`.
  const g = await cc.send(
    new GetResourceCommand({ TypeName: 'AWS::Cognito::IdentityPool', Identifier: id })
  );
  const model = JSON.parse(g.ResourceDescription?.Properties ?? '{}') as Record<string, unknown>;
  try {
    const ev = await new CognitoSyncClient({ region, ...READ_RETRY }).send(
      new GetCognitoEventsCommand({ IdentityPoolId: id })
    );
    // Only project a NON-EMPTY event map: a pool with no Sync trigger reads back `{}`,
    // which must stay absent (declared) so a clean pool never reports false drift.
    if (ev.Events && Object.keys(ev.Events).length > 0) model.CognitoEvents = ev.Events;
  } catch {
    /* cognito-sync unavailable/disabled in the region -> leave CognitoEvents a readGap */
  }
  return model;
};

// The SES inbound receipt-rule family (ReceiptRuleSet / ReceiptRule / ReceiptFilter)
// has NO Cloud Control handlers (GetResource throws UnsupportedActionException), so each
// was silently `skipped` — zero drift coverage. Read them via the SES v1 API. NOTE: SES
// inbound receipt rules exist only in us-east-1 / us-west-2 / eu-west-1; in any other
// region these resources cannot exist, so the override naturally reads not-found there.

// AWS::SES::ReceiptRuleSet — the only declarable property is RuleSetName, and the CFn
// physical id IS the rule-set name. Read via SES DescribeReceiptRuleSet; project just
// RuleSetName (Metadata.Name). A deleted set throws RuleSetDoesNotExistException →
// mapped to `deleted` by the router.
const readSesReceiptRuleSet: OverrideReader = async ({ physicalId, declared, region }) => {
  const name = str(physicalId) ?? str(declared.RuleSetName);
  if (!name) return undefined;
  const c = new SESClient({ region, ...READ_RETRY });
  const r = await c.send(new DescribeReceiptRuleSetCommand({ RuleSetName: name }));
  const liveName = str(r.Metadata?.Name);
  if (!liveName) return undefined;
  return { RuleSetName: liveName };
};

// AWS::SES::ReceiptRule — its CFn physical id is the bare rule name; the parent
// RuleSetName (createOnly) comes from the resolved declared property. Read via SES
// DescribeReceiptRule({ RuleSetName, RuleName }). The SDK `ReceiptRule` shape mirrors the
// CFn `Rule` shape 1:1 (same PascalCase keys, same Action union members
// S3Action/BounceAction/LambdaAction/SNSAction/StopAction/WorkmailAction/AddHeaderAction/
// ConnectAction — verified against the registry schema), and Actions is an ordered list
// AWS preserves (actions execute sequentially), so it is projected verbatim. Project only
// present fields: the boolean defaults (Enabled / ScanEnabled = false) fold via
// isTrivialEmpty when undeclared, and TlsPolicy's "Optional" default is folded via
// KNOWN_DEFAULT_PATHS. The CFn `After` placement hint is not readable (DescribeReceiptRule
// never returns it) — a declared `After` stays an informational readGap (scalar). A
// deleted rule throws RuleDoesNotExistException → mapped to `deleted` by the router.
const readSesReceiptRule: OverrideReader = async ({ physicalId, declared, region }) => {
  const ruleSetName = str(declared.RuleSetName);
  const declRule = declared.Rule as Record<string, unknown> | undefined;
  const ruleName = str(physicalId) ?? str(declRule?.Name);
  if (!ruleSetName || !ruleName) return undefined;
  const c = new SESClient({ region, ...READ_RETRY });
  const r = await c.send(
    new DescribeReceiptRuleCommand({ RuleSetName: ruleSetName, RuleName: ruleName })
  );
  const live = r.Rule;
  if (!live) return undefined;
  const rule: Record<string, unknown> = { Name: live.Name };
  const copy = <K extends keyof ReceiptRule>(k: K): void => {
    if (live[k] !== undefined) rule[k] = live[k];
  };
  copy('Enabled');
  copy('TlsPolicy');
  copy('ScanEnabled');
  if (live.Recipients && live.Recipients.length > 0) rule.Recipients = live.Recipients;
  if (live.Actions && live.Actions.length > 0) rule.Actions = live.Actions;
  return { RuleSetName: ruleSetName, Rule: rule };
};

// AWS::SES::ReceiptFilter — there is no single-get API, so read the whole list via SES
// ListReceiptFilters and pick the entry by name (the CFn physical id is the filter name;
// declared Filter.Name is the fallback). Project the CFn `Filter` shape ({ Name, IpFilter:
// { Policy, Cidr } }) verbatim — the SDK ReceiptFilter mirrors it 1:1. The container list
// is always readable, so an absent named filter means it was deleted out of band →
// ResourceGoneError (mapped to `deleted`).
const readSesReceiptFilter: OverrideReader = async ({ physicalId, declared, region }) => {
  const declFilter = declared.Filter as Record<string, unknown> | undefined;
  const name = str(physicalId) ?? str(declFilter?.Name);
  if (!name) return undefined;
  const c = new SESClient({ region, ...READ_RETRY });
  const r = await c.send(new ListReceiptFiltersCommand({}));
  const f = (r.Filters ?? []).find((x) => x.Name === name);
  if (!f)
    throw new ResourceGoneError(`SES ReceiptFilter ${name} absent from the account's filter list`);
  const ipFilter = f.IpFilter;
  return {
    Filter: {
      Name: f.Name,
      ...(ipFilter && {
        IpFilter: {
          ...(ipFilter.Policy !== undefined && { Policy: ipFilter.Policy }),
          ...(ipFilter.Cidr !== undefined && { Cidr: ipFilter.Cidr }),
        },
      }),
    },
  };
};

export const SDK_OVERRIDES: Record<string, OverrideReader> = {
  'AWS::SES::ReceiptRuleSet': readSesReceiptRuleSet,
  'AWS::SES::ReceiptRule': readSesReceiptRule,
  'AWS::SES::ReceiptFilter': readSesReceiptFilter,
  'AWS::Cognito::IdentityPool': readCognitoIdentityPool,
  'AWS::AppSync::ApiKey': readAppSyncApiKey,
  'AWS::ServiceDiscovery::HttpNamespace': readServiceDiscoveryNamespace,
  'AWS::ServiceDiscovery::PrivateDnsNamespace': readServiceDiscoveryNamespace,
  'AWS::ServiceDiscovery::PublicDnsNamespace': readServiceDiscoveryNamespace,
  'AWS::ServiceDiscovery::Service': readServiceDiscoveryService,
  'AWS::DocDB::DBCluster': readDocDbCluster,
  'AWS::DocDB::DBInstance': readDocDbInstance,
  'AWS::CodeBuild::Project': readCodeBuildProject,
  'AWS::S3::BucketPolicy': readS3BucketPolicy,
  'AWS::SNS::TopicPolicy': readSnsTopicPolicy,
  'AWS::SQS::QueuePolicy': readSqsQueuePolicy,
  'AWS::IAM::Policy': readIamPolicy,
  'AWS::IAM::ManagedPolicy': readIamManagedPolicy,
  'AWS::Lambda::Permission': readLambdaPermission,
  'AWS::Budgets::Budget': readBudget,
  'AWS::EC2::EIP': readEc2Eip,
  'AWS::EC2::LaunchTemplate': readEc2LaunchTemplate,
  'AWS::EC2::NetworkAclEntry': readEc2NetworkAclEntry,
  'AWS::CloudWatch::AnomalyDetector': readCloudWatchAnomalyDetector,
  'AWS::DLM::LifecyclePolicy': readDlmLifecyclePolicy,
  'AWS::DMS::Endpoint': readDmsEndpoint,
  'AWS::DMS::ReplicationSubnetGroup': readDmsReplicationSubnetGroup,
  'AWS::MediaConvert::Queue': readMediaConvertQueue,
  'AWS::MediaConvert::JobTemplate': readMediaConvertJobTemplate,
  'AWS::Route53::RecordSet': readRoute53RecordSet,
  'AWS::Glue::Table': readGlueTable,
  'AWS::Glue::Classifier': readGlueClassifier,
  'AWS::Glue::Workflow': readGlueWorkflow,
  'AWS::Glue::Connection': readGlueConnection,
  'AWS::Logs::MetricFilter': readMetricFilter,
  'AWS::Scheduler::Schedule': readSchedulerSchedule,
};

// ---------------------------------------------------------------------------
// SDK supplements (SDK_SUPPLEMENTS)
//
// Unlike SDK_OVERRIDES (which REPLACE the Cloud Control read for a CC-gap type),
// a supplement runs AFTER a successful CC GetResource and shallow-merges a few
// EXTRA top-level fields onto the CC live model. The motivating case: a property
// the CFn registry marks `writeOnlyProperties` is never returned by Cloud Control
// (CC only echoes readable props), so the classify pipeline strips it from BOTH
// sides and an out-of-band change to it is silently invisible — even though a
// plain SDK Describe/Get API CAN read the value back. The supplement fetches just
// those values; `schema-strip.ts` exempts the same props from the writeOnly strip
// (OVERRIDE_READABLE_WRITEONLY) so they are actually compared.
//
// A supplement returns ONLY the extra keys (or undefined / {} when it has nothing
// to add). It must be FP-safe: project a key only when AWS actually returns it, so
// an unset optional prop stays absent on both sides rather than false-flagging.
export type SupplementReader = (ctx: OverrideCtx) => Promise<Record<string, unknown> | undefined>;

// AWS::SSM::Parameter — `Description`/`AllowedPattern`/`Tier` (and `Policies`) are
// writeOnly in the registry schema, so Cloud Control returns only Type/Value/
// DataType/Name and a console edit to them was undetectable. Only SSM
// `DescribeParameters` returns these (GetParameter does NOT). Project `Description`
// and `AllowedPattern` (returned ONLY when explicitly set, so an unset value stays
// absent on both sides — FP-safe) and `Tier` (always present; AWS auto-assigns
// "Standard" when undeclared, folded via KNOWN_DEFAULTS, and resolves a requested
// "Intelligent-Tiering" to the actual Standard/Advanced tier, folded by the
// INTELLIGENT_TIERING equivalence in classify — declared "Intelligent-Tiering"
// matches a live Standard/Advanced, while a real Standard↔Advanced change still
// surfaces). `Policies` reads back as expanded policy objects with a runtime
// PolicyStatus (shape differs from the CFn JSON-string input), so it stays a
// writeOnly readGap.
const supplementSsmParameter: SupplementReader = async ({ physicalId, declared, region }) => {
  const name = str(declared.Name) ?? str(physicalId);
  if (!name) return undefined;
  const c = new SSMClient({ region, ...READ_RETRY });
  const r = await c.send(
    new DescribeParametersCommand({
      ParameterFilters: [{ Key: 'Name', Option: 'Equals', Values: [name] }],
    })
  );
  const p = r.Parameters?.[0];
  const extra: Record<string, unknown> = {};
  const desc = str(p?.Description);
  if (desc !== undefined) extra.Description = desc;
  const pattern = str(p?.AllowedPattern);
  if (pattern !== undefined) extra.AllowedPattern = pattern;
  const tier = str(p?.Tier);
  if (tier !== undefined) extra.Tier = tier;
  return Object.keys(extra).length > 0 ? extra : undefined;
};

// NOTE — AWS::Cognito::UserPool `EnabledMfas` (writeOnly; CC echoes MfaConfiguration
// but never the enabled-method list) was evaluated as a supplement and DEFERRED:
// it cannot be reliably reconstructed from the read APIs. GetUserPoolMfaConfig keeps
// returning the full `SmsMfaConfiguration` block (the SNS caller config persists at
// the pool level) even after SMS is no longer an enabled MFA factor — live-proven
// (states "SMS+TOTP" and "TOTP-only" returned an identical SmsMfaConfiguration). So
// presence-based SMS detection would both miss an SMS removal (FN) and false-flag a
// pool that configures SMS for verification only (FP). describe-user-pool omits
// EnabledMfas too. Deferred until a reliable per-factor enabled signal exists.

// AWS::ElastiCache::ReplicationGroup — `PreferredMaintenanceWindow`,
// `NotificationTopicArn` and `EngineVersion` are writeOnly on the RG in the registry
// schema, so Cloud Control echoes the RG's other props but NEVER these three; an
// out-of-band change to the maintenance window or the notification topic was
// invisible. They are not stored on the RG object — they live on its MEMBER cache
// clusters — so read MemberClusters[0] via DescribeCacheClusters and project them
// VERBATIM (live-proven: "sun:05:00-sun:06:00" / the topic ARN / "7.1.0" read back
// exactly as set). `NotificationConfiguration.TopicArn` maps to the CFn
// `NotificationTopicArn`; only project it when a topic is configured (FP-safe).
// EngineVersion carries the usual ElastiCache prefix quirk (declared "7.1" reads
// "7.1.0"), folded by VERSION_PREFIX_PATHS. PreferredMaintenanceWindow is always
// present (AWS auto-assigns one when undeclared) — when undeclared it surfaces as an
// undeclared/recorded value, not drift; when declared it is compared verbatim.
const supplementElastiCacheReplicationGroup: SupplementReader = async ({ physicalId, region }) => {
  const id = str(physicalId);
  if (!id) return undefined;
  const c = new ElastiCacheClient({ region, ...READ_RETRY });
  const rg = await c.send(new DescribeReplicationGroupsCommand({ ReplicationGroupId: id }));
  const member = firstStr(rg.ReplicationGroups?.[0]?.MemberClusters);
  if (!member) return undefined;
  const cc = await c.send(
    new DescribeCacheClustersCommand({ CacheClusterId: member, ShowCacheNodeInfo: false })
  );
  const cluster = cc.CacheClusters?.[0];
  if (!cluster) return undefined;
  const extra: Record<string, unknown> = {};
  const window = str(cluster.PreferredMaintenanceWindow);
  if (window !== undefined) extra.PreferredMaintenanceWindow = window;
  const topic = str(cluster.NotificationConfiguration?.TopicArn);
  if (topic !== undefined) extra.NotificationTopicArn = topic;
  const version = str(cluster.EngineVersion);
  if (version !== undefined) extra.EngineVersion = version;
  return Object.keys(extra).length > 0 ? extra : undefined;
};

// Recursively upper-case the first letter of every object key (the SDK returns the
// ECS ServiceConnect config in camelCase; the CFn `ServiceConnectConfiguration` shape
// is PascalCase). Verified to map the whole shape 1:1 — Enabled/Namespace/Services/
// PortName/DiscoveryName/ClientAliases/Port/DnsName/IngressPortOverride/Timeout/Tls/
// LogConfiguration all differ only by the leading-letter case (no acronym surprises).
function pascalKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(pascalKeysDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k.charAt(0).toUpperCase() + k.slice(1)] = pascalKeysDeep(val);
    }
    return out;
  }
  return v;
}

// AWS::ECS::Service — `ServiceConnectConfiguration` is writeOnly in the registry
// schema, so Cloud Control echoes the service's other props but NEVER the Service
// Connect config (it lives on the service's deployments). An out-of-band change to
// the Service Connect wiring (the namespace, a client alias / DNS name / port, or
// disabling it) was therefore invisible. Read it from the PRIMARY deployment via
// ecs:DescribeServices and PascalCase it to the CFn shape. The namespace reads back
// in the SAME form it was declared (declared ARN → reads ARN; declared name → reads
// name — live-proven), so no normalization is needed. AWS defaults a service's
// `DiscoveryName` to its `PortName` when undeclared, so drop a DiscoveryName that
// equals PortName (the implicit default) to stay FP-safe.
//
// `VolumeConfigurations` (managed EBS volumes attached at deploy) is ALSO writeOnly and
// ALSO on the PRIMARY deployment — projected the same way. AWS injects exactly ONE
// default into `ManagedEBSVolume`: `FilesystemType` = "xfs" (live-proven — volumeType /
// sizeInGiB / roleArn / encrypted / iops / throughput all read back verbatim or stay
// absent when undeclared), so dropping a FilesystemType that equals "xfs" keeps it
// FP-safe, mirroring the DiscoveryName fold.
const supplementEcsService: SupplementReader = async ({ physicalId, declared, region }) => {
  const serviceArn = str(physicalId);
  const cluster = str(declared.Cluster);
  if (!serviceArn || !cluster) return undefined;
  const c = new ECSClient({ region, ...READ_RETRY });
  const r = await c.send(new DescribeServicesCommand({ cluster, services: [serviceArn] }));
  const primary = r.services?.[0]?.deployments?.find((d) => d.status === 'PRIMARY');
  if (!primary) return undefined;
  const extra: Record<string, unknown> = {};

  const sc = primary.serviceConnectConfiguration;
  if (sc) {
    const config = pascalKeysDeep(sc) as Record<string, unknown>;
    const services = config.Services;
    if (Array.isArray(services)) {
      for (const s of services) {
        // AWS fills DiscoveryName with PortName when it is not declared — drop the
        // implicit default so a service that declares only PortName stays FP-clean.
        if (
          s &&
          typeof s === 'object' &&
          (s as Record<string, unknown>).DiscoveryName === (s as Record<string, unknown>).PortName
        ) {
          delete (s as Record<string, unknown>).DiscoveryName;
        }
      }
    }
    extra.ServiceConnectConfiguration = config;
  }

  const vols = primary.volumeConfigurations;
  if (Array.isArray(vols) && vols.length > 0) {
    const volumeConfigurations = pascalKeysDeep(vols) as Record<string, unknown>[];
    for (const v of volumeConfigurations) {
      const ebs = v?.ManagedEBSVolume as Record<string, unknown> | undefined;
      // FilesystemType defaults to "xfs" — drop the implicit default so a config that
      // does not declare it stays FP-clean (the only field AWS injects, live-proven).
      if (ebs && ebs.FilesystemType === 'xfs') delete ebs.FilesystemType;
    }
    extra.VolumeConfigurations = volumeConfigurations;
  }

  return Object.keys(extra).length > 0 ? extra : undefined;
};

// AWS::ElastiCache::User / AWS::MemoryDB::User — `AccessString` (the Redis/Valkey ACL:
// WHAT the user may do) is writeOnly in both registry schemas, so Cloud Control never
// returns it and an out-of-band ACL grant (e.g. adding +@write in the console) was
// silently invisible — a security-relevant FN (#482). Both plain DescribeUsers APIs
// return the live AccessString, so project it (always present on an active user;
// FP-safe: projected only when returned). NOTE the service CANONICALIZES the string on
// write (declared `on ~app:* +@read` reads back `on ~app:* -@all +@read`), so the
// declared compare goes through isAccessStringEqual (ACCESS_STRING_PATHS in noise.ts)
// instead of raw string equality. AuthenticationMode stays a writeOnly readGap: its
// read shape ({Type, PasswordCount}) differs from the CFn input ({Type, Passwords}).
const supplementElastiCacheUser: SupplementReader = async ({ physicalId, declared, region }) => {
  const userId = str(declared.UserId) ?? str(physicalId);
  if (!userId) return undefined;
  const c = new ElastiCacheClient({ region, ...READ_RETRY });
  const r = await c.send(new DescribeCacheUsersCommand({ UserId: userId }));
  const access = str(r.Users?.[0]?.AccessString);
  return access !== undefined ? { AccessString: access } : undefined;
};

const supplementMemoryDbUser: SupplementReader = async ({ physicalId, declared, region }) => {
  const userName = str(declared.UserName) ?? str(physicalId);
  if (!userName) return undefined;
  const c = new MemoryDBClient({ region, ...READ_RETRY });
  const r = await c.send(new DescribeMemoryDbUsersCommand({ UserName: userName }));
  const access = str(r.Users?.[0]?.AccessString);
  return access !== undefined ? { AccessString: access } : undefined;
};

// AWS::RedshiftServerless::Workgroup — ConfigParameters / SecurityGroupIds / SubnetIds are
// writeOnly in the registry schema and, unlike the hunt's harvested corpus suggested, the
// Cloud Control GetResource does NOT return them at the top level (they live only inside the
// read-only `Workgroup` echo attribute), so an out-of-band change to a declared value — e.g.
// a SecurityGroupIds swap (security-relevant) or a ConfigParameters flip — was a silent FN
// (#490). GetWorkgroup returns all three; project them (SDK camelCase -> CFn PascalCase) so
// the classify pipeline compares them (schema-strip OVERRIDE_READABLE_WRITEONLY exempts the
// same three from the writeOnly strip). ConfigParameters is the ~9-element resolved default
// set, folded to a ParameterKey-keyed subset by NAME_VALUE_SUBSET_PATHS; SecurityGroupIds /
// SubnetIds are id-like sets (reorder folded by canonicalizeIdArraysDeep). FP-safe: each key
// is projected only when GetWorkgroup actually returns it.
const supplementRedshiftServerlessWorkgroup: SupplementReader = async ({
  physicalId,
  declared,
  region,
}) => {
  const workgroupName = str(declared.WorkgroupName) ?? str(physicalId);
  if (!workgroupName) return undefined;
  const c = new RedshiftServerlessClient({ region, ...READ_RETRY });
  const r = await c.send(new GetWorkgroupCommand({ workgroupName }));
  const wg = r.workgroup;
  if (!wg) return undefined;
  const extra: Record<string, unknown> = {};
  if (Array.isArray(wg.configParameters)) {
    extra.ConfigParameters = wg.configParameters.map((p) => ({
      ParameterKey: p.parameterKey,
      ParameterValue: p.parameterValue,
    }));
  }
  if (Array.isArray(wg.securityGroupIds)) extra.SecurityGroupIds = wg.securityGroupIds;
  if (Array.isArray(wg.subnetIds)) extra.SubnetIds = wg.subnetIds;
  return Object.keys(extra).length > 0 ? extra : undefined;
};

export const SDK_SUPPLEMENTS: Record<string, SupplementReader> = {
  'AWS::SSM::Parameter': supplementSsmParameter,
  'AWS::ElastiCache::ReplicationGroup': supplementElastiCacheReplicationGroup,
  'AWS::ECS::Service': supplementEcsService,
  'AWS::ElastiCache::User': supplementElastiCacheUser,
  'AWS::MemoryDB::User': supplementMemoryDbUser,
  'AWS::RedshiftServerless::Workgroup': supplementRedshiftServerlessWorkgroup,
};

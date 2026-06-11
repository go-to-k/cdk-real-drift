// SDK-override readers for common CFn types that Cloud Control API cannot read
// (GetResource → UnsupportedActionException). Read logic mirrors cdkd's SDK
// providers, but keyed off the resolved DECLARED properties (Bucket / Topics /
// Queues / Roles / FunctionName / policy ARN) — NOT the CloudFormation physical
// id, because CFn assigns these policy-attachment resources physical ids that
// differ from the underlying target. Returns CFn-shaped properties for the
// classifier; undefined when the target can't be resolved/read (→ skipped).

import { BudgetsClient, DescribeBudgetCommand } from '@aws-sdk/client-budgets';
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
import { GetTopicAttributesCommand, SNSClient } from '@aws-sdk/client-sns';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

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
  const c = new S3Client({ region });
  const r = await c.send(new GetBucketPolicyCommand({ Bucket: bucket }));
  return { Bucket: bucket, PolicyDocument: parsePolicy(r.Policy) };
};

const readSnsTopicPolicy: OverrideReader = async ({ declared, region }) => {
  const topic = firstStr(declared.Topics);
  if (!topic) return undefined;
  const c = new SNSClient({ region });
  const r = await c.send(new GetTopicAttributesCommand({ TopicArn: topic }));
  return { Topics: declared.Topics, PolicyDocument: parsePolicy(r.Attributes?.Policy) };
};

const readSqsQueuePolicy: OverrideReader = async ({ declared, region }) => {
  const queue = firstStr(declared.Queues);
  if (!queue) return undefined;
  const c = new SQSClient({ region });
  const r = await c.send(
    new GetQueueAttributesCommand({ QueueUrl: queue, AttributeNames: ['Policy'] })
  );
  return { Queues: declared.Queues, PolicyDocument: parsePolicy(r.Attributes?.Policy) };
};

const readIamPolicy: OverrideReader = async ({ declared, region }) => {
  const name = str(declared.PolicyName);
  if (!name) return undefined;
  const c = new IAMClient({ region });
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
  const c = new IAMClient({ region });
  const p = (await c.send(new GetPolicyCommand({ PolicyArn: physicalId }))).Policy;
  if (!p) return undefined;
  const ver = (
    await c.send(
      new GetPolicyVersionCommand({ PolicyArn: physicalId, VersionId: p.DefaultVersionId })
    )
  ).PolicyVersion;
  return { PolicyDocument: parsePolicy(ver?.Document), Path: p.Path, Description: p.Description };
};

const readLambdaPermission: OverrideReader = async ({ declared, region }) => {
  const fn = str(declared.FunctionName);
  if (!fn) return undefined;
  const c = new LambdaClient({ region });
  let policy: unknown;
  try {
    policy = parsePolicy((await c.send(new LambdaGetPolicyCommand({ FunctionName: fn }))).Policy);
  } catch {
    return undefined;
  }
  const stmts = (policy as { Statement?: Array<Record<string, unknown>> })?.Statement ?? [];
  // best-effort match by Action + Principal against the declared permission
  const want = { action: str(declared.Action), principal: str(declared.Principal) };
  const m = stmts.find(
    (s) =>
      (!want.action || s.Action === want.action) &&
      (!want.principal || JSON.stringify(s.Principal).includes(String(want.principal)))
  );
  if (!m) return undefined;
  return { FunctionName: fn, Action: m.Action, Principal: declared.Principal };
};

const readBudget: OverrideReader = async ({ declared, accountId, region }) => {
  const budget = declared.Budget as Record<string, unknown> | undefined;
  const name = str(budget?.BudgetName);
  if (!name || !accountId) return undefined;
  const c = new BudgetsClient({ region });
  const r = await c.send(new DescribeBudgetCommand({ AccountId: accountId, BudgetName: name }));
  const b = r.Budget;
  if (!b) return undefined;
  return { Budget: { BudgetName: b.BudgetName, BudgetType: b.BudgetType, TimeUnit: b.TimeUnit } };
};

export const SDK_OVERRIDES: Record<string, OverrideReader> = {
  'AWS::S3::BucketPolicy': readS3BucketPolicy,
  'AWS::SNS::TopicPolicy': readSnsTopicPolicy,
  'AWS::SQS::QueuePolicy': readSqsQueuePolicy,
  'AWS::IAM::Policy': readIamPolicy,
  'AWS::IAM::ManagedPolicy': readIamManagedPolicy,
  'AWS::Lambda::Permission': readLambdaPermission,
  'AWS::Budgets::Budget': readBudget,
};

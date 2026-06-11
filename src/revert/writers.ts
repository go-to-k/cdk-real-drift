// Type-specific SDK writers for revert of Cloud-Control-unwritable types. Each
// reads the current model (reusing the override READER), applies the revert ops to
// reconstruct the DESIRED full value, then writes it back with the resource's own
// SDK. Covers the policy-document types (the common revert); the gnarlier CC-gap
// types (IAM ManagedPolicy versions, Lambda Permission add/remove, Budgets) stay
// not-revertable for now.
import {
  IAMClient,
  PutGroupPolicyCommand,
  PutRolePolicyCommand,
  PutUserPolicyCommand,
} from '@aws-sdk/client-iam';
import { DeleteBucketPolicyCommand, PutBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';
import { SetTopicAttributesCommand, SNSClient } from '@aws-sdk/client-sns';
import { SetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
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
  return applyOps(current, ops);
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

export const SDK_WRITERS: Record<string, SdkWriter> = {
  'AWS::S3::BucketPolicy': writeS3BucketPolicy,
  'AWS::SNS::TopicPolicy': writeSnsTopicPolicy,
  'AWS::SQS::QueuePolicy': writeSqsQueuePolicy,
  'AWS::IAM::Policy': writeIamPolicy,
};

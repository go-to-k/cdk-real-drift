// #1729: the inline-policy resource types (AWS::SQS::QueueInlinePolicy with a scalar
// `Queue` URL, AWS::SNS::TopicInlinePolicy with a scalar `TopicArn`) declare the SAME
// live policy surface as the standalone QueuePolicy/TopicPolicy types, so the #835
// child enumerators' declared-sibling suppression must recognize them too — before
// this fix, a stack declaring its policy inline first-ran an added-tier
// "created out of band" FP on every check (live-found 2026-08-09, t1pack-hunt).
import {
  GetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
  SNSClient,
} from '@aws-sdk/client-sns';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vite-plus/test';
import { UNRESOLVED } from '../src/normalize/intrinsic-resolver.js';
import {
  enumerateSnsTopicChildren,
  enumerateSqsQueueChildren,
  type EnumeratorContext,
} from '../src/read/child-enumerators.js';

const QURL = 'https://sqs.us-east-1.amazonaws.com/111122223333/my-queue';
const TOPIC_ARN = 'arn:aws:sns:us-east-1:111122223333:my-topic';

const queuePolicy = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'AllowSns',
      Effect: 'Allow',
      Principal: { Service: 'sns.amazonaws.com' },
      Action: 'sqs:SendMessage',
      Resource: 'arn:aws:sqs:us-east-1:111122223333:my-queue',
    },
  ],
});
const topicPolicy = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'AllowEvents',
      Effect: 'Allow',
      Principal: { Service: 'events.amazonaws.com' },
      Action: 'sns:Publish',
      Resource: TOPIC_ARN,
    },
  ],
});

const sqsCtx = (resources: unknown[]) =>
  ({
    parent: { physicalId: QURL, logicalId: 'Queue' },
    desired: { resources },
    region: 'us-east-1',
  }) as unknown as EnumeratorContext;

const snsCtx = (resources: unknown[]) =>
  ({
    parent: { physicalId: TOPIC_ARN, logicalId: 'Topic' },
    desired: { resources, ctx: { liveAttrs: {} } },
    region: 'us-east-1',
  }) as unknown as EnumeratorContext;

describe('inline-policy twins suppress the added policy finding (#1729)', () => {
  it('SQS: a declared QueueInlinePolicy targeting the queue suppresses the added QueuePolicy', async () => {
    const sqs = mockClient(SQSClient);
    sqs.on(GetQueueAttributesCommand).resolves({ Attributes: { Policy: queuePolicy } });
    const added = await enumerateSqsQueueChildren(
      sqsCtx([
        {
          resourceType: 'AWS::SQS::QueueInlinePolicy',
          physicalId: QURL,
          declared: { Queue: QURL },
        },
      ])
    );
    expect(added).toEqual([]);
    sqs.restore();
  });

  it('SQS: a QueueInlinePolicy with an UNRESOLVED Queue is conservatively treated as covering', async () => {
    const sqs = mockClient(SQSClient);
    sqs.on(GetQueueAttributesCommand).resolves({ Attributes: { Policy: queuePolicy } });
    const added = await enumerateSqsQueueChildren(
      sqsCtx([
        {
          resourceType: 'AWS::SQS::QueueInlinePolicy',
          physicalId: QURL,
          declared: { Queue: UNRESOLVED },
        },
      ])
    );
    expect(added).toEqual([]);
    sqs.restore();
  });

  it('SQS: a QueueInlinePolicy for a DIFFERENT queue does NOT suppress (rogue still surfaces)', async () => {
    const sqs = mockClient(SQSClient);
    sqs.on(GetQueueAttributesCommand).resolves({ Attributes: { Policy: queuePolicy } });
    const added = await enumerateSqsQueueChildren(
      sqsCtx([
        {
          resourceType: 'AWS::SQS::QueueInlinePolicy',
          physicalId: 'https://sqs.us-east-1.amazonaws.com/111122223333/other-queue',
          declared: { Queue: 'https://sqs.us-east-1.amazonaws.com/111122223333/other-queue' },
        },
      ])
    );
    expect(added.map((a) => a.resourceType)).toEqual(['AWS::SQS::QueuePolicy']);
    sqs.restore();
  });

  it('SNS: a declared TopicInlinePolicy targeting the topic suppresses the added TopicPolicy', async () => {
    const sns = mockClient(SNSClient);
    sns.on(ListSubscriptionsByTopicCommand).resolves({ Subscriptions: [] });
    sns.on(GetTopicAttributesCommand).resolves({ Attributes: { Policy: topicPolicy } });
    const added = await enumerateSnsTopicChildren(
      snsCtx([
        {
          resourceType: 'AWS::SNS::TopicInlinePolicy',
          physicalId: TOPIC_ARN,
          declared: { TopicArn: TOPIC_ARN },
        },
      ])
    );
    expect(added).toEqual([]);
    sns.restore();
  });

  it('SNS: a TopicInlinePolicy with an UNRESOLVED TopicArn is conservatively treated as covering', async () => {
    const sns = mockClient(SNSClient);
    sns.on(ListSubscriptionsByTopicCommand).resolves({ Subscriptions: [] });
    sns.on(GetTopicAttributesCommand).resolves({ Attributes: { Policy: topicPolicy } });
    const added = await enumerateSnsTopicChildren(
      snsCtx([
        {
          resourceType: 'AWS::SNS::TopicInlinePolicy',
          physicalId: TOPIC_ARN,
          declared: { TopicArn: UNRESOLVED },
        },
      ])
    );
    expect(added).toEqual([]);
    sns.restore();
  });

  it('SNS: a TopicInlinePolicy for a DIFFERENT topic does NOT suppress (rogue still surfaces)', async () => {
    const sns = mockClient(SNSClient);
    sns.on(ListSubscriptionsByTopicCommand).resolves({ Subscriptions: [] });
    sns.on(GetTopicAttributesCommand).resolves({ Attributes: { Policy: topicPolicy } });
    const added = await enumerateSnsTopicChildren(
      snsCtx([
        {
          resourceType: 'AWS::SNS::TopicInlinePolicy',
          physicalId: 'arn:aws:sns:us-east-1:111122223333:other-topic',
          declared: { TopicArn: 'arn:aws:sns:us-east-1:111122223333:other-topic' },
        },
      ])
    );
    expect(added.map((a) => a.resourceType)).toEqual(['AWS::SNS::TopicPolicy']);
    sns.restore();
  });
});

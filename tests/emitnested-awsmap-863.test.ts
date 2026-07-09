import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// #863 — `emitNested` dropped ANY live-only map whose keys are all `aws:*`. That matches an
// IAM policy Condition OPERATOR map (`{aws:SourceAccount: ...}`) as perfectly as a
// MAP-shaped tag, so an out-of-band Condition operator added under a DECLARED statement was
// silently dropped and survived `record` — a security FN. The drop is now gated on the
// parent key being a tag property (`*Tags`); the array-of-`{Key:'aws:*'}` tag list (real
// AWS-managed system tags) still drops unconditionally.
const emptySchema: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};
const undeclaredPaths = (fs: Finding[]): string[] =>
  fs
    .filter((f) => f.tier === 'undeclared')
    .map((f) => f.path)
    .sort();
const mk = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId: 'phys',
  declared,
});

describe('#863 out-of-band IAM Condition operator surfaces (aws:* map no longer dropped)', () => {
  const declaredPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'sns.amazonaws.com' },
        Action: 'sqs:SendMessage',
        Resource: 'arn:aws:sqs:us-east-1:111122223333:q',
        Condition: { ArnEquals: { 'aws:SourceArn': 'arn:aws:sns:us-east-1:111122223333:t' } },
      },
    ],
  };

  it('a live-only Condition operator keyed by aws:* is undeclared drift, not dropped', () => {
    const res = mk('AWS::SQS::QueuePolicy', {
      Queues: ['https://sqs.us-east-1.amazonaws.com/111122223333/q'],
      PolicyDocument: declaredPolicy,
    });
    const live = {
      Queues: ['https://sqs.us-east-1.amazonaws.com/111122223333/q'],
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'sns.amazonaws.com' },
            Action: 'sqs:SendMessage',
            Resource: 'arn:aws:sqs:us-east-1:111122223333:q',
            Condition: {
              ArnEquals: { 'aws:SourceArn': 'arn:aws:sns:us-east-1:111122223333:t' },
              // added out of band — an access WIDENING that used to be invisible
              StringEquals: { 'aws:SourceAccount': '222233334444' },
            },
          },
        ],
      },
    };
    const f = classifyResource(res, live, emptySchema);
    // SOMETHING under the added operator must surface (the operator or its aws:* sub-key)
    const surfaced = undeclaredPaths(f).some((p) => /StringEquals|aws:SourceAccount/.test(p));
    expect(surfaced).toBe(true);
  });

  it('an identical live policy (no out-of-band change) stays clean', () => {
    const res = mk('AWS::SQS::QueuePolicy', {
      Queues: ['https://sqs.us-east-1.amazonaws.com/111122223333/q'],
      PolicyDocument: declaredPolicy,
    });
    const live = {
      Queues: ['https://sqs.us-east-1.amazonaws.com/111122223333/q'],
      PolicyDocument: declaredPolicy,
    };
    const f = classifyResource(res, live, emptySchema);
    expect(undeclaredPaths(f)).toEqual([]);
  });

  it('AWS-managed system tags (array of {Key:aws:*}) still fold — no first-run FP', () => {
    const res = mk('AWS::SNS::Topic', { TopicName: 't' });
    const live = {
      TopicName: 't',
      // the array-of-Key tag list form: always AWS-managed, must still be dropped
      Tags: [{ Key: 'aws:cloudformation:stack-name', Value: 'MyStack' }],
    };
    const f = classifyResource(res, live, emptySchema);
    expect(undeclaredPaths(f)).toEqual([]);
  });
});

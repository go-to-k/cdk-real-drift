// #835 — reverting an `added` AWS::SNS::TopicPolicy (an out-of-band `set-topic-attributes
// Policy=…` on a topic with no declared TopicPolicy, surfaced by the SNS child enumerator)
// must route through the SNS SetTopicAttributes API, NOT Cloud Control DeleteResource: the
// TopicPolicy CC primaryIdentifier is a service-generated `Id` an out-of-band policy never
// produces, so a CC delete keyed on the topic ARN would fail. The SDK deleter (SDK_DELETERS,
// the delete analog of SDK_WRITERS — the #1312/#1386/#1431 type-specific SDK routing) does NOT
// clear the policy (SNS REJECTS an empty Policy, verified live) — instead it RESTORES the
// AWS-DEFAULT access policy every fresh topic carries, so a later `check` folds it and reports
// CLEAN. The finding carries the TOPIC ARN as its physicalId, which IS the SetTopicAttributes
// target and the source of the owner account for the rebuilt default.
import { SetTopicAttributesCommand, SNSClient } from '@aws-sdk/client-sns';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { SDK_DELETERS } from '../src/revert/writers.js';

const TARN = 'arn:aws:sns:us-east-1:111122223333:my-topic';

describe('SDK_DELETERS[AWS::SNS::TopicPolicy] — SetTopicAttributes back to the AWS default (#835)', () => {
  const sns = mockClient(SNSClient);
  beforeEach(() => sns.reset());
  afterEach(() => sns.restore());

  const deleter = SDK_DELETERS['AWS::SNS::TopicPolicy']!;

  it('is registered (the routing table knows the type)', () => {
    expect(deleter).toBeDefined();
  });

  it('restores the AWS-default policy via SetTopicAttributes on the topic ARN', async () => {
    sns.on(SetTopicAttributesCommand).resolves({});
    await deleter({ physicalId: TARN, region: 'us-east-1' });
    const calls = sns.commandCalls(SetTopicAttributesCommand);
    expect(calls.length).toBe(1);
    const input = calls[0]!.args[0].input;
    expect(input.TopicArn).toBe(TARN);
    expect(input.AttributeName).toBe('Policy');
    // The written policy is the AWS default: owner account parsed from the ARN, the eight
    // default actions, Resource = the topic ARN, SourceOwner = the owner account.
    const written = JSON.parse(input.AttributeValue!);
    expect(written.Id).toBe('__default_policy_ID');
    expect(written.Statement[0].Sid).toBe('__default_statement_ID');
    expect(written.Statement[0].Principal).toEqual({ AWS: '*' });
    expect(written.Statement[0].Action).toHaveLength(8);
    expect(written.Statement[0].Resource).toBe(TARN);
    expect(written.Statement[0].Condition).toEqual({
      StringEquals: { 'AWS:SourceOwner': '111122223333' },
    });
  });

  it('throws when the owner account cannot be parsed from the physicalId', async () => {
    await expect(deleter({ physicalId: 'not-an-arn', region: 'us-east-1' })).rejects.toThrow(
      /owner account/
    );
  });

  it('propagates a genuine failure (honest FAILED, not a silent skip)', async () => {
    sns
      .on(SetTopicAttributesCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(deleter({ physicalId: TARN, region: 'us-east-1' })).rejects.toThrow('denied');
  });
});

// #835 — reverting an `added` AWS::SQS::QueuePolicy (an out-of-band `set-queue-attributes
// Policy=…` on a queue with no declared QueuePolicy, surfaced by the SQS child enumerator)
// must route through the SQS SetQueueAttributes API, NOT Cloud Control DeleteResource: the
// QueuePolicy CC primaryIdentifier is a service-generated `Id` an out-of-band policy never
// produces, so a CC delete keyed on the queue URL would fail. The SDK deleter (SDK_DELETERS,
// the delete analog of SDK_WRITERS — the #1312/#1386/#1431 type-specific SDK routing) clears
// the policy by setting the `Policy` attribute to an empty string; the finding carries the
// QUEUE URL as its physicalId, which IS the SetQueueAttributes target.
import { SetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { SDK_DELETERS } from '../src/revert/writers.js';

const QURL = 'https://sqs.us-east-1.amazonaws.com/111122223333/my-queue';

describe('SDK_DELETERS[AWS::SQS::QueuePolicy] — SetQueueAttributes Policy="" (#835)', () => {
  const sqs = mockClient(SQSClient);
  beforeEach(() => sqs.reset());
  afterEach(() => sqs.restore());

  const deleter = SDK_DELETERS['AWS::SQS::QueuePolicy']!;

  it('is registered (the routing table knows the type)', () => {
    expect(deleter).toBeDefined();
  });

  it('clears the queue policy via SetQueueAttributes with an empty Policy on the queue URL', async () => {
    sqs.on(SetQueueAttributesCommand).resolves({});
    await deleter({ physicalId: QURL, region: 'us-east-1' });
    const calls = sqs.commandCalls(SetQueueAttributesCommand);
    expect(calls.length).toBe(1);
    expect(calls[0]!.args[0].input).toEqual({ QueueUrl: QURL, Attributes: { Policy: '' } });
  });

  it('propagates a genuine failure (honest FAILED, not a silent skip)', async () => {
    sqs
      .on(SetQueueAttributesCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(deleter({ physicalId: QURL, region: 'us-east-1' })).rejects.toThrow('denied');
  });
});

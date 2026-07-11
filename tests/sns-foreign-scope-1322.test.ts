import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vite-plus/test';
import { isManagedBySiblingStack } from '../src/commands/gather.js';
import { type AddedChild, diffSnsTopicChildren } from '../src/read/child-enumerators.js';

// #1322: an AWS::SNS::Subscription's physical id is `<topicArn>:<uuid>` — always minted under the
// TOPIC's (= this check's) account+region, so the identifier-ARN scope parse in
// `isDefinitiveNotManaged` always reads it LOCAL, even when a FOREIGN subscriber stack (the
// canonical cross-account / cross-region SNS fan-out) legitimately owns it. That made a
// DescribeStackResources `ValidationError` a false-definitive `notManaged` -> a false `[Added]`
// with a DESTRUCTIVE DeleteResource revert offer on another stack's resource. Threading the
// subscription's `Owner` (owning account) and ARN `Endpoint` (subscriber scope) onto AddedChild
// lets a foreign signal downgrade that ValidationError to `unverified` (fail-safe, never a delete).
describe('#1322: SNS subscription foreign Owner/Endpoint gates the sibling-stack ValidationError', () => {
  // The check-run's OWN account+region — the subscription ARN below is minted here (topic-local),
  // so absent a foreign signal a ValidationError is a DEFINITIVE local not-managed.
  const LOCAL_ACCOUNT = '111122223333';
  const LOCAL_REGION = 'us-east-1';
  const FOREIGN_ACCOUNT = '999988887777';
  // Topic-local subscription arn (its account+region ALWAYS equals the topic's = the check's).
  const subArn = `arn:aws:sns:${LOCAL_REGION}:${LOCAL_ACCOUNT}:NotifTopic:0000-1111-2222`;

  const rejectValidationError = (cfn: ReturnType<typeof mockClient>) => {
    const notFound = new Error(`Stack for ${subArn} does not exist`);
    notFound.name = 'ValidationError';
    cfn.on(DescribeStackResourcesCommand).rejects(notFound);
  };

  const subChild = (extra: Partial<AddedChild>): AddedChild => ({
    resourceType: 'AWS::SNS::Subscription',
    identifier: subArn,
    label: subArn,
    live: { SubscriptionArn: subArn },
    ...extra,
  });

  it('a FOREIGN-account owner (Owner !== run account) -> unverified, NOT notManaged', async () => {
    const cfn = mockClient(CloudFormationClient);
    rejectValidationError(cfn);
    const managed = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      subChild({ ownerAccountId: FOREIGN_ACCOUNT }),
      new Map(),
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    expect(managed).toBe('unverified');
  });

  it('a FOREIGN-scope endpoint ARN (cross-region subscriber) -> unverified, NOT notManaged', async () => {
    const cfn = mockClient(CloudFormationClient);
    rejectValidationError(cfn);
    // Endpoint is a Lambda in a DIFFERENT region -> the subscription is declared in that
    // subscriber's foreign stack; the local DescribeStackResources cannot see it.
    const foreignEndpoint = `arn:aws:lambda:eu-west-1:${FOREIGN_ACCOUNT}:function:Consumer`;
    const managed = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      subChild({ scopeArns: [foreignEndpoint] }),
      new Map(),
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    expect(managed).toBe('unverified');
  });

  it('a LOCAL owner + no foreign endpoint -> notManaged (unchanged genuine out-of-band behavior)', async () => {
    const cfn = mockClient(CloudFormationClient);
    rejectValidationError(cfn);
    // Owner is this account, endpoint (if any) is same-account+region -> a real local addition.
    const localEndpoint = `arn:aws:lambda:${LOCAL_REGION}:${LOCAL_ACCOUNT}:function:Consumer`;
    const managed = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      subChild({ ownerAccountId: LOCAL_ACCOUNT, scopeArns: [localEndpoint] }),
      new Map(),
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    expect(managed).toBe('notManaged');
  });

  it('no metadata at all -> notManaged (generic ARN backstop preserved)', async () => {
    const cfn = mockClient(CloudFormationClient);
    rejectValidationError(cfn);
    const managed = await isManagedBySiblingStack(
      cfn as unknown as CloudFormationClient,
      subChild({}),
      new Map(),
      LOCAL_ACCOUNT,
      LOCAL_REGION
    );
    expect(managed).toBe('notManaged');
  });
});

describe('diffSnsTopicChildren threads Owner/Endpoint onto the AddedChild (#1322)', () => {
  const subArn = 'arn:aws:sns:us-east-1:111122223333:Topic:abcd-uuid';

  it('carries a foreign Owner as ownerAccountId and an ARN Endpoint as scopeArns', () => {
    const endpoint = 'arn:aws:lambda:eu-west-1:999988887777:function:Consumer';
    const added = diffSnsTopicChildren({
      declaredSubscriptionArns: [],
      liveSubscriptions: [{ arn: subArn, label: 'lambda', endpoint, owner: '999988887777' }],
    });
    expect(added).toHaveLength(1);
    expect(added[0]!.ownerAccountId).toBe('999988887777');
    expect(added[0]!.scopeArns).toEqual([endpoint]);
  });

  it('leaves scopeArns undefined for a non-ARN endpoint (e.g. an email/https subscription)', () => {
    const added = diffSnsTopicChildren({
      declaredSubscriptionArns: [],
      liveSubscriptions: [
        { arn: subArn, label: 'email', endpoint: 'ops@example.com', owner: '111122223333' },
      ],
    });
    expect(added).toHaveLength(1);
    expect(added[0]!.ownerAccountId).toBe('111122223333');
    expect(added[0]!.scopeArns).toBeUndefined();
  });
});

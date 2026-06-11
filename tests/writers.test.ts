import {
  CreatePolicyVersionCommand,
  DeletePolicyVersionCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  IAMClient,
  ListPolicyVersionsCommand,
} from '@aws-sdk/client-iam';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import type { OverrideCtx } from '../src/read/overrides.js';
import type { PatchOp } from '../src/revert/plan.js';
import { SDK_WRITERS } from '../src/revert/writers.js';

const iam = mockClient(IAMClient);

const ARN = 'arn:aws:iam::123456789012:policy/p';
const ctx = (over: Partial<OverrideCtx> = {}): OverrideCtx => ({
  physicalId: ARN,
  declared: {},
  region: 'us-east-1',
  accountId: '123456789012',
  ...over,
});
const DESIRED = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
};
const addOp = (value: unknown): PatchOp => ({
  op: 'add',
  path: '/PolicyDocument',
  value,
  human: 'PolicyDocument -> deployed-template value',
});

// the override reader for ManagedPolicy reads GetPolicy + GetPolicyVersion(default)
const stubReader = (currentDoc: unknown): void => {
  iam.on(GetPolicyCommand).resolves({ Policy: { Path: '/', DefaultVersionId: 'v1' } });
  iam
    .on(GetPolicyVersionCommand)
    .resolves({ PolicyVersion: { Document: JSON.stringify(currentDoc) } });
};

beforeEach(() => iam.reset());

describe('IAM ManagedPolicy writer', () => {
  it('creates a new default version carrying the reverted document', async () => {
    stubReader({ Version: '2012-10-17', Statement: [] });
    iam
      .on(ListPolicyVersionsCommand)
      .resolves({ Versions: [{ VersionId: 'v1', IsDefaultVersion: true }] });
    iam.on(CreatePolicyVersionCommand).resolves({});

    await SDK_WRITERS['AWS::IAM::ManagedPolicy'](ctx(), [addOp(DESIRED)]);

    const created = iam.commandCalls(CreatePolicyVersionCommand);
    expect(created).toHaveLength(1);
    expect(created[0]!.args[0].input).toMatchObject({
      PolicyArn: ARN,
      SetAsDefault: true,
      PolicyDocument: JSON.stringify(DESIRED),
    });
    expect(iam.commandCalls(DeletePolicyVersionCommand)).toHaveLength(0);
  });

  it('prunes the oldest NON-default version when 5 already exist before creating', async () => {
    stubReader({ Version: '2012-10-17', Statement: [] });
    const d = (s: string) => new Date(s);
    iam.on(ListPolicyVersionsCommand).resolves({
      Versions: [
        { VersionId: 'v5', IsDefaultVersion: true, CreateDate: d('2020-05-01') },
        { VersionId: 'v2', IsDefaultVersion: false, CreateDate: d('2020-02-01') },
        { VersionId: 'v1', IsDefaultVersion: false, CreateDate: d('2020-01-01') }, // oldest non-default
        { VersionId: 'v4', IsDefaultVersion: false, CreateDate: d('2020-04-01') },
        { VersionId: 'v3', IsDefaultVersion: false, CreateDate: d('2020-03-01') },
      ],
    });
    iam.on(DeletePolicyVersionCommand).resolves({});
    iam.on(CreatePolicyVersionCommand).resolves({});

    await SDK_WRITERS['AWS::IAM::ManagedPolicy'](ctx(), [addOp(DESIRED)]);

    const deleted = iam.commandCalls(DeletePolicyVersionCommand);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.args[0].input).toMatchObject({ PolicyArn: ARN, VersionId: 'v1' });
    expect(iam.commandCalls(CreatePolicyVersionCommand)).toHaveLength(1);
  });

  it('falls back to ctx.declared.ManagedPolicyArn when physicalId is not an arn', async () => {
    stubReader({ Version: '2012-10-17', Statement: [] });
    iam.on(ListPolicyVersionsCommand).resolves({ Versions: [] });
    iam.on(CreatePolicyVersionCommand).resolves({});

    await SDK_WRITERS['AWS::IAM::ManagedPolicy'](
      ctx({ physicalId: 'not-an-arn', declared: { ManagedPolicyArn: ARN } }),
      [addOp(DESIRED)]
    );

    expect(iam.commandCalls(CreatePolicyVersionCommand)[0]!.args[0].input).toMatchObject({
      PolicyArn: ARN,
    });
  });

  it('throws when no managed policy arn can be resolved', async () => {
    await expect(
      SDK_WRITERS['AWS::IAM::ManagedPolicy'](ctx({ physicalId: 'x', declared: {} }), [
        addOp(DESIRED),
      ])
    ).rejects.toThrow(/managed policy arn/);
  });
});

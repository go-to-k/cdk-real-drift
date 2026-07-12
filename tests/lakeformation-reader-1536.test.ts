// #1536 — AWS::LakeFormation::Resource was ALWAYS silently skipped: the CFn physical id is
// NOT the bare ResourceArn (CloudFormation prefixes it, `LakeFormation-arn:aws:s3:::bucket`),
// so the reader passed it verbatim to DescribeResource -> InvalidInputException -> skip ->
// a falsely-CLEAN read on the exact type the reader was added to watch (#930) — the same
// ARN-vs-physical-id skip-mask class as #1523. The reader now strips everything before the
// first `arn:`. Live-verified both directions on CdkrdHunt0713MiscReaders (us-east-1,
// 2026-07-13): fresh deploy reads CLEAN (SLR RoleArn folds via CONTEXT_ARN_DEFAULTS), an
// out-of-band hybrid-access re-registration surfaces HybridAccessEnabled=true.
import { DescribeResourceCommand, LakeFormationClient } from '@aws-sdk/client-lakeformation';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { SDK_OVERRIDES } from '../src/read/overrides.js';

const lf = mockClient(LakeFormationClient);

const ARN = 'arn:aws:s3:::cdkrd-hunt-lf-bucket';
const SLR =
  'arn:aws:iam::123456789012:role/aws-service-role/lakeformation.amazonaws.com/AWSServiceRoleForLakeFormationDataAccess';

const read = (physicalId: string) =>
  SDK_OVERRIDES['AWS::LakeFormation::Resource']({
    physicalId,
    declared: { ResourceArn: ARN, UseServiceLinkedRole: true },
    region: 'us-east-1',
    accountId: '123456789012',
  });

beforeEach(() => {
  lf.reset();
  lf.on(DescribeResourceCommand).resolves({
    ResourceInfo: { ResourceArn: ARN, RoleArn: SLR, HybridAccessEnabled: false },
  });
});

describe('#1536 LakeFormation Resource reader physical-id handling', () => {
  it('strips the CloudFormation `LakeFormation-` prefix before calling DescribeResource', async () => {
    const out = await read(`LakeFormation-${ARN}`);
    expect(lf.commandCalls(DescribeResourceCommand)[0]?.args[0].input).toEqual({
      ResourceArn: ARN,
    });
    expect(out).toEqual({ ResourceArn: ARN, RoleArn: SLR, HybridAccessEnabled: false });
  });

  it('still accepts a bare ARN physical id', async () => {
    await read(ARN);
    expect(lf.commandCalls(DescribeResourceCommand)[0]?.args[0].input).toEqual({
      ResourceArn: ARN,
    });
  });
});

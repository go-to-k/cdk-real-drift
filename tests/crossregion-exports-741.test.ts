// #741 — crossRegionReferences (Custom::CrossRegionExportReader) GetAtt resolution.
//
// CDK's `crossRegionReferences: true` pattern synthesizes a `Custom::CrossRegionExportReader`
// in the consumer stack, and the consumer property becomes
// `{ Fn::GetAtt: [<Reader>, "/cdk/exports/<name>"] }`. The reader has no live model, so that
// GetAtt used to resolve UNRESOLVED forever — leaving an out-of-band cert swap invisible.
// The fix prefetches the reader-materialized SSM parameters (`/cdk/exports/*`) and resolves
// the GetAtt from that map, so a live cert-ARN mismatch is now detected as declared drift.
import {
  CloudFormationClient,
  DescribeStacksCommand,
  GetTemplateCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vite-plus/test';
import { collectCrossRegionExportNames, loadDesired } from '../src/desired/template-adapter.js';
import { resolveGetAtt, UNRESOLVED } from '../src/normalize/intrinsic-resolver.js';
import type { ResolverContext } from '../src/types.js';

function ctx(over: Partial<ResolverContext> = {}): ResolverContext {
  return {
    params: {},
    pseudo: {
      'AWS::Region': 'eu-west-1',
      'AWS::AccountId': '123',
      'AWS::Partition': 'aws',
      'AWS::URLSuffix': 'amazonaws.com',
      'AWS::StackName': 'S',
      'AWS::StackId': 'id',
    },
    conditions: {},
    physIds: {},
    liveAttrs: {},
    typeOf: {},
    mappings: {},
    exports: {},
    condCache: new Map(),
    ...over,
  };
}

describe('#741 resolveGetAtt — crossRegionReferences reader GetAtt', () => {
  const READER = 'ExportsReader8B249524';
  const PARAM = '/cdk/exports/MyCertArn';
  const CERT_ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/abc-123';

  it('resolves a Custom::CrossRegionExportReader GetAtt from ctx.crossRegionExports', () => {
    const c = ctx({
      typeOf: { [READER]: 'Custom::CrossRegionExportReader' },
      crossRegionExports: { [PARAM]: CERT_ARN },
    });
    // Both GetAtt forms produce the arn — so a live cert mismatch WOULD now surface as drift.
    expect(resolveGetAtt([READER, PARAM], c)).toBe(CERT_ARN);
    expect(resolveGetAtt(`${READER}.${PARAM}`, c)).toBe(CERT_ARN);
  });

  it('resolves on the /cdk/exports/ attribute shape even when the Type is unknown', () => {
    // Belt-and-suspenders: the `/cdk/exports/` attribute shape is unambiguous to this pattern,
    // so a reader whose Type is not in ctx.typeOf still resolves.
    const c = ctx({ typeOf: {}, crossRegionExports: { [PARAM]: CERT_ARN } });
    expect(resolveGetAtt([READER, PARAM], c)).toBe(CERT_ARN);
  });

  it('stays UNRESOLVED when the parameter is not in the prefetched map (fail closed)', () => {
    const c = ctx({
      typeOf: { [READER]: 'Custom::CrossRegionExportReader' },
      crossRegionExports: {}, // prefetch failed / parameter missing
    });
    expect(resolveGetAtt([READER, PARAM], c)).toBe(UNRESOLVED);
  });

  it('stays UNRESOLVED when there is no crossRegionExports map at all', () => {
    const c = ctx({ typeOf: { [READER]: 'Custom::CrossRegionExportReader' } });
    expect(resolveGetAtt([READER, PARAM], c)).toBe(UNRESOLVED);
  });

  it('does NOT intercept an ordinary GetAtt (no /cdk/exports/ prefix)', () => {
    // An ordinary GetAtt against a resource with a live model still resolves normally, and one
    // without a live model is UNRESOLVED — the reader gate never fires for a normal attribute.
    const c = ctx({
      typeOf: { Bucket: 'AWS::S3::Bucket' },
      liveAttrs: { Bucket: { Arn: 'arn:aws:s3:::b' } },
      crossRegionExports: { [PARAM]: CERT_ARN },
    });
    expect(resolveGetAtt(['Bucket', 'Arn'], c)).toBe('arn:aws:s3:::b');
    expect(resolveGetAtt(['Bucket', 'DoesNotExist'], c)).toBe(UNRESOLVED);
  });
});

describe('#741 collectCrossRegionExportNames', () => {
  it('collects distinct /cdk/exports/ names referenced by reader GetAtts (array + string form)', () => {
    const template = {
      Resources: {
        Reader: { Type: 'Custom::CrossRegionExportReader' },
        Dist: {
          Type: 'AWS::CloudFront::Distribution',
          Properties: {
            ViewerCertificate: {
              AcmCertificateArn: { 'Fn::GetAtt': ['Reader', '/cdk/exports/CertArn'] },
            },
            Comment: { 'Fn::GetAtt': 'Reader./cdk/exports/CommentVal' },
            // a duplicate reference to CertArn — must dedupe
            Aliases: [{ 'Fn::GetAtt': ['Reader', '/cdk/exports/CertArn'] }],
          },
        },
      },
    };
    expect(collectCrossRegionExportNames(template)).toEqual([
      '/cdk/exports/CertArn',
      '/cdk/exports/CommentVal',
    ]);
  });

  it('returns [] when there is no reader resource (normal stack pays nothing)', () => {
    const template = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: { Tags: { 'Fn::GetAtt': ['X', 'Y'] } } },
      },
    };
    expect(collectCrossRegionExportNames(template)).toEqual([]);
  });

  it('ignores a /cdk/exports/ GetAtt whose logicalId is NOT a reader', () => {
    // A GetAtt to a non-reader logicalId with a slash-attribute (contrived) is not collected.
    const template = {
      Resources: {
        NotAReader: { Type: 'AWS::S3::Bucket' },
        R: {
          Type: 'AWS::S3::Bucket',
          Properties: { X: { 'Fn::GetAtt': ['NotAReader', '/cdk/exports/Nope'] } },
        },
      },
    };
    expect(collectCrossRegionExportNames(template)).toEqual([]);
  });
});

describe('#741 loadDesired — prefetches /cdk/exports/* and resolves the consumer GetAtt', () => {
  const CERT_ARN = 'arn:aws:acm:us-east-1:111122223333:certificate/live-cert';

  function mockCfn(template: Record<string, unknown>): ReturnType<typeof mockClient> {
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).resolves({ TemplateBody: JSON.stringify(template) });
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'Dist',
          PhysicalResourceId: 'dist-phys',
          ResourceType: 'AWS::CloudFront::Distribution',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
        {
          LogicalResourceId: 'Reader',
          PhysicalResourceId: 'reader-phys',
          ResourceType: 'Custom::CrossRegionExportReader',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          // NOTE: distinct account per test avoids the module-level prefetch cache bleeding
          StackId: 'arn:aws:cloudformation:eu-west-1:111122223333:stack/S/x',
          StackName: 'S',
          CreationTime: new Date(0),
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
        },
      ],
    });
    return cfn;
  }

  const template = {
    Resources: {
      Reader: { Type: 'Custom::CrossRegionExportReader' },
      Dist: {
        Type: 'AWS::CloudFront::Distribution',
        Properties: {
          ViewerCertificate: {
            AcmCertificateArn: { 'Fn::GetAtt': ['Reader', '/cdk/exports/MyCertArn'] },
          },
        },
      },
    },
  };

  it('resolves the reader GetAtt to the live SSM parameter value (drift now detectable)', async () => {
    const cfn = mockCfn(template);
    const ssm = mockClient(SSMClient);
    ssm
      .on(GetParametersCommand, { Names: ['/cdk/exports/MyCertArn'] })
      .resolves({ Parameters: [{ Name: '/cdk/exports/MyCertArn', Value: CERT_ARN }] });

    const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'S', 'eu-west-1');
    const dist = desired.resources.find((r) => r.logicalId === 'Dist');
    expect(dist).toBeDefined();
    expect((dist!.declared.ViewerCertificate as Record<string, unknown>).AcmCertificateArn).toBe(
      CERT_ARN
    );
  });

  it('leaves the GetAtt UNRESOLVED when the SSM parameter is unreadable (fail closed)', async () => {
    // Different account => different cache key, so the prior success does not leak in.
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).resolves({ TemplateBody: JSON.stringify(template) });
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'Dist',
          PhysicalResourceId: 'dist-phys',
          ResourceType: 'AWS::CloudFront::Distribution',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackId: 'arn:aws:cloudformation:eu-west-1:999988887777:stack/S/x',
          StackName: 'S',
          CreationTime: new Date(0),
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [],
        },
      ],
    });
    const ssm = mockClient(SSMClient);
    ssm.on(GetParametersCommand).rejects(new Error('AccessDenied'));

    const desired = await loadDesired(cfn as unknown as CloudFormationClient, 'S', 'eu-west-1');
    const dist = desired.resources.find((r) => r.logicalId === 'Dist');
    // The GetAtt stays UNRESOLVED (as before the fix) — a symbol, never a fabricated value —
    // so the AcmCertificateArn is skipped from comparison rather than compared against a guess.
    const vc = dist!.declared.ViewerCertificate as Record<string, unknown>;
    expect(vc.AcmCertificateArn).toBe(UNRESOLVED);
  });
});

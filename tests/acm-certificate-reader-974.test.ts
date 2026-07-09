import {
  ACMClient,
  DescribeCertificateCommand,
  ListTagsForCertificateCommand,
} from '@aws-sdk/client-acm';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { SDK_OVERRIDES } from '../src/read/overrides.js';

const acm = mockClient(ACMClient);

const ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012';

const ctx = (
  physicalId: string,
  declared: Record<string, unknown> = {},
  region = 'us-east-1',
  accountId = '123456789012'
) => ({ physicalId, declared, region, accountId });

const read = (c: ReturnType<typeof ctx>) =>
  SDK_OVERRIDES['AWS::CertificateManager::Certificate'](c);

beforeEach(() => {
  acm.reset();
});

describe('AWS::CertificateManager::Certificate SDK override', () => {
  it('maps DescribeCertificate + tags to the CFn live model and addresses by the ARN', async () => {
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        CertificateArn: ARN,
        DomainName: 'example.com',
        SubjectAlternativeNames: ['example.com', 'www.example.com'],
        KeyAlgorithm: 'RSA_2048',
        Options: { CertificateTransparencyLoggingPreference: 'ENABLED' },
      },
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: [{ Key: 'Name', Value: 'my-cert' }] });

    // Template declares SANs + Options, so both are projected.
    const out = await read(
      ctx(ARN, {
        SubjectAlternativeNames: ['example.com', 'www.example.com'],
        Options: { CertificateTransparencyLoggingPreference: 'ENABLED' },
      })
    );
    expect(out).toEqual({
      DomainName: 'example.com',
      KeyAlgorithm: 'RSA_2048',
      SubjectAlternativeNames: ['example.com', 'www.example.com'],
      Options: { CertificateTransparencyLoggingPreference: 'ENABLED' },
      Tags: [{ Key: 'Name', Value: 'my-cert' }],
    });
    const call = acm.commandCalls(DescribeCertificateCommand)[0];
    expect(call.args[0].input).toEqual({ CertificateArn: ARN });
  });

  it('folds the ENABLED transparency default and the implied SAN for a clean undeclared cert (ZERO first-run drift)', async () => {
    // A minimal cert: template declares only DomainName. AWS returns DomainName as an
    // implied SAN and the ENABLED transparency default. Neither must surface.
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        CertificateArn: ARN,
        DomainName: 'example.com',
        SubjectAlternativeNames: ['example.com'], // AWS-implied — not declared
        KeyAlgorithm: 'RSA_2048',
        Options: { CertificateTransparencyLoggingPreference: 'ENABLED' }, // the default
      },
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: [] });

    const out = await read(ctx(ARN, { DomainName: 'example.com' }));
    expect(out).toEqual({ DomainName: 'example.com', KeyAlgorithm: 'RSA_2048' });
    expect(out).not.toHaveProperty('SubjectAlternativeNames');
    expect(out).not.toHaveProperty('Options');
    expect(out).not.toHaveProperty('Tags');
  });

  it('surfaces an out-of-band DISABLE of transparency even when Options is undeclared', async () => {
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        CertificateArn: ARN,
        DomainName: 'example.com',
        Options: { CertificateTransparencyLoggingPreference: 'DISABLED' }, // moved away from default
      },
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: [] });

    const out = await read(ctx(ARN, { DomainName: 'example.com' }));
    expect(out).toMatchObject({
      Options: { CertificateTransparencyLoggingPreference: 'DISABLED' },
    });
  });

  it('propagates ResourceNotFoundException so the router maps it to deleted', async () => {
    const err = Object.assign(new Error('cert gone'), {
      name: 'ResourceNotFoundException',
    });
    acm.on(DescribeCertificateCommand).rejects(err);
    await expect(read(ctx(ARN))).rejects.toThrow('cert gone');
  });

  it('keeps the certificate model when ListTagsForCertificate fails (no whole-read drop)', async () => {
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: { CertificateArn: ARN, DomainName: 'example.com', KeyAlgorithm: 'RSA_2048' },
    });
    acm.on(ListTagsForCertificateCommand).rejects(new Error('AccessDenied'));

    const out = await read(ctx(ARN, { DomainName: 'example.com' }));
    expect(out).toEqual({ DomainName: 'example.com', KeyAlgorithm: 'RSA_2048' });
  });

  it('returns undefined when the physical id is not an ARN (target not resolvable)', async () => {
    expect(await read(ctx(''))).toBeUndefined();
    expect(await read(ctx('not-an-arn'))).toBeUndefined();
  });
});

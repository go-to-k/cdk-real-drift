// #1090 — ACM Certificate first-run folds. The #974 SDK reader un-skipped
// AWS::CertificateManager::Certificate but added no fold-table entries, so a clean
// DNS-validated cert produced 2-3 [Potential Drift] on a first check. Three fixes, each
// satisfying the zero-first-run invariant while PRESERVING detection:
//   F1 DomainValidationOptions — a createOnly write-time INPUT collection AWS never echoes
//      back verbatim → READGAP_COLLECTION_PATHS denylist (classify's removed-collection
//      branch skips it → readGap, not declared drift).
//   F2 KeyAlgorithm — the RSA_2048 default the reader returns unconditionally →
//      KNOWN_DEFAULTS tier-1 pin (folds to atDefault; a declared different algorithm surfaces).
//   F3 SubjectAlternativeNames — ACM injects the apex DomainName as an implied SAN; the
//      reader subtracts it from the projected live list when the declared list omits it.
import {
  ACMClient,
  DescribeCertificateCommand,
  ListTagsForCertificateCommand,
} from '@aws-sdk/client-acm';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { SDK_OVERRIDES } from '../src/read/overrides.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// The live ACM registry schema exposes only readOnly=/properties/Id — no writeOnly — so
// DomainValidationOptions survives schema-strip into the declared model (the F1 condition).
const acmSchema: SchemaInfo = {
  readOnly: new Set(['Id']),
  writeOnly: new Set(),
  createOnly: new Set(['DomainName', 'SubjectAlternativeNames', 'KeyAlgorithm']),
  readOnlyPaths: ['Id'],
  writeOnlyPaths: [],
  createOnlyPaths: ['DomainName', 'SubjectAlternativeNames', 'KeyAlgorithm'],
  defaults: {},
  defaultPaths: {},
};
const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();
const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'Cert',
  resourceType: 'AWS::CertificateManager::Certificate',
  physicalId: 'arn:aws:acm:us-east-1:123456789012:certificate/abc',
  declared,
});

describe('#1090 F1 ACM DomainValidationOptions readGap denylist', () => {
  it('a declared DomainValidationOptions absent from the live read stays readGap, not declared drift', () => {
    const findings = classifyResource(
      mk({
        DomainName: 'example.com',
        DomainValidationOptions: [{ DomainName: 'example.com', HostedZoneId: 'Z123' }],
      }),
      // the reader deliberately never projects DomainValidationOptions
      { DomainName: 'example.com', KeyAlgorithm: 'RSA_2048' },
      acmSchema
    );
    expect(
      findings.some((f) => f.tier === 'declared' && f.path === 'DomainValidationOptions')
    ).toBe(false);
    expect(findings.some((f) => f.tier === 'readGap' && f.path === 'DomainValidationOptions')).toBe(
      true
    );
  });
});

describe('#1090 F2 ACM KeyAlgorithm RSA_2048 default', () => {
  it('folds the undeclared KeyAlgorithm RSA_2048 to atDefault (ZERO first-run drift)', () => {
    const findings = classifyResource(
      mk({ DomainName: 'example.com' }),
      { DomainName: 'example.com', KeyAlgorithm: 'RSA_2048' },
      acmSchema
    );
    expect(tier(findings, 'atDefault')).toContain('KeyAlgorithm');
    expect(tier(findings, 'undeclared')).not.toContain('KeyAlgorithm');
  });
  it('surfaces a KeyAlgorithm that diverges from the RSA_2048 default — detection preserved', () => {
    const findings = classifyResource(
      mk({ DomainName: 'example.com' }),
      { DomainName: 'example.com', KeyAlgorithm: 'EC_prime256v1' },
      acmSchema
    );
    expect(tier(findings, 'undeclared')).toContain('KeyAlgorithm');
  });
});

// F3 lives in the reader: it subtracts the apex DomainName from the projected live SAN list.
const acm = mockClient(ACMClient);
const ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012';
const ctx = (declared: Record<string, unknown>) => ({
  physicalId: ARN,
  declared,
  region: 'us-east-1',
  accountId: '123456789012',
});
const read = (c: ReturnType<typeof ctx>) =>
  SDK_OVERRIDES['AWS::CertificateManager::Certificate'](c);

describe('#1090 F3 ACM SubjectAlternativeNames apex subtraction', () => {
  beforeEach(() => acm.reset());

  it('subtracts the implied apex DomainName so a clean multi-SAN cert folds to zero drift', async () => {
    // Template declares only the ADDITIONAL names; AWS returns the apex DomainName folded in.
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        CertificateArn: ARN,
        DomainName: 'example.com',
        SubjectAlternativeNames: ['example.com', 'www.example.com', 'api.example.com'],
        KeyAlgorithm: 'RSA_2048',
      },
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: [] });

    const out = await read(
      ctx({
        DomainName: 'example.com',
        SubjectAlternativeNames: ['www.example.com', 'api.example.com'],
      })
    );
    // apex 'example.com' subtracted → matches the declared list exactly (no drift).
    expect(out).toMatchObject({
      SubjectAlternativeNames: ['www.example.com', 'api.example.com'],
    });
  });

  it('surfaces a genuinely extra SAN even after apex subtraction — detection preserved', async () => {
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        CertificateArn: ARN,
        DomainName: 'example.com',
        // apex + declared www + an OUT-OF-BAND extra name the template never declared
        SubjectAlternativeNames: ['example.com', 'www.example.com', 'rogue.example.com'],
        KeyAlgorithm: 'RSA_2048',
      },
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: [] });

    const out = await read(
      ctx({ DomainName: 'example.com', SubjectAlternativeNames: ['www.example.com'] })
    );
    // only the single apex is subtracted; the rogue element stays → differs from declared.
    expect(out).toMatchObject({
      SubjectAlternativeNames: ['www.example.com', 'rogue.example.com'],
    });
  });

  it('keeps the live list verbatim when the declared SAN list DOES contain the apex DomainName', async () => {
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        CertificateArn: ARN,
        DomainName: 'example.com',
        SubjectAlternativeNames: ['example.com', 'www.example.com'],
        KeyAlgorithm: 'RSA_2048',
      },
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: [] });

    const out = await read(
      ctx({
        DomainName: 'example.com',
        SubjectAlternativeNames: ['example.com', 'www.example.com'],
      })
    );
    // the user intends the apex as a SAN → no subtraction, faithful compare.
    expect(out).toMatchObject({
      SubjectAlternativeNames: ['example.com', 'www.example.com'],
    });
  });
});

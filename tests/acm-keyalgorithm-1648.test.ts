// #1648 — ACM KeyAlgorithm hyphen/underscore spelling. DescribeCertificate returns a
// HYPHENATED spelling ("RSA-2048") for some certificates (era-/path-dependent) while the
// SDK enum + CFn schema spell it "RSA_2048" — so the #1090 KNOWN_DEFAULTS pin never
// matched and every such cert surfaced a permanent first-run [Potential Drift] (and a
// declared RSA_2048 would false-flag declared drift). Fix: readAcmCertificate
// canonicalizes the hyphenated live spelling onto the CFn enum spelling via an explicit
// map of the KNOWN enum members only; unknown values pass through untouched.
import {
  ACMClient,
  DescribeCertificateCommand,
  type KeyAlgorithm,
  ListTagsForCertificateCommand,
} from '@aws-sdk/client-acm';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { SDK_OVERRIDES } from '../src/read/overrides.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const acm = mockClient(ACMClient);
const ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012';
const read = (declared: Record<string, unknown>) =>
  SDK_OVERRIDES['AWS::CertificateManager::Certificate']({
    physicalId: ARN,
    declared,
    region: 'us-east-1',
    accountId: '123456789012',
  });
const mockCert = (keyAlgorithm: string) => {
  acm.on(DescribeCertificateCommand).resolves({
    Certificate: {
      CertificateArn: ARN,
      DomainName: 'example.com',
      // cast: the hyphenated live spellings under test are NOT members of the SDK's
      // KeyAlgorithm enum — that spelling gap IS the #1648 bug being exercised.
      KeyAlgorithm: keyAlgorithm as KeyAlgorithm,
    },
  });
  acm.on(ListTagsForCertificateCommand).resolves({ Tags: [] });
};

describe('#1648 readAcmCertificate KeyAlgorithm canonicalization', () => {
  beforeEach(() => acm.reset());

  it('canonicalizes the hyphenated RSA-2048 onto the CFn enum spelling RSA_2048', async () => {
    mockCert('RSA-2048');
    expect(await read({ DomainName: 'example.com' })).toMatchObject({
      KeyAlgorithm: 'RSA_2048',
    });
  });

  it('canonicalizes a hyphenated EC form (EC-prime256v1 -> EC_prime256v1)', async () => {
    mockCert('EC-prime256v1');
    expect(await read({ DomainName: 'example.com' })).toMatchObject({
      KeyAlgorithm: 'EC_prime256v1',
    });
  });

  it('passes the underscore spelling through unchanged', async () => {
    mockCert('RSA_2048');
    expect(await read({ DomainName: 'example.com' })).toMatchObject({
      KeyAlgorithm: 'RSA_2048',
    });
  });

  it('passes an UNKNOWN future value through untouched (never mangle unverified spellings)', async () => {
    mockCert('RSA-8192');
    expect(await read({ DomainName: 'example.com' })).toMatchObject({
      KeyAlgorithm: 'RSA-8192',
    });
  });
});

// End-to-end: the canonicalized reader output now hits the #1090 KNOWN_DEFAULTS RSA_2048
// pin, so a hyphen-era cert that declares no KeyAlgorithm folds to atDefault.
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
const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'Cert',
  resourceType: 'AWS::CertificateManager::Certificate',
  physicalId: ARN,
  declared,
});
const all = (fs: Finding[]) => fs.map((f) => `${f.tier}:${f.path}`).sort();

describe('#1648 canonicalized KeyAlgorithm reaches the KNOWN_DEFAULTS fold', () => {
  beforeEach(() => acm.reset());

  it('a hyphen-era cert with no declared KeyAlgorithm folds to atDefault — zero first-run drift', async () => {
    mockCert('RSA-2048');
    const live = (await read({ DomainName: 'example.com' })) as Record<string, unknown>;
    const findings = classifyResource(mk({ DomainName: 'example.com' }), live, acmSchema);
    // FULL tier:path list (#747): only the atDefault fold, no undeclared/declared leak.
    expect(all(findings)).toEqual(['atDefault:KeyAlgorithm']);
  });

  it('a declared RSA_2048 against a hyphen-echoing cert no longer false-flags declared drift', async () => {
    mockCert('RSA-2048');
    const live = (await read({ DomainName: 'example.com', KeyAlgorithm: 'RSA_2048' })) as Record<
      string,
      unknown
    >;
    const findings = classifyResource(
      mk({ DomainName: 'example.com', KeyAlgorithm: 'RSA_2048' }),
      live,
      acmSchema
    );
    expect(all(findings)).toEqual([]);
  });

  it('a genuinely different algorithm still surfaces — detection preserved', async () => {
    mockCert('EC-prime256v1');
    const live = (await read({ DomainName: 'example.com' })) as Record<string, unknown>;
    const findings = classifyResource(mk({ DomainName: 'example.com' }), live, acmSchema);
    expect(all(findings)).toEqual(['undeclared:KeyAlgorithm']);
  });
});

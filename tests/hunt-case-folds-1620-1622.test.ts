// 2026-07-14 hunt — three first-run/declared FP fixes, each live-probed:
//   #1620 ACM lowercases certificate domain names (request-certificate with
//     "CdkrdHunt-0714-Probe.Example.Com" describes back all-lowercase, SANs too)
//     -> CASE_INSENSITIVE_PATHS DomainName + SubjectAlternativeNames.*, and the
//     reader's implied-apex SAN subtraction goes case-insensitive.
//   #1621 DAX lowercases parameter-group / subnet-group names (raw create echoes
//     "cdkrdhunt-mixed-daxpg"), reachable via CFn's legacy provider (no CC CREATE
//     handler to reject) -> CASE_INSENSITIVE_PATHS entries.
//   #1622 a barest AppConfig ConfigurationProfile reads back the undeclared
//     Type "AWS.Freeform" -> KNOWN_DEFAULTS tier-1 pin.
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

const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();

const mk = (
  resourceType: string,
  declared: Record<string, unknown>,
  physicalId = 'phys'
): DesiredResource => ({ logicalId: 'Res', resourceType, declared, physicalId });

describe('#1620 ACM Certificate lowercase-stored domain names', () => {
  const declared = {
    DomainName: 'MyApp.Example.Com',
    SubjectAlternativeNames: ['Www.Example.Com'],
  };

  it('a pure case-fold echo of DomainName + SANs is not declared drift', () => {
    const f = classifyResource(
      mk('AWS::CertificateManager::Certificate', declared),
      { DomainName: 'myapp.example.com', SubjectAlternativeNames: ['www.example.com'] },
      emptySchema
    );
    expect(tier(f, 'declared')).toEqual([]);
  });

  it('a domain differing beyond case still surfaces as declared drift', () => {
    const f = classifyResource(
      mk('AWS::CertificateManager::Certificate', declared),
      { DomainName: 'other.example.com', SubjectAlternativeNames: ['www.example.com'] },
      emptySchema
    );
    expect(tier(f, 'declared')).toEqual(['DomainName']);
  });
});

describe('#1620 ACM reader apex-SAN subtraction is case-insensitive', () => {
  const acm = mockClient(ACMClient);
  const ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012';
  const read = (declared: Record<string, unknown>) =>
    SDK_OVERRIDES['AWS::CertificateManager::Certificate']({
      physicalId: ARN,
      declared,
      region: 'us-east-1',
      accountId: '123456789012',
    });

  beforeEach(() => acm.reset());

  it('subtracts the lowercased implied apex for a mixed-case declared DomainName', async () => {
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        CertificateArn: ARN,
        // ACM stores everything lowercased regardless of the declared case.
        DomainName: 'myapp.example.com',
        SubjectAlternativeNames: ['myapp.example.com', 'www.example.com'],
        KeyAlgorithm: 'RSA_2048',
      },
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: [] });

    const out = await read({
      DomainName: 'MyApp.Example.Com',
      SubjectAlternativeNames: ['Www.Example.Com'],
    });
    // the implied apex is subtracted despite the case difference; only the real SAN stays.
    expect(out).toMatchObject({ SubjectAlternativeNames: ['www.example.com'] });
  });

  it('keeps the live list verbatim when the declared SANs contain the apex in ANY case', async () => {
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        CertificateArn: ARN,
        DomainName: 'myapp.example.com',
        SubjectAlternativeNames: ['myapp.example.com', 'www.example.com'],
        KeyAlgorithm: 'RSA_2048',
      },
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: [] });

    const out = await read({
      DomainName: 'MyApp.Example.Com',
      SubjectAlternativeNames: ['MyApp.Example.Com', 'Www.Example.Com'],
    });
    // the user intends the apex as a SAN → no subtraction, faithful compare.
    expect(out).toMatchObject({
      SubjectAlternativeNames: ['myapp.example.com', 'www.example.com'],
    });
  });
});

describe('#1621 DAX lowercase-stored group names', () => {
  it('a pure case-fold echo of ParameterGroupName is not declared drift', () => {
    const f = classifyResource(
      mk('AWS::DAX::ParameterGroup', { ParameterGroupName: 'CdkrdHunt-Mixed-DaxPG' }),
      { ParameterGroupName: 'cdkrdhunt-mixed-daxpg' },
      emptySchema
    );
    expect(tier(f, 'declared')).toEqual([]);
  });

  it('a pure case-fold echo of SubnetGroupName is not declared drift', () => {
    const f = classifyResource(
      mk('AWS::DAX::SubnetGroup', {
        SubnetGroupName: 'CdkrdHunt-Mixed-DaxSG',
        SubnetIds: ['subnet-1'],
      }),
      { SubnetGroupName: 'cdkrdhunt-mixed-daxsg', SubnetIds: ['subnet-1'] },
      emptySchema
    );
    expect(tier(f, 'declared')).toEqual([]);
  });

  it('a name differing beyond case still surfaces as declared drift', () => {
    const f = classifyResource(
      mk('AWS::DAX::ParameterGroup', { ParameterGroupName: 'CdkrdHunt-Mixed-DaxPG' }),
      { ParameterGroupName: 'cdkrdhunt-other' },
      emptySchema
    );
    expect(tier(f, 'declared')).toEqual(['ParameterGroupName']);
  });
});

describe('#1622 AppConfig ConfigurationProfile undeclared Type default', () => {
  const declared = { ApplicationId: 'app-1', Name: 'profile', LocationUri: 'hosted' };

  it('folds the undeclared Type "AWS.Freeform" to atDefault (ZERO first-run drift)', () => {
    const f = classifyResource(
      mk('AWS::AppConfig::ConfigurationProfile', declared),
      { ...declared, Type: 'AWS.Freeform' },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('Type');
    expect(tier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces a Type that diverges from the freeform default — detection preserved', () => {
    const f = classifyResource(
      mk('AWS::AppConfig::ConfigurationProfile', declared),
      { ...declared, Type: 'AWS.AppConfig.FeatureFlags' },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toEqual(['Type']);
  });
});

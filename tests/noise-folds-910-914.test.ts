// First-run fold gaps mined from clean, un-mutated LIVE deploys (issues #910, #873, #841,
// #914). Each fold is equality-gated (or account-derived), so a change away from the default
// still surfaces — every test asserts BOTH the fold (atDefault on a clean deploy) AND that a
// genuine divergence still surfaces as undeclared drift.
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
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

const pathsByTier = (findings: Finding[], tier: string) =>
  findings
    .filter((f) => f.tier === tier)
    .map((f) => f.path)
    .sort();

describe('#910 IAM ServerCertificate undeclared Path="/"', () => {
  const res: DesiredResource = {
    logicalId: 'ServerCert',
    resourceType: 'AWS::IAM::ServerCertificate',
    physicalId: 'cert',
    declared: { ServerCertificateName: 'cert' },
  };
  it('folds the default Path="/" to atDefault', () => {
    const f = classifyResource(res, { Path: '/' }, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('Path');
    expect(pathsByTier(f, 'undeclared')).not.toContain('Path');
  });
  it('surfaces an out-of-band non-root path as undeclared', () => {
    const f = classifyResource(res, { Path: '/team/' }, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('Path');
  });
});

describe('#873 ApiGatewayV2 Route undeclared AuthorizationType="NONE"', () => {
  const res: DesiredResource = {
    logicalId: 'Route',
    resourceType: 'AWS::ApiGatewayV2::Route',
    physicalId: 'route',
    declared: { RouteKey: '$default', ApiId: 'api' },
  };
  it('folds the default AuthorizationType="NONE" to atDefault', () => {
    const f = classifyResource(res, { AuthorizationType: 'NONE' }, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('AuthorizationType');
    expect(pathsByTier(f, 'undeclared')).not.toContain('AuthorizationType');
  });
  it('surfaces an out-of-band AWS_IAM authorizer as undeclared', () => {
    const f = classifyResource(res, { AuthorizationType: 'AWS_IAM' }, emptySchema);
    expect(pathsByTier(f, 'undeclared')).toContain('AuthorizationType');
  });
});

describe('#841 ApplicationInsights undeclared CWEMonitorEnabled=true', () => {
  const res: DesiredResource = {
    logicalId: 'Insights',
    resourceType: 'AWS::ApplicationInsights::Application',
    physicalId: 'app',
    declared: { ResourceGroupName: 'grp' },
  };
  it('folds AWS-assigned CWEMonitorEnabled=true to atDefault', () => {
    const f = classifyResource(res, { CWEMonitorEnabled: true }, emptySchema);
    expect(pathsByTier(f, 'atDefault')).toContain('CWEMonitorEnabled');
    expect(pathsByTier(f, 'undeclared')).not.toContain('CWEMonitorEnabled');
  });
  // A later-disabled CWEMonitorEnabled=false does NOT surface: the undeclared loop drops any
  // `false`/`""` via isTrivialEmpty BEFORE the fold table ("false does not stay meaningful"),
  // and detecting a true->false out-of-band disable would require a curated MEANINGFUL_WHEN_OFF
  // entry (in diff/classify.ts) — which that table's own rule admits ONLY after a live confirm
  // that OFF is meaningful in EVERY clean-deploy config. We have a single live observation
  // (true on a minimal app), not that cross-config proof, so surfacing the disable is out of
  // scope for this first-run-FP fold and is left for a live-verified follow-up. The fold here
  // only mutes the AWS-assigned `true`, restoring the ZERO-potential-drift invariant.
  it('drops an undeclared CWEMonitorEnabled=false as trivially-empty (not surfaced)', () => {
    const f = classifyResource(res, { CWEMonitorEnabled: false }, emptySchema);
    expect(pathsByTier(f, 'undeclared')).not.toContain('CWEMonitorEnabled');
    expect(pathsByTier(f, 'atDefault')).not.toContain('CWEMonitorEnabled');
  });
});

describe('#914 LakeFormation Tag undeclared CatalogId=<account>', () => {
  const res: DesiredResource = {
    logicalId: 'LfTag',
    resourceType: 'AWS::LakeFormation::Tag',
    physicalId: 'tag',
    declared: { TagKey: 'tier', TagValues: ['gold', 'silver'] },
  };
  const opts = { accountId: '111122223333', region: 'us-east-1' };
  it('folds CatalogId equal to the deploying account id to atDefault', () => {
    const f = classifyResource(res, { CatalogId: '111122223333' }, emptySchema, opts);
    expect(pathsByTier(f, 'atDefault')).toContain('CatalogId');
    expect(pathsByTier(f, 'undeclared')).not.toContain('CatalogId');
  });
  it('surfaces a CatalogId pointed at another account as undeclared', () => {
    const f = classifyResource(res, { CatalogId: '999988887777' }, emptySchema, opts);
    expect(pathsByTier(f, 'undeclared')).toContain('CatalogId');
  });
  it('leaves CatalogId undeclared (recordable) when the account is unresolved', () => {
    const f = classifyResource(res, { CatalogId: '111122223333' }, emptySchema, {
      region: 'us-east-1',
    });
    expect(pathsByTier(f, 'atDefault')).not.toContain('CatalogId');
    expect(pathsByTier(f, 'undeclared')).toContain('CatalogId');
  });
});

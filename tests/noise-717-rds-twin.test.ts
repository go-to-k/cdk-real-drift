// #717 — two RDS-family undeclared-default fold gaps of the twin-type class (found by a
// never-undeclared corpus scan). Both are first-run false positives: an undeclared value
// AWS assigns at creation that must fold to atDefault, not surface as [Potential Drift].
// Both fold as tier-1 equality-gated constants (KNOWN_DEFAULTS). Each test asserts the fold
// to atDefault AND that a genuine divergence still surfaces (detection preserved).
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
const tier = (fs: Finding[], t: string) =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();
const mk = (
  resourceType: string,
  declared: Record<string, unknown>,
  physicalId = 'phys'
): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId,
  declared,
});

// A — Aurora's default backup retention (1 day), the twin of the already-folded
// AWS::DocDB::DBCluster.BackupRetentionPeriod: 1.
describe('#717 RDS::DBCluster BackupRetentionPeriod (equality-gated constant)', () => {
  const res = mk('AWS::RDS::DBCluster', { Engine: 'aurora-mysql' });
  it('folds the 1-day Aurora default on a clean deploy', () => {
    const f = classifyResource(res, { BackupRetentionPeriod: 1 }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('BackupRetentionPeriod');
    expect(tier(f, 'undeclared')).not.toContain('BackupRetentionPeriod');
  });
  it('surfaces a longer retention out of band — detection preserved', () => {
    const f = classifyResource(res, { BackupRetentionPeriod: 7 }, emptySchema);
    expect(tier(f, 'undeclared')).toContain('BackupRetentionPeriod');
  });
});

// B — RDS Proxy's default idle client connection timeout (1800 s / 30 min).
describe('#717 RDS::DBProxy IdleClientTimeout (equality-gated constant)', () => {
  const res = mk('AWS::RDS::DBProxy', {
    DBProxyName: 'p',
    EngineFamily: 'MYSQL',
    RoleArn: 'arn:aws:iam::123456789012:role/r',
    Auth: [
      {
        AuthScheme: 'SECRETS',
        SecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:s',
      },
    ],
    VpcSubnetIds: ['subnet-1'],
  });
  it('folds the 1800s (30 min) service default on a clean deploy', () => {
    const f = classifyResource(res, { IdleClientTimeout: 1800 }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('IdleClientTimeout');
    expect(tier(f, 'undeclared')).not.toContain('IdleClientTimeout');
  });
  it('surfaces a changed timeout out of band — detection preserved', () => {
    const f = classifyResource(res, { IdleClientTimeout: 900 }, emptySchema);
    expect(tier(f, 'undeclared')).toContain('IdleClientTimeout');
  });
});

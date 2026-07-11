// RDS::DBInstance first-run undeclared defaults on a MINIMAL, PROVISIONED (non-Aurora) instance.
// The existing RDS folds were driven by an Aurora/DBCluster-centric corpus, so a bare
// `AWS::RDS::DBInstance` (engine only, no version / storage / retention declared) still surfaced
// StorageType / BackupRetentionPeriod / EngineVersion as [Potential Drift] on a clean deploy
// (live-confirmed 2026-07-11 on a fresh mysql db.t3.micro). This is the regression test the corpus
// lacked. Each case asserts the fold to atDefault AND that a genuine divergence still surfaces.
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
const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'Db',
  resourceType: 'AWS::RDS::DBInstance',
  physicalId: 'db-1',
  declared,
});

describe('RDS::DBInstance minimal provisioned first-run folds (reach ZERO)', () => {
  // Exactly what a fresh `CfnDBInstance({ engine: 'mysql', dbInstanceClass, allocatedStorage,
  // masterUsername, masterUserPassword })` reads back — nothing about storage / retention / version.
  const declared = { Engine: 'mysql' };
  const live = {
    Engine: 'mysql',
    StorageType: 'gp2',
    BackupRetentionPeriod: 1,
    EngineVersion: '8.4.8',
  };
  it('folds StorageType / BackupRetentionPeriod / EngineVersion on a clean mysql deploy', () => {
    const f = classifyResource(mk(declared), structuredClone(live), emptySchema);
    expect(tier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['StorageType', 'BackupRetentionPeriod', 'EngineVersion'])
    );
    expect(tier(f, 'undeclared')).toEqual([]);
  });

  it('StorageType is engine-derived gp2 for provisioned engines (equality-gated)', () => {
    for (const engine of ['mysql', 'postgres', 'mariadb', 'oracle-se2', 'sqlserver-ex']) {
      const f = classifyResource(
        mk({ Engine: engine }),
        { Engine: engine, StorageType: 'gp2' },
        emptySchema
      );
      expect(tier(f, 'atDefault')).toContain('StorageType');
    }
  });

  it('Aurora still reads back StorageType "aurora" (unchanged)', () => {
    const f = classifyResource(
      mk({ Engine: 'aurora-mysql' }),
      { Engine: 'aurora-mysql', StorageType: 'aurora' },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('StorageType');
  });

  it('SURFACES an out-of-band StorageType switch to io1 — detection preserved', () => {
    const f = classifyResource(mk(declared), { Engine: 'mysql', StorageType: 'io1' }, emptySchema);
    expect(tier(f, 'undeclared')).toContain('StorageType');
    expect(tier(f, 'atDefault')).not.toContain('StorageType');
  });

  it('SURFACES a non-default BackupRetentionPeriod (7 days) — detection preserved', () => {
    const f = classifyResource(
      mk(declared),
      { Engine: 'mysql', BackupRetentionPeriod: 7 },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain('BackupRetentionPeriod');
    expect(tier(f, 'atDefault')).not.toContain('BackupRetentionPeriod');
  });

  it('EngineVersion is value-independent when undeclared (GA version AWS moves) but a DECLARED version is compared', () => {
    // Undeclared → any GA patch folds.
    const f = classifyResource(
      mk(declared),
      { Engine: 'mysql', EngineVersion: '8.0.39' },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('EngineVersion');
    // Declared partial track "8.0" matches the live concrete "8.0.42" (VERSION_PREFIX_PATHS), no drift.
    const declOk = classifyResource(
      mk({ Engine: 'mysql', EngineVersion: '8.0' }),
      { Engine: 'mysql', EngineVersion: '8.0.42' },
      emptySchema
    );
    expect(tier(declOk, 'declared')).not.toContain('EngineVersion');
    // A declared version on a DIFFERENT track surfaces as declared drift.
    const declDrift = classifyResource(
      mk({ Engine: 'mysql', EngineVersion: '8.0' }),
      { Engine: 'mysql', EngineVersion: '5.7.44' },
      emptySchema
    );
    expect(tier(declDrift, 'declared')).toContain('EngineVersion');
  });
});

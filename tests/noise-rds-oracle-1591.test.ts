// #1591 — barest oracle-se2 DBInstance first-run FPs, live-proven on rds-oracle-min
// (us-east-1, 2026-07-14): Oracle materializes CharacterSetName "AL32UTF8",
// NcharCharacterSetName "AL16UTF16", and the default SID DBName "ORCL" when
// undeclared. All three fold via ENGINE_DEFAULTS oracle arms (engine-derived,
// equality-gated) — a non-default charset / SID still surfaces, and the
// non-oracle engines are unaffected (they create no default database).
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { Finding, SchemaInfo } from '../src/types.js';

const rdsSchema: SchemaInfo = {
  readOnly: new Set(['Endpoint']),
  writeOnly: new Set(['MasterUserPassword']),
  createOnly: new Set(['Engine']),
  readOnlyPaths: ['Endpoint'],
  writeOnlyPaths: ['MasterUserPassword'],
  createOnlyPaths: ['Engine'],
  defaults: {},
  defaultPaths: {},
};

const tier = (findings: Finding[], t: string) =>
  findings
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();

const mk = (engine: string, live: Record<string, unknown>) =>
  classifyResource(
    {
      logicalId: 'HuntOracle',
      resourceType: 'AWS::RDS::DBInstance',
      physicalId: 'huntoracle',
      declared: { Engine: engine, DBInstanceClass: 'db.t3.small' },
    },
    { Engine: engine, DBInstanceClass: 'db.t3.small', ...live },
    rdsSchema
  );

describe('#1591 DBInstance oracle arms: CharacterSetName + NcharCharacterSetName + DBName fold', () => {
  it('the three oracle creation defaults fold atDefault', () => {
    const f = mk('oracle-se2', {
      CharacterSetName: 'AL32UTF8',
      NcharCharacterSetName: 'AL16UTF16',
      DBName: 'ORCL',
    });
    expect(tier(f, 'undeclared')).toEqual([]);
    expect(tier(f, 'atDefault')).toEqual(['CharacterSetName', 'DBName', 'NcharCharacterSetName']);
  });

  it('a non-default charset / SID still surfaces (equality gate kept)', () => {
    expect(tier(mk('oracle-se2', { CharacterSetName: 'WE8ISO8859P1' }), 'undeclared')).toEqual([
      'CharacterSetName',
    ]);
    expect(tier(mk('oracle-ee', { DBName: 'PRODDB' }), 'undeclared')).toEqual(['DBName']);
  });

  it('the sqlserver collation arm is unchanged and non-oracle engines do not fold ORCL', () => {
    expect(
      tier(mk('sqlserver-ex', { CharacterSetName: 'SQL_Latin1_General_CP1_CI_AS' }), 'atDefault')
    ).toEqual(['CharacterSetName']);
    // a hypothetical DBName echo on mysql is NOT folded by the oracle arm
    expect(tier(mk('mysql', { DBName: 'ORCL' }), 'undeclared')).toEqual(['DBName']);
  });
});

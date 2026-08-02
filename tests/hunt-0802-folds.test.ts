// Declared-tier FP folds from the 2026-08-02 hunt. Each fold masks ONLY a
// normalization-level divergence — every test asserts BOTH the fold (clean on the
// live-observed echo shape) AND that a genuine divergence still surfaces.
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

const declaredPaths = (findings: Finding[]) =>
  findings
    .filter((f) => f.tier === 'declared')
    .map((f) => f.path)
    .sort();

describe('#1711 Route53 CidrCollection Locations[].CidrList is a set', () => {
  const res = (cidrs: string[]): DesiredResource => ({
    logicalId: 'CidrColl',
    resourceType: 'AWS::Route53::CidrCollection',
    physicalId: 'coll-1',
    declared: {
      Name: 'hunt',
      Locations: [{ LocationName: 'loc1', CidrList: cidrs }],
    },
  });
  it('folds the service-sorted echo of an identical CIDR set', () => {
    const f = classifyResource(
      res(['10.0.3.0/24', '10.0.1.0/24']),
      {
        Name: 'hunt',
        Locations: [{ LocationName: 'loc1', CidrList: ['10.0.1.0/24', '10.0.3.0/24'] }],
      },
      emptySchema
    );
    expect(declaredPaths(f)).toEqual([]);
  });
  it('still surfaces a genuine CIDR membership change', () => {
    const f = classifyResource(
      res(['10.0.3.0/24', '10.0.1.0/24']),
      {
        Name: 'hunt',
        Locations: [{ LocationName: 'loc1', CidrList: ['10.0.1.0/24', '10.0.9.0/24'] }],
      },
      emptySchema
    );
    expect(declaredPaths(f)).not.toEqual([]);
  });
});

describe('#1712 mixed-case references to lowercase-stored group names', () => {
  const res: DesiredResource = {
    logicalId: 'Db',
    resourceType: 'AWS::RDS::DBInstance',
    physicalId: 'db-1',
    declared: {
      Engine: 'mysql',
      DBInstanceClass: 'db.t4g.micro',
      DBParameterGroupName: 'CdkrdHunt-Mixed-DPG',
      DBSubnetGroupName: 'CdkrdHunt-Mixed-SNG',
    },
  };
  it('folds the lowercased stored-name echoes on the consumer', () => {
    const f = classifyResource(
      res,
      {
        Engine: 'mysql',
        DBInstanceClass: 'db.t4g.micro',
        DBParameterGroupName: 'cdkrdhunt-mixed-dpg',
        DBSubnetGroupName: 'cdkrdhunt-mixed-sng',
      },
      emptySchema
    );
    expect(declaredPaths(f)).toEqual([]);
  });
  it('still surfaces a genuinely different referenced group', () => {
    const f = classifyResource(
      res,
      {
        Engine: 'mysql',
        DBInstanceClass: 'db.t4g.micro',
        DBParameterGroupName: 'some-other-group',
        DBSubnetGroupName: 'cdkrdhunt-mixed-sng',
      },
      emptySchema
    );
    expect(declaredPaths(f)).toContain('DBParameterGroupName');
  });
});

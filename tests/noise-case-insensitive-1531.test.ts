// #1531: RDS stores its parameter-group / option-group / subnet-group NAMES "as a lowercase
// string" (the same family as the DBInstanceIdentifier / DBClusterIdentifier entries), so a
// mixed-case declaration reads back all-lowercase forever — a permanent declared-tier FP that
// survives record and never converges. The #1507 hunt live-captured exactly this FP into three
// corpus cases (their `expected` is corrected in this PR). These tests pin the
// CASE_INSENSITIVE_PATHS additions: a case-only difference folds; a real rename still surfaces.
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

// type → [name property, mixed-case declared, lowercase live echo]
const CASES: [string, string, string, string][] = [
  [
    'AWS::RDS::DBParameterGroup',
    'DBParameterGroupName',
    'CdkrdHunt-Mixed-PG',
    'cdkrdhunt-mixed-pg',
  ],
  [
    'AWS::RDS::DBClusterParameterGroup',
    'DBClusterParameterGroupName',
    'CdkrdHunt-Mixed-CPG',
    'cdkrdhunt-mixed-cpg',
  ],
  ['AWS::RDS::OptionGroup', 'OptionGroupName', 'CdkrdHunt-Mixed-OG', 'cdkrdhunt-mixed-og'],
  ['AWS::RDS::DBSubnetGroup', 'DBSubnetGroupName', 'CdkrdHunt-Mixed-SNG', 'cdkrdhunt-mixed-sng'],
  ['AWS::Neptune::DBParameterGroup', 'Name', 'CdkrdHunt-Mixed-NPG', 'cdkrdhunt-mixed-npg'],
  ['AWS::Neptune::DBClusterParameterGroup', 'Name', 'CdkrdHunt-Mixed-NCPG', 'cdkrdhunt-mixed-ncpg'],
  ['AWS::DocDB::DBClusterParameterGroup', 'Name', 'CdkrdHunt-Mixed-DCPG', 'cdkrdhunt-mixed-dcpg'],
];

describe('#1531 lowercase-stored name family folds case-only echoes', () => {
  for (const [type, prop, declared, live] of CASES) {
    it(`${type}.${prop}: mixed-case declaration matches its lowercase echo`, () => {
      const res: DesiredResource = {
        logicalId: 'R',
        resourceType: type,
        physicalId: live,
        declared: { [prop]: declared, Description: 'd' },
      };
      const f = classifyResource(res, { [prop]: live, Description: 'd' }, emptySchema);
      expect(declaredPaths(f)).toEqual([]);
    });
  }

  it('a genuinely different name still surfaces as declared drift', () => {
    const res: DesiredResource = {
      logicalId: 'R',
      resourceType: 'AWS::RDS::DBParameterGroup',
      physicalId: 'other-name',
      declared: { DBParameterGroupName: 'CdkrdHunt-Mixed-PG', Description: 'd' },
    };
    const f = classifyResource(
      res,
      { DBParameterGroupName: 'other-name', Description: 'd' },
      emptySchema
    );
    expect(declaredPaths(f)).toEqual(['DBParameterGroupName']);
  });
});

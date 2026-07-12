// #1499 — an AWS::RDS::DBInstance that omits PubliclyAccessible reads back the value RDS derives
// at creation from its subnet-group/VPC placement: `true` for a default-VPC instance (subnet group
// "default"), `false` for a custom subnet-group placement. classify derives + equality-gates the
// undeclared value from the effective DBSubnetGroupName (declared preferred, else the live echo).
// Assert the clean-deploy fold to atDefault on BOTH branches AND that a flip away from the derived
// value still surfaces as undeclared (out-of-band `modify-db-instance --publicly-accessible`
// detection preserved — a security-relevant, OOB-mutable boundary).
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
  physicalId: 'cdkrd-db-1499',
  declared,
});

describe('#1499 RDS DBInstance PubliclyAccessible derived from DBSubnetGroupName placement', () => {
  it('folds true on a default-VPC instance (live DBSubnetGroupName "default")', () => {
    const f = classifyResource(
      mk({ Engine: 'postgres' }),
      { DBSubnetGroupName: 'default', PubliclyAccessible: true },
      emptySchema,
      {}
    );
    expect(tier(f, 'atDefault')).toContain('PubliclyAccessible');
    expect(tier(f, 'undeclared')).not.toContain('PubliclyAccessible');
  });

  it('folds false on a custom subnet-group instance (the common production shape)', () => {
    const f = classifyResource(
      mk({ Engine: 'postgres' }),
      { DBSubnetGroupName: 'my-private-subnet-group', PubliclyAccessible: false },
      emptySchema,
      {}
    );
    expect(tier(f, 'atDefault')).toContain('PubliclyAccessible');
    expect(tier(f, 'undeclared')).not.toContain('PubliclyAccessible');
  });

  // The SECURITY-DANGEROUS transition (a private/custom-VPC instance made public) is the one the
  // derived fold must not hide — a live `true` never matches the custom-VPC derived `false`, so it
  // surfaces. The opposite direction (a default-VPC instance disabled to `false` = hardening) is a
  // bare undeclared `false`, swallowed by isTrivialEmpty like every off-state that is not a curated
  // MEANINGFUL_WHEN_OFF path (the #660 class); PubliclyAccessible is a DERIVED default (not a
  // KNOWN_DEFAULTS constant), so it is out of scope for that mechanism and the safe direction.
  it('does NOT surface a default-VPC instance disabled to false (safe direction, #660 trivial-empty)', () => {
    const f = classifyResource(
      mk({ Engine: 'postgres' }),
      { DBSubnetGroupName: 'default', PubliclyAccessible: false },
      emptySchema,
      {}
    );
    expect(tier(f, 'undeclared')).not.toContain('PubliclyAccessible');
    expect(tier(f, 'atDefault')).not.toContain('PubliclyAccessible');
  });

  it('surfaces an out-of-band flip to true on a custom subnet-group instance (internet exposure)', () => {
    const f = classifyResource(
      mk({ Engine: 'postgres' }),
      { DBSubnetGroupName: 'my-private-subnet-group', PubliclyAccessible: true },
      emptySchema,
      {}
    );
    expect(tier(f, 'undeclared')).toContain('PubliclyAccessible');
    expect(tier(f, 'atDefault')).not.toContain('PubliclyAccessible');
  });

  it('derives from the DECLARED DBSubnetGroupName when present (declared preferred)', () => {
    const f = classifyResource(
      mk({ Engine: 'postgres', DBSubnetGroupName: 'my-private-subnet-group' }),
      { DBSubnetGroupName: 'my-private-subnet-group', PubliclyAccessible: false },
      emptySchema,
      {}
    );
    expect(tier(f, 'atDefault')).toContain('PubliclyAccessible');
    expect(tier(f, 'undeclared')).not.toContain('PubliclyAccessible');
  });
});

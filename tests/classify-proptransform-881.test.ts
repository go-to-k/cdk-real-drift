// #881 — registry `propertyTransform` (JSONata) is honored: the SERVICE transforms a declared
// value before storing it, so the live read differs from the template value even though nothing
// drifted. classify evaluates transform(declared) via jsonata and folds the resulting false
// `declared` finding when it deep-equals live (the exact model CloudFormation's own drift
// detection uses). STRICTLY equality-gated + FAIL-OPEN, so it can only suppress a declared FP —
// a genuinely different live value never equals the transform, so real drift still surfaces.
//
// Each fold test would FAIL without the gate (the declared value != live → a `declared` finding);
// the NEGATIVE test proves detection is preserved (no false negative).
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

const baseSchema: Omit<SchemaInfo, 'propertyTransforms'> = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};
const schema = (propertyTransforms: Record<string, string>): SchemaInfo => ({
  ...baseSchema,
  propertyTransforms,
});
const declaredPaths = (fs: Finding[]): string[] =>
  fs
    .filter((f) => f.tier === 'declared')
    .map((f) => f.path)
    .sort();
const mk = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId: 'phys',
  declared,
});

describe('#881 propertyTransform folds service-transformed declared echoes', () => {
  it('Lambda EventSourceMapping StartingPositionTimestamp — live = declared × 1000 (s→ms)', () => {
    const res = mk('AWS::Lambda::EventSourceMapping', { StartingPositionTimestamp: 1_700_000_000 });
    const s = schema({ StartingPositionTimestamp: 'StartingPositionTimestamp * 1000' });
    // live echoes milliseconds — WITHOUT the fold this is a `declared` FP
    const f = classifyResource(res, { StartingPositionTimestamp: 1_700_000_000_000 }, s);
    expect(declaredPaths(f)).not.toContain('StartingPositionTimestamp');
  });

  it('EKS Addon ConfigurationValues — service strips a trailing newline', () => {
    const res = mk('AWS::EKS::Addon', { ConfigurationValues: '{"replicaCount":2}\n' });
    const s = schema({ ConfigurationValues: "$replace(ConfigurationValues, /\\n$/, '')" });
    const f = classifyResource(res, { ConfigurationValues: '{"replicaCount":2}' }, s);
    expect(declaredPaths(f)).not.toContain('ConfigurationValues');
  });

  it('Cassandra Table ColumnType — $lowercase on an array-element path (numeric index → * key)', () => {
    const res = mk('AWS::Cassandra::Table', {
      PartitionKeyColumns: [{ ColumnName: 'id', ColumnType: 'TEXT' }],
    });
    const s = schema({ 'PartitionKeyColumns.*.ColumnType': '$lowercase(ColumnType)' });
    // live lowercases the type — WITHOUT the fold this is a nested `declared` FP
    const f = classifyResource(
      res,
      { PartitionKeyColumns: [{ ColumnName: 'id', ColumnType: 'text' }] },
      s
    );
    expect(declaredPaths(f)).not.toContain('PartitionKeyColumns.0.ColumnType');
  });

  it('AmazonMQ Broker MaintenanceWindowStartTime.DayOfWeek — $uppercase referenced from ROOT', () => {
    const res = mk('AWS::AmazonMQ::Broker', {
      MaintenanceWindowStartTime: { DayOfWeek: 'monday', TimeOfDay: '22:45' },
    });
    const s = schema({
      'MaintenanceWindowStartTime.DayOfWeek': '$uppercase(MaintenanceWindowStartTime.DayOfWeek)',
    });
    const f = classifyResource(
      res,
      { MaintenanceWindowStartTime: { DayOfWeek: 'MONDAY', TimeOfDay: '22:45' } },
      s
    );
    expect(declaredPaths(f)).not.toContain('MaintenanceWindowStartTime.DayOfWeek');
  });

  it('honors a ` $OR `-joined alternative (Route53 HostedZone Name trailing dot)', () => {
    const res = mk('AWS::Route53::HostedZone', { Name: 'example.com' });
    // The real HostedZone transform is `$join([Name, "."]) $OR $join([Name, "test"])`.
    const s = schema({ Name: '$join([Name, ".."]) $OR $join([Name, "."])' });
    const f = classifyResource(res, { Name: 'example.com.' }, s);
    expect(declaredPaths(f)).not.toContain('Name');
  });

  it('NEGATIVE: a genuinely different live value at a transform path STILL surfaces as drift', () => {
    const res = mk('AWS::Lambda::EventSourceMapping', { StartingPositionTimestamp: 1_700_000_000 });
    const s = schema({ StartingPositionTimestamp: 'StartingPositionTimestamp * 1000' });
    // live is NOT declared×1000 — a real out-of-band change; transform(declared) != live → surfaces
    const f = classifyResource(res, { StartingPositionTimestamp: 9_999_999_999_999 }, s);
    expect(declaredPaths(f)).toContain('StartingPositionTimestamp');
  });

  it('FAIL-OPEN: a malformed / unsupported JSONata expression never throws and does not fold', () => {
    const res = mk('AWS::Lambda::EventSourceMapping', { StartingPositionTimestamp: 1_700_000_000 });
    const s = schema({ StartingPositionTimestamp: 'this is (not valid jsonata $$$' });
    const f = classifyResource(res, { StartingPositionTimestamp: 1_700_000_000_000 }, s);
    // cannot transform → the divergence surfaces unchanged (no crash, no silent suppression)
    expect(declaredPaths(f)).toContain('StartingPositionTimestamp');
  });

  it('CONTROL: with NO propertyTransform, the same s→ms divergence surfaces as declared drift', () => {
    const res = mk('AWS::Lambda::EventSourceMapping', { StartingPositionTimestamp: 1_700_000_000 });
    const f = classifyResource(res, { StartingPositionTimestamp: 1_700_000_000_000 }, baseSchema);
    expect(declaredPaths(f)).toContain('StartingPositionTimestamp');
  });

  // #1304: a template that parameterizes StartingPositionTimestamp carries the declared leaf as the
  // STRING "1700000000" (resolveRef reads DescribeStacks parameter values, which are ALWAYS strings,
  // even for a `Type: Number` parameter). The `... * 1000` transform then throws JSONata T2001 on
  // the string → fails open → the s→ms declared FP is back. The Number()-coerced retry folds it.
  it('#1304 StartingPositionTimestamp declared as a NUMERIC STRING (parameterized Ref) still folds', () => {
    const res = mk('AWS::Lambda::EventSourceMapping', {
      StartingPositionTimestamp: '1700000000',
    });
    const s = schema({ StartingPositionTimestamp: 'StartingPositionTimestamp * 1000' });
    // live echoes milliseconds; declared is the string form → WITHOUT the coerced retry this is a FP
    const f = classifyResource(res, { StartingPositionTimestamp: 1_700_000_000_000 }, s);
    expect(declaredPaths(f)).not.toContain('StartingPositionTimestamp');
  });

  it('#1304 NEGATIVE: a numeric-string declared with a genuinely different live STILL surfaces', () => {
    const res = mk('AWS::Lambda::EventSourceMapping', {
      StartingPositionTimestamp: '1700000000',
    });
    const s = schema({ StartingPositionTimestamp: 'StartingPositionTimestamp * 1000' });
    // coerced Number("1700000000") * 1000 != live → real drift is preserved
    const f = classifyResource(res, { StartingPositionTimestamp: 9_999_999_999_999 }, s);
    expect(declaredPaths(f)).toContain('StartingPositionTimestamp');
  });

  // #1304 reverse direction: the GameLift Fleet AnywhereConfiguration.Cost transform
  // `$contains(Cost, ".") ? Cost : Cost & ".0"` throws on a NUMBER-declared Cost — the String()
  // -coerced retry lets a number-declared Cost fold against the live decimal-string echo.
  it('#1304 GameLift Fleet AnywhereConfiguration.Cost declared as a NUMBER folds (String coercion)', () => {
    const res = mk('AWS::GameLift::Fleet', { AnywhereConfiguration: { Cost: 25 } });
    const s = schema({
      'AnywhereConfiguration.Cost': '$contains(Cost, ".") ? Cost : Cost & ".0"',
    });
    // live stores the canonical decimal string "25.0" — number-declared throws $contains uncoerced
    const f = classifyResource(res, { AnywhereConfiguration: { Cost: '25.0' } }, s);
    expect(declaredPaths(f)).not.toContain('AnywhereConfiguration.Cost');
  });
});

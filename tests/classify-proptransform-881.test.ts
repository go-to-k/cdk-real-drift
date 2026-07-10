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
});

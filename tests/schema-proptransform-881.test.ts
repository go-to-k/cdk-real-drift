// #881 — parseSchema extracts a registry `propertyTransform` block into SchemaInfo.
// propertyTransforms, keyed by the same dotted path convention as the other path fields
// (JSON pointer `/properties/A/*/B` → `A.*.B`), value = the raw JSONata expression string.
import { describe, expect, it } from 'vite-plus/test';
import { parseSchema } from '../src/schema/schema-strip.js';

describe('#881 parseSchema honors propertyTransform', () => {
  it('maps JSON-pointer keys (top-level, nested, and array-element `*`) to dotted paths', () => {
    // Shapes drawn verbatim from the real registry schemas of the confirmed FP types.
    const info = parseSchema(
      JSON.stringify({
        typeName: 'AWS::Test::Type',
        properties: {},
        propertyTransform: {
          '/properties/StartingPositionTimestamp': 'StartingPositionTimestamp * 1000',
          '/properties/MaintenanceWindowStartTime/DayOfWeek':
            '$uppercase(MaintenanceWindowStartTime.DayOfWeek)',
          '/properties/PartitionKeyColumns/*/ColumnType': '$lowercase(ColumnType)',
        },
      })
    );
    expect(info.propertyTransforms).toEqual({
      StartingPositionTimestamp: 'StartingPositionTimestamp * 1000',
      'MaintenanceWindowStartTime.DayOfWeek': '$uppercase(MaintenanceWindowStartTime.DayOfWeek)',
      'PartitionKeyColumns.*.ColumnType': '$lowercase(ColumnType)',
    });
  });

  it('omits propertyTransforms entirely when the schema has no propertyTransform block', () => {
    const info = parseSchema(JSON.stringify({ typeName: 'AWS::Test::Type', properties: {} }));
    expect(info.propertyTransforms).toBeUndefined();
  });

  it('drops a non-string transform value defensively (best-effort parse)', () => {
    const info = parseSchema(
      JSON.stringify({
        properties: {},
        propertyTransform: { '/properties/A': 'A * 1', '/properties/B': 123 },
      })
    );
    expect(info.propertyTransforms).toEqual({ A: 'A * 1' });
  });
});

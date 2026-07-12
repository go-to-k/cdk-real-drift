// #1538 — WarmThroughput echoes the capacity at CREATION and never follows a scale-in, so a
// provisioned table whose live capacity dropped below the template's initial capacity (the
// everyday Application-Auto-Scaling scale-in) FP'd: the #627 derived fold only gated against
// the CURRENT live sibling. It now ALSO gates against the derivation from the DECLARED
// ProvisionedThroughput (the creation value) — top-level and per-GSI. A table that warmed UP
// under traffic (warm > both) still surfaces, unchanged. Live-proven on
// CdkrdHunt0713FormatProbes (us-east-1, 2026-07-13; RCU 5 -> 3 via a scheduled action).
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

const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'HuntTable',
  resourceType: 'AWS::DynamoDB::Table',
  physicalId: 'cdkrd-hunt-table',
  declared,
});

const declared = {
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
};

describe('#1538 DynamoDB WarmThroughput creation echo after a scale-in', () => {
  it('folds the creation-capacity echo when live capacity scaled below the declared capacity', () => {
    const f = classifyResource(
      mk(declared),
      {
        ...declared,
        // Application Auto Scaling scaled RCU 5 -> 3; warm throughput stays at creation 5/5.
        ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 5 },
        WarmThroughput: { ReadUnitsPerSecond: 5, WriteUnitsPerSecond: 5 },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toContain('WarmThroughput');
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('still folds the current-capacity echo (the original #627 case)', () => {
    const f = classifyResource(
      mk(declared),
      {
        ...declared,
        WarmThroughput: { ReadUnitsPerSecond: 5, WriteUnitsPerSecond: 5 },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toContain('WarmThroughput');
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('a warm value matching NEITHER derivation still surfaces (equality gate)', () => {
    const f = classifyResource(
      mk(declared),
      {
        ...declared,
        ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 5 },
        WarmThroughput: { ReadUnitsPerSecond: 50, WriteUnitsPerSecond: 50 },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['WarmThroughput']);
  });

  it('per-GSI: folds the GSI creation-capacity echo after that GSI scaled in', () => {
    const gsiDeclared = {
      ...declared,
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        },
      ],
    };
    const f = classifyResource(
      mk(gsiDeclared),
      {
        ...gsiDeclared,
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
            ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 5 },
            WarmThroughput: { ReadUnitsPerSecond: 5, WriteUnitsPerSecond: 5 },
          },
        ],
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });
});

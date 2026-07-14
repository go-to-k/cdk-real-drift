// 2026-07-14 hunt (variants3-hunt live findings):
//   #1624 a barest Glue Iceberg table first-runs 2 FPs — the create-time
//     OpenTableFormatInput is never echoed by GetTable (readGap denylist), and the
//     service materializes managed TableInput.Parameters (table_type ICEBERG + a
//     per-commit metadata_location pointer; shape-gated derived fold).
//   #1625 a Lambda-compute CodeBuild project defaults TimeoutInMinutes to 15, not
//     the standard-container 60 (derived from the declared Environment.Type).
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

describe('#1624 Glue Iceberg table first-run folds', () => {
  const tableInput = {
    Name: 'iceberg_tbl',
    TableType: 'EXTERNAL_TABLE',
    StorageDescriptor: { Columns: [{ Name: 'id', Type: 'string' }], Location: 's3://b/table/' },
  };
  const mkTable = (declared: Record<string, unknown>): DesiredResource => ({
    logicalId: 'IcebergTable',
    resourceType: 'AWS::Glue::Table',
    physicalId: 'iceberg_tbl',
    declared,
  });
  const icebergDeclared = {
    CatalogId: '123456789012',
    DatabaseName: 'db',
    OpenTableFormatInput: { IcebergInput: { MetadataOperation: 'CREATE', Version: '2' } },
    TableInput: tableInput,
  };
  const managedParams = {
    metadata_location: 's3://b/table/metadata/00000-abc.metadata.json',
    table_type: 'ICEBERG',
  };

  it('declared OpenTableFormatInput absent from live stays readGap, not declared drift', () => {
    const f = classifyResource(
      mkTable(icebergDeclared),
      { CatalogId: '123456789012', DatabaseName: 'db', TableInput: tableInput },
      emptySchema
    );
    expect(f.some((x) => x.tier === 'declared' && x.path === 'OpenTableFormatInput')).toBe(false);
    expect(f.some((x) => x.tier === 'readGap' && x.path === 'OpenTableFormatInput')).toBe(true);
  });

  it('the service-managed iceberg Parameters pair folds to atDefault (ZERO first-run drift)', () => {
    const f = classifyResource(
      mkTable(icebergDeclared),
      {
        CatalogId: '123456789012',
        DatabaseName: 'db',
        TableInput: { ...tableInput, Parameters: managedParams },
      },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toEqual([]);
    expect(tier(f, 'atDefault')).toContain('TableInput.Parameters');
  });

  it('an extra out-of-band parameter makes the map surface — detection preserved', () => {
    const f = classifyResource(
      mkTable(icebergDeclared),
      {
        CatalogId: '123456789012',
        DatabaseName: 'db',
        TableInput: {
          ...tableInput,
          Parameters: { ...managedParams, classification: 'json' },
        },
      },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toEqual(['TableInput.Parameters']);
  });

  it('the fold is gated on the declared IcebergInput — a plain table never folds it', () => {
    const f = classifyResource(
      mkTable({ CatalogId: '123456789012', DatabaseName: 'db', TableInput: tableInput }),
      {
        CatalogId: '123456789012',
        DatabaseName: 'db',
        TableInput: { ...tableInput, Parameters: managedParams },
      },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toEqual(['TableInput.Parameters']);
  });
});

describe('#1625 CodeBuild Lambda-compute TimeoutInMinutes derived default', () => {
  const mkProject = (envType: string): DesiredResource => ({
    logicalId: 'LambdaCb',
    resourceType: 'AWS::CodeBuild::Project',
    physicalId: 'cdkrd-cb-lambda',
    declared: {
      Name: 'cdkrd-cb-lambda',
      ServiceRole: 'arn:aws:iam::123456789012:role/cb',
      Source: { Type: 'NO_SOURCE' },
      Artifacts: { Type: 'NO_ARTIFACTS' },
      Environment: {
        Type: envType,
        ComputeType: 'BUILD_LAMBDA_1GB',
        Image: 'aws/codebuild/amazonlinux-x86_64-lambda-standard:nodejs20',
      },
    },
  });
  const liveBase = {
    Name: 'cdkrd-cb-lambda',
    ServiceRole: 'arn:aws:iam::123456789012:role/cb',
    Source: { Type: 'NO_SOURCE' },
    Artifacts: { Type: 'NO_ARTIFACTS' },
  };

  it('folds the Lambda-compute 15-minute default to atDefault (ZERO first-run drift)', () => {
    const f = classifyResource(
      mkProject('LINUX_LAMBDA_CONTAINER'),
      { ...liveBase, TimeoutInMinutes: 15 },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('TimeoutInMinutes');
    expect(tier(f, 'undeclared')).toEqual([]);
  });

  it('a Lambda-compute timeout changed away from 15 still surfaces', () => {
    const f = classifyResource(
      mkProject('ARM_LAMBDA_CONTAINER'),
      { ...liveBase, TimeoutInMinutes: 30 },
      emptySchema
    );
    expect(tier(f, 'undeclared')).toEqual(['TimeoutInMinutes']);
  });

  it('a standard container keeps the 60 constant fold — 15 there is a real divergence', () => {
    const std = classifyResource(
      mkProject('LINUX_CONTAINER'),
      { ...liveBase, TimeoutInMinutes: 60 },
      emptySchema
    );
    expect(tier(std, 'atDefault')).toContain('TimeoutInMinutes');
    const drifted = classifyResource(
      mkProject('LINUX_CONTAINER'),
      { ...liveBase, TimeoutInMinutes: 15 },
      emptySchema
    );
    expect(tier(drifted, 'undeclared')).toEqual(['TimeoutInMinutes']);
  });
});

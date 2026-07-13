// #1551 — an out-of-band `added` child of a CC-gap type (a type whose declared reads go
// through SDK_OVERRIDES) was detected but its model degraded to the identity snippet with
// `modelReadFailed`: readAddedModel only tried Cloud Control GetResource. Observed live on
// an out-of-band AWS::Glue::Table in the #1540 fixture ("live model unreadable this run"),
// which meant `record` could never snapshot the child's real model and a LATER change to
// the added child stayed invisible. The CC-failure path now tries the type's SDK_OVERRIDES
// reader (physicalId = the enumerator's CC-composite identifier — the exact form
// readGlueTable consumes) before degrading.
import { CloudControlClient, GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { GetTableCommand, GlueClient } from '@aws-sdk/client-glue';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { readAddedModel } from '../src/commands/gather.js';
import type { AddedChild } from '../src/read/child-enumerators.js';
import type { SchemaInfo } from '../src/types.js';

const EMPTY_SCHEMA: SchemaInfo = {
  readOnly: new Set(),
  writeOnly: new Set(),
  createOnly: new Set(),
  readOnlyPaths: [],
  writeOnlyPaths: [],
  createOnlyPaths: [],
  defaults: {},
  defaultPaths: {},
};

const cc = mockClient(CloudControlClient);
const cfn = mockClient(CloudFormationClient);
const glue = mockClient(GlueClient);

const glueTableChild = (): AddedChild => ({
  resourceType: 'AWS::Glue::Table',
  identifier: 'hunt_db|oob_table',
  label: 'oob_table',
  live: { DatabaseName: 'hunt_db', TableInput: { Name: 'oob_table' } },
});

const schemas = () => new Map([['AWS::Glue::Table', EMPTY_SCHEMA]]);

beforeEach(() => {
  cc.reset();
  cfn.reset();
  glue.reset();
  cc.on(GetResourceCommand).rejects(
    Object.assign(new Error('unsupported'), { name: 'UnsupportedActionException' })
  );
});

describe('#1551 added-child model read via SDK_OVERRIDES on CC failure', () => {
  it('reads the FULL model through the override reader and returns ok:true', async () => {
    glue.on(GetTableCommand).resolves({
      Table: {
        Name: 'oob_table',
        DatabaseName: 'hunt_db',
        TableType: 'EXTERNAL_TABLE',
        StorageDescriptor: { Columns: [{ Name: 'id', Type: 'string' }] },
      },
    });
    const read = await readAddedModel(
      cc as unknown as CloudControlClient,
      cfn as unknown as CloudFormationClient,
      glueTableChild(),
      schemas(),
      {},
      'us-east-1',
      '123456789012'
    );
    expect(read.ok).toBe(true);
    expect(read.model).toMatchObject({
      DatabaseName: 'hunt_db',
      TableInput: {
        Name: 'oob_table',
        TableType: 'EXTERNAL_TABLE',
        StorageDescriptor: { Columns: [{ Name: 'id', Type: 'string' }] },
      },
    });
    expect(glue.commandCalls(GetTableCommand)[0]?.args[0].input).toMatchObject({
      DatabaseName: 'hunt_db',
      Name: 'oob_table',
    });
  });

  it('still degrades to the identity snippet (ok:false) when the override ALSO fails', async () => {
    glue.on(GetTableCommand).rejects(new Error('AccessDeniedException'));
    const c = glueTableChild();
    const read = await readAddedModel(
      cc as unknown as CloudControlClient,
      cfn as unknown as CloudFormationClient,
      c,
      schemas(),
      {},
      'us-east-1',
      '123456789012'
    );
    expect(read.ok).toBe(false);
    expect(read.model).toEqual(c.live);
  });

  it('without region/accountId (legacy call shape) the override is skipped — snippet degrade stands', async () => {
    glue.on(GetTableCommand).resolves({ Table: { Name: 'oob_table' } });
    const c = glueTableChild();
    const read = await readAddedModel(
      cc as unknown as CloudControlClient,
      cfn as unknown as CloudFormationClient,
      c,
      schemas(),
      {}
    );
    expect(read.ok).toBe(false);
    expect(glue.commandCalls(GetTableCommand).length).toBe(0);
  });
});

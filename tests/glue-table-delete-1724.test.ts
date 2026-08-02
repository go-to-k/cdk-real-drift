// #1724 — reverting an `added` AWS::Glue::Table must route through the service's own
// DeleteTable, NOT Cloud Control DeleteResource: CC has no DELETE handler for the type
// (UnsupportedActionException at apply, live-hit on the 2026-08-03 added-pack hunt: the
// Glue Database child enumerator surfaced the out-of-band table but the delete-kind item
// failed). The SDK deleter addresses the table as { DatabaseName, Name } split from the
// finding's physicalId — the enumerator identifier `<DatabaseName>|<TableName>`.
import { DeleteTableCommand, GlueClient } from '@aws-sdk/client-glue';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { SDK_DELETERS } from '../src/revert/writers.js';

describe('SDK_DELETERS[AWS::Glue::Table] — DeleteTable with { DatabaseName, Name } (#1724)', () => {
  const glue = mockClient(GlueClient);
  beforeEach(() => glue.reset());
  afterEach(() => glue.restore());

  const deleter = SDK_DELETERS['AWS::Glue::Table']!;

  it('is registered (the routing table knows the type)', () => {
    expect(deleter).toBeDefined();
  });

  it('splits the enumerator identifier on the FIRST | into DatabaseName / Name', async () => {
    glue.on(DeleteTableCommand).resolves({});
    await deleter({ physicalId: 'cdkrd_hunt_db|cdkrd_oob_table', region: 'us-east-1' });
    const calls = glue.commandCalls(DeleteTableCommand);
    expect(calls.length).toBe(1);
    expect(calls[0]!.args[0].input).toEqual({
      DatabaseName: 'cdkrd_hunt_db',
      Name: 'cdkrd_oob_table',
    });
  });

  it('throws (an honest FAILED, not a silent skip) on an unsplittable identifier', async () => {
    await expect(deleter({ physicalId: 'no-separator', region: 'us-east-1' })).rejects.toThrow(
      /DatabaseName\|TableName/
    );
    expect(glue.commandCalls(DeleteTableCommand).length).toBe(0);
  });
});

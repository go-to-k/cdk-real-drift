// #1650 — a Chatbot SlackChannelConfiguration declares a legacy Slack private-group id
// (`G…`), but Slack migrated those conversations to modern C-prefixed conversation ids
// preserving every character after the prefix, and Chatbot's read echoes the CURRENT
// (migrated) id — a permanent declared FP (desired `G0XXXXXXXXX` vs live `C0XXXXXXXXX`)
// on a configuration nobody re-pointed. classify treats declared and live as EQUAL when
// they differ ONLY by the leading 'G' vs 'C' with an identical NON-EMPTY remainder
// (SLACK_ID_MIGRATION_PATHS); a genuine re-point changes the remainder and still surfaces.
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

const TYPE = 'AWS::Chatbot::SlackChannelConfiguration';

// Assert on the FULL tier:path list (never tier-filtered) to catch double-reporting.
const all = (fs: Finding[]) => fs.map((f) => `${f.tier}:${f.path}`).sort();

const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'SlackChannel',
  resourceType: TYPE,
  physicalId: 'arn:aws:chatbot::123456789012:chat-configuration/slack-channel/cdkrd-hunt',
  declared,
});

describe('#1650 Chatbot SlackChannelId Slack G->C id-migration echo', () => {
  it('folds a declared legacy G-prefix id echoed back as the migrated C-prefix id', () => {
    const res = mk({
      SlackChannelId: 'G0ABCDEF123',
      SlackWorkspaceId: 'T0AAAAAAA',
      ConfigurationName: 'cdkrd-hunt',
      IamRoleArn: 'arn:aws:iam::123456789012:role/cdkrd-hunt-chatbot',
    });
    const f = classifyResource(
      res,
      {
        SlackChannelId: 'C0ABCDEF123',
        SlackWorkspaceId: 'T0AAAAAAA',
        ConfigurationName: 'cdkrd-hunt',
        IamRoleArn: 'arn:aws:iam::123456789012:role/cdkrd-hunt-chatbot',
      },
      emptySchema
    );
    expect(all(f)).toEqual([]);
  });

  it('still surfaces a genuine re-point to a different channel (remainder differs)', () => {
    const res = mk({ SlackChannelId: 'G0ABCDEF123' });
    const f = classifyResource(res, { SlackChannelId: 'C0ZZZZZZ999' }, emptySchema);
    expect(all(f)).toEqual(['declared:SlackChannelId']);
  });

  it('does not fold a bare prefix (empty remainder): declared "G" vs live "C" surfaces', () => {
    const res = mk({ SlackChannelId: 'G' });
    const f = classifyResource(res, { SlackChannelId: 'C' }, emptySchema);
    expect(all(f)).toEqual(['declared:SlackChannelId']);
  });

  it('does not affect an unrelated path on the same type', () => {
    const res = mk({ SlackChannelId: 'C0ABCDEF123', SlackWorkspaceId: 'G0ABCDEF123' });
    const f = classifyResource(
      res,
      { SlackChannelId: 'C0ABCDEF123', SlackWorkspaceId: 'C0ABCDEF123' },
      emptySchema
    );
    expect(all(f)).toEqual(['declared:SlackWorkspaceId']);
  });

  it('does not affect an unrelated resource type carrying G/C-shaped values', () => {
    const res: DesiredResource = {
      logicalId: 'Param',
      resourceType: 'AWS::SSM::Parameter',
      physicalId: 'cdkrd-hunt-param',
      declared: { Name: 'cdkrd-hunt-param', Type: 'String', Value: 'G0ABCDEF123' },
    };
    const f = classifyResource(
      res,
      { Name: 'cdkrd-hunt-param', Type: 'String', Value: 'C0ABCDEF123' },
      emptySchema
    );
    expect(all(f)).toEqual(['declared:Value']);
  });
});

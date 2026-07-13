// #1559 + #1562 — three first-run FP folds (all tier-1 equality-gated service defaults):
//   #1559 ELBv2 Listener.SslPolicy = "ELBSecurityPolicy-2016-08" (HTTPS/TLS listener default)
//   #1562 Glue Crawler.SchemaChangePolicy / .RecrawlPolicy (documented Glue defaults)
//   #1562 IoT TopicRule.TopicRulePayload.AwsIotSqlVersion = "2015-10-08" (nested per-leaf)
// The end-to-end folds are locked by the golden corpus cases; these pin the table entries and
// prove detection is PRESERVED (a change away from each default still surfaces).
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { KNOWN_DEFAULTS, KNOWN_DEFAULT_PATHS } from '../src/normalize/noise.js';
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

const tierOf = (fs: Finding[], path: string) => fs.find((f) => f.path === path)?.tier;

describe('#1559/#1562 first-run default folds', () => {
  it('table entries are present', () => {
    expect(KNOWN_DEFAULTS['AWS::ElasticLoadBalancingV2::Listener'].SslPolicy).toBe(
      'ELBSecurityPolicy-2016-08'
    );
    expect(KNOWN_DEFAULTS['AWS::Glue::Crawler'].SchemaChangePolicy).toEqual({
      UpdateBehavior: 'UPDATE_IN_DATABASE',
      DeleteBehavior: 'DEPRECATE_IN_DATABASE',
    });
    expect(KNOWN_DEFAULTS['AWS::Glue::Crawler'].RecrawlPolicy).toEqual({
      RecrawlBehavior: 'CRAWL_EVERYTHING',
    });
    expect(KNOWN_DEFAULT_PATHS['AWS::IoT::TopicRule']['TopicRulePayload.AwsIotSqlVersion']).toBe(
      '2015-10-08'
    );
  });

  it('Listener SslPolicy: default folds, an out-of-band policy change surfaces', () => {
    const res: DesiredResource = {
      logicalId: 'L',
      resourceType: 'AWS::ElasticLoadBalancingV2::Listener',
      physicalId: 'arn:aws:elasticloadbalancing:us-east-1:111111111111:listener/app/x/y/z',
      declared: { Port: 443, Protocol: 'HTTPS' },
    };
    expect(
      tierOf(
        classifyResource(res, { SslPolicy: 'ELBSecurityPolicy-2016-08' }, emptySchema),
        'SslPolicy'
      )
    ).toBe('atDefault');
    expect(
      tierOf(
        classifyResource(res, { SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06' }, emptySchema),
        'SslPolicy'
      )
    ).toBe('undeclared');
  });

  it('Glue Crawler policies: defaults fold, an out-of-band behavior change surfaces', () => {
    const res: DesiredResource = {
      logicalId: 'C',
      resourceType: 'AWS::Glue::Crawler',
      physicalId: 'huntcrawler',
      declared: { Role: 'r', DatabaseName: 'db' },
    };
    const clean = classifyResource(
      res,
      {
        SchemaChangePolicy: {
          UpdateBehavior: 'UPDATE_IN_DATABASE',
          DeleteBehavior: 'DEPRECATE_IN_DATABASE',
        },
        RecrawlPolicy: { RecrawlBehavior: 'CRAWL_EVERYTHING' },
      },
      emptySchema
    );
    expect(tierOf(clean, 'SchemaChangePolicy')).toBe('atDefault');
    expect(tierOf(clean, 'RecrawlPolicy')).toBe('atDefault');
    // an out-of-band delete-behavior change (LOG) no longer matches the whole-object default
    const changed = classifyResource(
      res,
      {
        SchemaChangePolicy: { UpdateBehavior: 'UPDATE_IN_DATABASE', DeleteBehavior: 'LOG' },
        RecrawlPolicy: { RecrawlBehavior: 'CRAWL_NEW_FOLDERS_ONLY' },
      },
      emptySchema
    );
    expect(tierOf(changed, 'SchemaChangePolicy')).toBe('undeclared');
    expect(tierOf(changed, 'RecrawlPolicy')).toBe('undeclared');
  });

  it('IoT TopicRule AwsIotSqlVersion: default folds, a version change surfaces', () => {
    const res: DesiredResource = {
      logicalId: 'T',
      resourceType: 'AWS::IoT::TopicRule',
      physicalId: 'huntrule',
      // TopicRulePayload partially declared (Sql + Actions) so it is descended per-leaf
      declared: { TopicRulePayload: { Sql: "SELECT * FROM 'x'", Actions: [{ Republish: {} }] } },
    };
    const clean = classifyResource(
      res,
      {
        TopicRulePayload: {
          Sql: "SELECT * FROM 'x'",
          Actions: [{ Republish: {} }],
          AwsIotSqlVersion: '2015-10-08',
        },
      },
      emptySchema
    );
    expect(tierOf(clean, 'TopicRulePayload.AwsIotSqlVersion')).toBe('atDefault');
    const changed = classifyResource(
      res,
      {
        TopicRulePayload: {
          Sql: "SELECT * FROM 'x'",
          Actions: [{ Republish: {} }],
          AwsIotSqlVersion: '2016-03-23',
        },
      },
      emptySchema
    );
    expect(tierOf(changed, 'TopicRulePayload.AwsIotSqlVersion')).toBe('undeclared');
  });
});

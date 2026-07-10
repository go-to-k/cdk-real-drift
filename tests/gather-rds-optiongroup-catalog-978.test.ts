// #978 — buildRdsOptionSettingDefaults resolves each AWS::RDS::OptionGroup's option-default
// catalog from describe-option-group-options (per engine+version, cached + paginated), keyed
// physicalId -> optionName -> settingName -> DefaultValue|null. classify folds a live-only setting
// matching its catalog default (or a `{Name}` husk) to atDefault. This guards the LIVE wiring (the
// #980 "corpus-green but live-broken" class): the classify fold is inert unless this builder
// populates the catalog and gather threads it into classifyOpts.
import { DescribeOptionGroupOptionsCommand, RDSClient } from '@aws-sdk/client-rds';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { buildRdsOptionSettingDefaults } from '../src/commands/gather.js';
import type { Desired } from '../src/desired/template-adapter.js';
import type { DesiredResource, ResolverContext } from '../src/types.js';

const rds = mockClient(RDSClient);
afterEach(() => rds.reset());

const desiredWith = (resources: DesiredResource[]): Desired =>
  ({
    stackName: 's',
    region: 'us-east-1',
    accountId: '111122223333',
    resources,
    rawTemplate: '',
    ctx: { liveAttrs: {} } as unknown as ResolverContext,
  }) as Desired;

const optionGroup = (physicalId: string, engine: string, version: string): DesiredResource => ({
  logicalId: 'OG',
  resourceType: 'AWS::RDS::OptionGroup',
  physicalId,
  declared: { EngineName: engine, MajorEngineVersion: version },
});

describe('#978 buildRdsOptionSettingDefaults', () => {
  it('builds the per-physicalId option->setting->default catalog (value + null husk)', async () => {
    rds.on(DescribeOptionGroupOptionsCommand).resolves({
      OptionGroupOptions: [
        {
          Name: 'MARIADB_AUDIT_PLUGIN',
          OptionGroupOptionSettings: [
            { SettingName: 'SERVER_AUDIT', DefaultValue: 'FORCE_PLUS_PERMANENT' },
            { SettingName: 'SERVER_AUDIT_LOGGING', DefaultValue: 'ON' },
            { SettingName: 'SERVER_AUDIT_INCL_USERS' }, // no DefaultValue -> husk (null)
          ],
        },
      ],
    });
    const cat = await buildRdsOptionSettingDefaults(
      desiredWith([optionGroup('og-1', 'mariadb', '10.11')]),
      'us-east-1'
    );
    expect(cat['og-1']?.MARIADB_AUDIT_PLUGIN).toEqual({
      SERVER_AUDIT: 'FORCE_PLUS_PERMANENT',
      SERVER_AUDIT_LOGGING: 'ON',
      SERVER_AUDIT_INCL_USERS: null,
    });
  });

  it('returns {} and makes no AWS call when the stack has no OptionGroup', async () => {
    const cat = await buildRdsOptionSettingDefaults(
      desiredWith([
        { logicalId: 'Q', resourceType: 'AWS::SQS::Queue', physicalId: 'q', declared: {} },
      ]),
      'us-east-1'
    );
    expect(cat).toEqual({});
    expect(rds.calls()).toHaveLength(0);
  });

  it('caches per engine+version — two groups on the same engine describe once', async () => {
    rds.on(DescribeOptionGroupOptionsCommand).resolves({
      OptionGroupOptions: [
        {
          Name: 'MARIADB_AUDIT_PLUGIN',
          OptionGroupOptionSettings: [{ SettingName: 'X', DefaultValue: '1' }],
        },
      ],
    });
    const cat = await buildRdsOptionSettingDefaults(
      desiredWith([
        optionGroup('og-a', 'mariadb', '10.11'),
        optionGroup('og-b', 'mariadb', '10.11'),
      ]),
      'us-east-1'
    );
    expect(Object.keys(cat).sort()).toEqual(['og-a', 'og-b']);
    expect(rds.calls()).toHaveLength(1); // one describe for the shared engine+version
  });

  it('fail-soft: a denied describe leaves the group out of the map (no throw)', async () => {
    rds
      .on(DescribeOptionGroupOptionsCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const cat = await buildRdsOptionSettingDefaults(
      desiredWith([optionGroup('og-1', 'oracle-se2', '19')]),
      'us-east-1'
    );
    expect(cat).toEqual({});
  });

  it('paginates via Marker', async () => {
    rds
      .on(DescribeOptionGroupOptionsCommand)
      .resolvesOnce({
        OptionGroupOptions: [
          { Name: 'OPT1', OptionGroupOptionSettings: [{ SettingName: 'A', DefaultValue: '1' }] },
        ],
        Marker: 'next',
      })
      .resolvesOnce({
        OptionGroupOptions: [
          { Name: 'OPT2', OptionGroupOptionSettings: [{ SettingName: 'B', DefaultValue: '2' }] },
        ],
      });
    const cat = await buildRdsOptionSettingDefaults(
      desiredWith([optionGroup('og-1', 'oracle-se2', '19')]),
      'us-east-1'
    );
    expect(cat['og-1']).toEqual({ OPT1: { A: '1' }, OPT2: { B: '2' } });
    expect(rds.calls()).toHaveLength(2);
  });
});

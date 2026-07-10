// #978 — AWS::RDS::OptionGroup undeclared default-fill. Configuring an option
// (MARIADB_AUDIT_PLUGIN) makes RDS materialize EVERY plugin setting the template did not
// declare: value-bearing AWS defaults (SERVER_AUDIT=FORCE_PLUS_PERMANENT, ...) and value-less
// `{Name}`-only husks (a listed-but-unset setting). Both are service first-run defaults, not
// user intent, so each must fold `atDefault` (zero first-run drift) — the undeclared-tier twin
// of the closed #480 declared-tier fold. Detection is preserved: a husk that GAINS a Value or a
// pinned default whose Value CHANGES still surfaces as undeclared.
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

const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'HuntOptionGroup',
  resourceType: 'AWS::RDS::OptionGroup',
  physicalId: 'og-phys',
  declared,
});

// The template declares only two audit settings.
const declared = {
  EngineName: 'mariadb',
  MajorEngineVersion: '10.11',
  OptionConfigurations: [
    {
      OptionName: 'MARIADB_AUDIT_PLUGIN',
      OptionSettings: [
        { Name: 'SERVER_AUDIT_EVENTS', Value: 'CONNECT,QUERY' },
        { Name: 'SERVER_AUDIT_QUERY_LOG_LIMIT', Value: '2048' },
      ],
    },
  ],
};

// Live reads back the declared two plus RDS's default-fill of every other plugin setting.
const liveOptionSettings = (extra: Record<string, unknown>[] = []) => ({
  EngineName: 'mariadb',
  MajorEngineVersion: '10.11',
  OptionConfigurations: [
    {
      OptionName: 'MARIADB_AUDIT_PLUGIN',
      VpcSecurityGroupMemberships: [],
      OptionSettings: [
        { Name: 'SERVER_AUDIT_QUERY_LOG_LIMIT', Value: '2048' },
        { Name: 'SERVER_AUDIT_EVENTS', Value: 'CONNECT,QUERY' },
        { Name: 'SERVER_AUDIT_LOGGING', Value: 'ON' },
        { Name: 'SERVER_AUDIT_INCL_USERS' },
        { Name: 'SERVER_AUDIT', Value: 'FORCE_PLUS_PERMANENT' },
        { Name: 'SERVER_AUDIT_FILE_ROTATIONS' },
        { Name: 'SERVER_AUDIT_FILE_PATH', Value: '/rdsdbdata/log/audit/' },
        { Name: 'SERVER_AUDIT_FILE_ROTATE_SIZE' },
        { Name: 'SERVER_AUDIT_EXCL_USERS' },
        ...extra,
      ],
    },
  ],
});

const p = (name: string) => `OptionConfigurations.0.OptionSettings[${name}]`;

describe('#978 RDS OptionGroup default-fill folds to atDefault', () => {
  it('folds every service-materialized default setting (value-bearing + husk) to atDefault', () => {
    const f = classifyResource(mk(declared), liveOptionSettings(), emptySchema);
    const atDefault = tier(f, 'atDefault');
    for (const name of [
      'SERVER_AUDIT',
      'SERVER_AUDIT_LOGGING',
      'SERVER_AUDIT_FILE_PATH',
      'SERVER_AUDIT_INCL_USERS',
      'SERVER_AUDIT_EXCL_USERS',
      'SERVER_AUDIT_FILE_ROTATIONS',
      'SERVER_AUDIT_FILE_ROTATE_SIZE',
    ]) {
      expect(atDefault).toContain(p(name));
    }
    // zero-first-run invariant: nothing default-filled surfaces as undeclared drift
    expect(tier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces a value-bearing default whose value diverged out of band — detection preserved', () => {
    // SERVER_AUDIT_LOGGING flipped ON -> OFF is a real out-of-band mutation.
    const live = liveOptionSettings();
    (live.OptionConfigurations[0].OptionSettings as Record<string, unknown>[]).find(
      (s) => s.Name === 'SERVER_AUDIT_LOGGING'
    )!.Value = 'OFF';
    const f = classifyResource(mk(declared), live, emptySchema);
    expect(tier(f, 'undeclared')).toContain(p('SERVER_AUDIT_LOGGING'));
    expect(tier(f, 'atDefault')).not.toContain(p('SERVER_AUDIT_LOGGING'));
  });

  it('surfaces a husk that GAINS a value out of band — detection preserved', () => {
    // SERVER_AUDIT_EXCL_USERS gains a value: no longer an identity-only husk.
    const live = liveOptionSettings();
    (live.OptionConfigurations[0].OptionSettings as Record<string, unknown>[]).find(
      (s) => s.Name === 'SERVER_AUDIT_EXCL_USERS'
    )!.Value = 'rogueuser';
    const f = classifyResource(mk(declared), live, emptySchema);
    expect(tier(f, 'undeclared')).toContain(p('SERVER_AUDIT_EXCL_USERS'));
    expect(tier(f, 'atDefault')).not.toContain(p('SERVER_AUDIT_EXCL_USERS'));
  });

  it('surfaces an unknown value-bearing setting the table does not pin — fail-closed', () => {
    // A setting not in the default table, carrying a value, is genuine undeclared inventory.
    const f = classifyResource(
      mk(declared),
      liveOptionSettings([{ Name: 'SOME_UNKNOWN_SETTING', Value: 'x' }]),
      emptySchema
    );
    expect(tier(f, 'undeclared')).toContain(p('SOME_UNKNOWN_SETTING'));
  });
});

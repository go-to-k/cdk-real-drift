// #978 — AWS::RDS::OptionGroup undeclared default-fill. Configuring an option
// (MARIADB_AUDIT_PLUGIN, Oracle NATIVE_NETWORK_ENCRYPTION, ...) makes RDS materialize EVERY plugin
// setting the template did not declare: value-bearing AWS defaults and value-less `{Name}`-only
// husks. Both are service first-run defaults, not user intent, so each folds `atDefault` (zero
// first-run drift) — the undeclared-tier twin of the closed #480 declared-tier fold.
//
// The value-bearing defaults come from the gather-resolved option-default catalog
// (`opts.rdsOptionSettingDefaults`, read live from describe-option-group-options), NOT a pinned
// table. Detection is preserved (equality-gated): a value diverging from its catalog default, or a
// husk that gains a value, still surfaces undeclared. When the catalog is absent (read denied /
// offline), value-bearing settings surface undeclared (fail-open) but husks still fold.
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

const PHYS = 'og-phys';
const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'HuntOptionGroup',
  resourceType: 'AWS::RDS::OptionGroup',
  physicalId: PHYS,
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

// The gather-resolved catalog (as describe-option-group-options returns it for mariadb 10.11):
// value-bearing DefaultValues + null for the unset (husk) settings.
const catalogOpts = () => ({
  rdsOptionSettingDefaults: {
    [PHYS]: {
      MARIADB_AUDIT_PLUGIN: {
        SERVER_AUDIT_EVENTS: 'CONNECT,QUERY',
        SERVER_AUDIT_QUERY_LOG_LIMIT: '1024',
        SERVER_AUDIT_LOGGING: 'ON',
        SERVER_AUDIT_FILE_PATH: '/rdsdbdata/log/audit/',
        SERVER_AUDIT: 'FORCE_PLUS_PERMANENT',
        SERVER_AUDIT_INCL_USERS: null,
        SERVER_AUDIT_EXCL_USERS: null,
        SERVER_AUDIT_FILE_ROTATE_SIZE: null,
        SERVER_AUDIT_FILE_ROTATIONS: null,
      },
    },
  },
});

const p = (name: string) => `OptionConfigurations.0.OptionSettings[${name}]`;

describe('#978 RDS OptionGroup default-fill folds to atDefault via the live catalog', () => {
  it('folds every service-materialized default setting (value-bearing + husk) to atDefault', () => {
    const f = classifyResource(mk(declared), liveOptionSettings(), emptySchema, catalogOpts());
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
    const f = classifyResource(mk(declared), live, emptySchema, catalogOpts());
    expect(tier(f, 'undeclared')).toContain(p('SERVER_AUDIT_LOGGING'));
    expect(tier(f, 'atDefault')).not.toContain(p('SERVER_AUDIT_LOGGING'));
  });

  it('surfaces a husk that GAINS a value out of band — detection preserved', () => {
    // SERVER_AUDIT_EXCL_USERS gains a value: no longer an identity-only husk.
    const live = liveOptionSettings();
    (live.OptionConfigurations[0].OptionSettings as Record<string, unknown>[]).find(
      (s) => s.Name === 'SERVER_AUDIT_EXCL_USERS'
    )!.Value = 'rogueuser';
    const f = classifyResource(mk(declared), live, emptySchema, catalogOpts());
    expect(tier(f, 'undeclared')).toContain(p('SERVER_AUDIT_EXCL_USERS'));
    expect(tier(f, 'atDefault')).not.toContain(p('SERVER_AUDIT_EXCL_USERS'));
  });

  it('surfaces a value-bearing setting the catalog does not know — fail-closed', () => {
    const f = classifyResource(
      mk(declared),
      liveOptionSettings([{ Name: 'SOME_UNKNOWN_SETTING', Value: 'x' }]),
      emptySchema,
      catalogOpts()
    );
    expect(tier(f, 'undeclared')).toContain(p('SOME_UNKNOWN_SETTING'));
  });

  it('without a catalog: husks still fold but value-bearing defaults surface undeclared (fail-open degrade)', () => {
    const f = classifyResource(mk(declared), liveOptionSettings(), emptySchema); // no opts
    const undeclared = tier(f, 'undeclared');
    // value-bearing defaults surface (no catalog to confirm them)
    expect(undeclared).toContain(p('SERVER_AUDIT'));
    expect(undeclared).toContain(p('SERVER_AUDIT_LOGGING'));
    expect(undeclared).toContain(p('SERVER_AUDIT_FILE_PATH'));
    // husks still fold generically (they carry no value to verify)
    const atDefault = tier(f, 'atDefault');
    expect(atDefault).toContain(p('SERVER_AUDIT_INCL_USERS'));
    expect(atDefault).toContain(p('SERVER_AUDIT_FILE_ROTATIONS'));
  });
});

// #1318 — a group declaring TWO+ options whose TEMPLATE order differs from the canonical SORT
// order. `OptionConfigurations` is `insertionOrder:false`, so classify sorts BOTH sides by
// canonical JSON before the positional diff — the drift record's index is the SORTED index. The
// fold must resolve each option's NAME from the array the diff index actually refers to (the sorted
// live element's `OptionName`), NOT the raw declared model — else the wrong catalog entry is
// consulted and every value-bearing default of the misaligned option surfaces as first-run
// undeclared drift. Reverse-sorted repro: raw order [MARIADB_AUDIT_PLUGIN, A_DUMMY_PLUGIN] with
// A_DUMMY_PLUGIN sorting BEFORE MARIADB_AUDIT_PLUGIN.
describe('#1318 multi-option group whose template order differs from canonical sort order', () => {
  // Declared in raw order [MARIADB_AUDIT_PLUGIN, A_DUMMY_PLUGIN]; A_DUMMY_PLUGIN sorts first.
  const declaredTwo = {
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
      {
        OptionName: 'A_DUMMY_PLUGIN',
        OptionSettings: [{ Name: 'DUMMY_MODE', Value: 'STRICT' }],
      },
    ],
  };

  // Live reads both options back with RDS's default-fill (raw live order also differs from sort).
  const liveTwo = () => ({
    EngineName: 'mariadb',
    MajorEngineVersion: '10.11',
    OptionConfigurations: [
      {
        OptionName: 'MARIADB_AUDIT_PLUGIN',
        VpcSecurityGroupMemberships: [],
        OptionSettings: [
          { Name: 'SERVER_AUDIT_EVENTS', Value: 'CONNECT,QUERY' },
          { Name: 'SERVER_AUDIT_QUERY_LOG_LIMIT', Value: '2048' },
          { Name: 'SERVER_AUDIT_LOGGING', Value: 'ON' },
          { Name: 'SERVER_AUDIT', Value: 'FORCE_PLUS_PERMANENT' },
          { Name: 'SERVER_AUDIT_INCL_USERS' },
        ],
      },
      {
        OptionName: 'A_DUMMY_PLUGIN',
        VpcSecurityGroupMemberships: [],
        OptionSettings: [
          { Name: 'DUMMY_MODE', Value: 'STRICT' },
          { Name: 'DUMMY_LEVEL', Value: '5' },
          { Name: 'DUMMY_FLAG', Value: 'OFF' },
          { Name: 'DUMMY_UNSET' },
        ],
      },
    ],
  });

  const catalogTwo = () => ({
    rdsOptionSettingDefaults: {
      [PHYS]: {
        MARIADB_AUDIT_PLUGIN: {
          SERVER_AUDIT_EVENTS: 'CONNECT,QUERY',
          SERVER_AUDIT_QUERY_LOG_LIMIT: '1024',
          SERVER_AUDIT_LOGGING: 'ON',
          SERVER_AUDIT: 'FORCE_PLUS_PERMANENT',
          SERVER_AUDIT_INCL_USERS: null,
        },
        A_DUMMY_PLUGIN: {
          DUMMY_MODE: 'LENIENT',
          DUMMY_LEVEL: '5',
          DUMMY_FLAG: 'OFF',
          DUMMY_UNSET: null,
        },
      },
    },
  });

  it('folds every catalog default of BOTH options despite raw-order != sort-order (#1318)', () => {
    const f = classifyResource(mk(declaredTwo), liveTwo(), emptySchema, catalogTwo());
    // Both options full-fold: zero first-run undeclared drift.
    expect(tier(f, 'undeclared')).toEqual([]);
    const atDefault = tier(f, 'atDefault');
    // MARIADB_AUDIT_PLUGIN default-fills.
    for (const name of ['SERVER_AUDIT_LOGGING', 'SERVER_AUDIT', 'SERVER_AUDIT_INCL_USERS']) {
      expect(atDefault.some((path) => path.endsWith(`[${name}]`))).toBe(true);
    }
    // A_DUMMY_PLUGIN default-fills (the misaligned option — the one that regressed pre-fix).
    for (const name of ['DUMMY_LEVEL', 'DUMMY_FLAG', 'DUMMY_UNSET']) {
      expect(atDefault.some((path) => path.endsWith(`[${name}]`))).toBe(true);
    }
  });

  it('control: raw order == sort order (single option) still folds', () => {
    const f = classifyResource(mk(declared), liveOptionSettings(), emptySchema, catalogOpts());
    expect(tier(f, 'undeclared')).toEqual([]);
  });

  it('preserves out-of-band detection on the misaligned option — equality gating unchanged', () => {
    // A_DUMMY_PLUGIN.DUMMY_FLAG flipped OFF -> ON diverges from its catalog default.
    const live = liveTwo();
    (live.OptionConfigurations[1].OptionSettings as Record<string, unknown>[]).find(
      (s) => s.Name === 'DUMMY_FLAG'
    )!.Value = 'ON';
    const f = classifyResource(mk(declaredTwo), live, emptySchema, catalogTwo());
    expect(tier(f, 'undeclared').some((path) => path.endsWith('[DUMMY_FLAG]'))).toBe(true);
    expect(tier(f, 'atDefault').some((path) => path.endsWith('[DUMMY_FLAG]'))).toBe(false);
  });
});

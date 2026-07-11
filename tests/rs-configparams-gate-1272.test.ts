// #1272 — AWS::RedshiftServerless::Workgroup.ConfigParameters was folded value-independent (#958),
// which HID an out-of-band `update-workgroup --config-parameters` change to a security-load-bearing
// key (require_ssl=false plaintext, enable_user_activity_logging=false audit-off). It is now a
// PER-ELEMENT equality gate keyed by ParameterKey against the live-harvested defaults: a known key
// at its default folds atDefault, a changed known key surfaces, an unknown NEW key still folds
// (AWS extends the set over time). Live-verified 2026-07-11 on a fresh us-east-1 workgroup: a clean
// deploy is CLEAN (all 9 params fold) and an OOB require_ssl=false surfaces exactly that one param.
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
const tierOf = (fs: Finding[], path: string): string | undefined =>
  fs.find((f) => f.path === path)?.tier;
const res: DesiredResource = {
  logicalId: 'Wg',
  resourceType: 'AWS::RedshiftServerless::Workgroup',
  physicalId: 'cdkrd-wg',
  declared: { WorkgroupName: 'w', NamespaceName: 'n' }, // declares NO ConfigParameters
};
// The full default effective-parameter set a fresh workgroup reads back (live-harvested).
const DEFAULTS = [
  { ParameterKey: 'auto_mv', ParameterValue: 'true' },
  { ParameterKey: 'datestyle', ParameterValue: 'ISO, MDY' },
  { ParameterKey: 'enable_case_sensitive_identifier', ParameterValue: 'false' },
  { ParameterKey: 'enable_user_activity_logging', ParameterValue: 'true' },
  { ParameterKey: 'query_group', ParameterValue: 'default' },
  { ParameterKey: 'require_ssl', ParameterValue: 'true' },
  { ParameterKey: 'search_path', ParameterValue: '$user, public' },
  { ParameterKey: 'use_fips_ssl', ParameterValue: 'false' },
  { ParameterKey: 'max_query_execution_time', ParameterValue: '14400' },
];

describe('#1272 RedshiftServerless::Workgroup.ConfigParameters per-element gate', () => {
  it('(a) folds EVERY default parameter to atDefault (clean deploy — zero potential drift)', () => {
    const f = classifyResource(res, { ConfigParameters: DEFAULTS }, emptySchema, {});
    for (const p of DEFAULTS) {
      expect(tierOf(f, `ConfigParameters[${p.ParameterKey}]`)).toBe('atDefault');
    }
    expect(f.some((x) => x.tier === 'undeclared')).toBe(false);
  });

  it('(b) SURFACES an out-of-band require_ssl=false (plaintext) while the rest still fold', () => {
    const mutated = DEFAULTS.map((p) =>
      p.ParameterKey === 'require_ssl' ? { ...p, ParameterValue: 'false' } : p
    );
    const f = classifyResource(res, { ConfigParameters: mutated }, emptySchema, {});
    expect(tierOf(f, 'ConfigParameters[require_ssl]')).toBe('undeclared');
    // exactly one surfaced; every other key still folds
    expect(f.filter((x) => x.tier === 'undeclared').map((x) => x.path)).toEqual([
      'ConfigParameters[require_ssl]',
    ]);
    expect(tierOf(f, 'ConfigParameters[enable_user_activity_logging]')).toBe('atDefault');
  });

  it('(c) SURFACES an out-of-band audit-logging-off (enable_user_activity_logging=false)', () => {
    const mutated = DEFAULTS.map((p) =>
      p.ParameterKey === 'enable_user_activity_logging' ? { ...p, ParameterValue: 'false' } : p
    );
    const f = classifyResource(res, { ConfigParameters: mutated }, emptySchema, {});
    expect(tierOf(f, 'ConfigParameters[enable_user_activity_logging]')).toBe('undeclared');
  });

  it('(d) FOLDS an unknown NEW key (AWS extends the set over time — #653)', () => {
    const withNew = [
      ...DEFAULTS,
      { ParameterKey: 'some_future_param', ParameterValue: 'whatever' },
    ];
    const f = classifyResource(res, { ConfigParameters: withNew }, emptySchema, {});
    expect(tierOf(f, 'ConfigParameters[some_future_param]')).toBe('atDefault');
  });

  it('(e) tolerates a boolean/number live value vs the string default (no false surface)', () => {
    // If the read path ever yields a boolean/number instead of a string, the value still matches.
    const coerced = [
      { ParameterKey: 'require_ssl', ParameterValue: true },
      { ParameterKey: 'max_query_execution_time', ParameterValue: 14400 },
    ];
    const f = classifyResource(res, { ConfigParameters: coerced }, emptySchema, {});
    expect(tierOf(f, 'ConfigParameters[require_ssl]')).toBe('atDefault');
    expect(tierOf(f, 'ConfigParameters[max_query_execution_time]')).toBe('atDefault');
  });
});

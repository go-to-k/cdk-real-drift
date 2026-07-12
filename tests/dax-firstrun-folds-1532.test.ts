// #1532: a barest DAX stack (Cluster + ParameterGroup + SubnetGroup) first-ran four
// [Potential Drift] entries (live 2026-07-12, us-east-1, CdkrdHuntDax0712c). These tests pin
// the folds per the fold-strategy decision order: two equality-gated constants
// (ParameterNameValues engine defaults, the default.dax1.0 parameter-group name), the
// randomly-assigned maintenance window (value-independent, the RDS/ElastiCache sibling), and
// the VPC-default SecurityGroupIds via the derived #889 gate (single default folds,
// swap/append surfaces).
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import { buildRevertPlan } from '../src/revert/plan.js';
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

describe('#1532 DAX ParameterGroup first-run fold', () => {
  const res: DesiredResource = {
    logicalId: 'ParamGroup',
    resourceType: 'AWS::DAX::ParameterGroup',
    physicalId: 'cdkrdhuntdax0712c-paramgroup',
    declared: { Description: 'cdkrd hunt' },
  };

  it('folds the materialized engine-default TTLs to atDefault', () => {
    const f = classifyResource(
      res,
      {
        Description: 'cdkrd hunt',
        ParameterNameValues: { 'query-ttl-millis': '300000', 'record-ttl-millis': '300000' },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'atDefault')).toContain('ParameterNameValues');
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });

  it('surfaces an out-of-band TTL change (equality gate keeps detection)', () => {
    const f = classifyResource(
      res,
      {
        Description: 'cdkrd hunt',
        ParameterNameValues: { 'query-ttl-millis': '60000', 'record-ttl-millis': '300000' },
      },
      emptySchema
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['ParameterNameValues']);
  });
});

describe('#1532 DAX Cluster first-run folds', () => {
  const res: DesiredResource = {
    logicalId: 'Cluster',
    resourceType: 'AWS::DAX::Cluster',
    physicalId: 'cdkrdhuntdax0712c-cluster',
    declared: {
      IAMRoleARN: 'arn:aws:iam::111111111111:role/dax',
      NodeType: 'dax.t3.small',
      ReplicationFactor: 1,
      SubnetGroupName: 'sg-group',
    },
  };
  const live = (over: Record<string, unknown> = {}) => ({
    IAMRoleARN: 'arn:aws:iam::111111111111:role/dax',
    NodeType: 'dax.t3.small',
    SubnetGroupName: 'sg-group',
    ClusterEndpointEncryptionType: 'NONE',
    ParameterGroupName: 'default.dax1.0',
    PreferredMaintenanceWindow: 'sun:04:00-sun:05:00',
    SecurityGroupIds: ['sg-0defau1t'],
    ...over,
  });
  const defaultSgIds = new Set(['sg-0defau1t']);

  it('folds all four AWS-assigned values on a clean first run (zero potential drift)', () => {
    const f = classifyResource(res, live(), emptySchema, { defaultSgIds });
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
    for (const p of [
      'ParameterGroupName',
      'PreferredMaintenanceWindow',
      'SecurityGroupIds',
      'ClusterEndpointEncryptionType',
    ]) {
      expect(pathsByTier(f, 'atDefault')).toContain(p);
    }
  });

  it('surfaces an out-of-band parameter-group swap (equality gate)', () => {
    const f = classifyResource(res, live({ ParameterGroupName: 'custom-pg' }), emptySchema, {
      defaultSgIds,
    });
    expect(pathsByTier(f, 'undeclared')).toEqual(['ParameterGroupName']);
  });

  it('surfaces an out-of-band SG swap to a non-default group (#889 gate)', () => {
    const f = classifyResource(res, live({ SecurityGroupIds: ['sg-0rogue'] }), emptySchema, {
      defaultSgIds,
    });
    expect(pathsByTier(f, 'undeclared')).toEqual(['SecurityGroupIds']);
  });

  it('surfaces an out-of-band SG append (2+ groups, #889 gate)', () => {
    const f = classifyResource(
      res,
      live({ SecurityGroupIds: ['sg-0defau1t', 'sg-0rogue'] }),
      emptySchema,
      { defaultSgIds }
    );
    expect(pathsByTier(f, 'undeclared')).toEqual(['SecurityGroupIds']);
  });

  it('fails OPEN on the SG gate when the default-SG prefetch is unavailable', () => {
    const f = classifyResource(res, live(), emptySchema);
    expect(pathsByTier(f, 'undeclared')).toEqual([]);
  });
});

describe('#1532 DAX ParameterGroup revert writes the engine defaults (set-default)', () => {
  it('an out-of-band TTL change reverts via an add op carrying the KNOWN_DEFAULTS values', () => {
    // DAX has no ResetParameterGroup API, so a bare `remove` is un-expressible (the SDK
    // writer throws "cannot be cleared"). REVERT_SET_DEFAULT_PATHS turns the revert into an
    // explicit write of the constant engine defaults — live-proven to converge (2026-07-12:
    // query-ttl-millis 60000 → revert → 300000, CLEAN after revert).
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'ParamGroup',
      physicalId: 'paramgroup-x',
      resourceType: 'AWS::DAX::ParameterGroup',
      path: 'ParameterNameValues',
      actual: { 'query-ttl-millis': '60000', 'record-ttl-millis': '300000' },
    };
    const plan = buildRevertPlan([f], undefined);
    expect(plan.items[0]!.ops[0]).toMatchObject({
      op: 'add',
      path: '/ParameterNameValues',
      value: { 'query-ttl-millis': '300000', 'record-ttl-millis': '300000' },
    });
  });
});

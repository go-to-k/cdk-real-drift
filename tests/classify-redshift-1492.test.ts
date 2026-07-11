// #1492: a clean, un-mutated Redshift deploy produced two first-run [Potential Drift] (fold gaps)
// before any record (live us-east-1, 2026-07-12):
//   Cluster.VpcSecurityGroupIds   = ["sg-<default>"]   (the VPC default SG)
//   PauseAction.Enable            = true               (AWS enables a new schedule by default)
// FP1: AWS::Redshift::Cluster was simply not registered in the default-SG-list mechanism (the #976
// Neptune shape). FP2: AWS::Redshift::ScheduledAction.Enable default true is a stable constant.
import { describe, expect, it } from 'vite-plus/test';
import { DEFAULT_SG_LIST_TYPES } from '../src/commands/gather.js';
import { classifyResource, shouldFoldDefaultSgList } from '../src/diff/classify.js';
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

const DEFAULT_SG = 'sg-0a26e23e2310ee0c9';
const ROGUE_SG = 'sg-0deadbeefdeadbeef';
const tierOf = (findings: Finding[], path: string) => findings.find((f) => f.path === path)?.tier;

describe('#1492 FP1 Redshift::Cluster VpcSecurityGroupIds default-SG gate', () => {
  const res: DesiredResource = {
    logicalId: 'Cluster',
    resourceType: 'AWS::Redshift::Cluster',
    physicalId: 'huntredshift',
    // A cluster that declares no VpcSecurityGroupIds (the barest shape).
    declared: { NodeType: 'ra3.large', ClusterType: 'single-node' },
  };
  const defaultSgIds = new Set([DEFAULT_SG]);

  it('folds a single VPC-default SG to atDefault (undeclared, gated)', () => {
    const f = classifyResource(res, { VpcSecurityGroupIds: [DEFAULT_SG] }, emptySchema, {
      defaultSgIds,
    });
    expect(tierOf(f, 'VpcSecurityGroupIds')).toBe('atDefault');
  });

  it('surfaces an out-of-band SG APPEND (2-element list)', () => {
    const f = classifyResource(res, { VpcSecurityGroupIds: [DEFAULT_SG, ROGUE_SG] }, emptySchema, {
      defaultSgIds,
    });
    expect(tierOf(f, 'VpcSecurityGroupIds')).toBe('undeclared');
  });

  it('surfaces an out-of-band SG SWAP (single non-default SG)', () => {
    const f = classifyResource(res, { VpcSecurityGroupIds: [ROGUE_SG] }, emptySchema, {
      defaultSgIds,
    });
    expect(tierOf(f, 'VpcSecurityGroupIds')).toBe('undeclared');
  });

  it('shouldFoldDefaultSgList: fold the default, surface the swap, fail open when unresolved', () => {
    const t = 'AWS::Redshift::Cluster';
    expect(shouldFoldDefaultSgList(t, 'VpcSecurityGroupIds', [DEFAULT_SG], defaultSgIds)).toBe(
      true
    );
    expect(shouldFoldDefaultSgList(t, 'VpcSecurityGroupIds', [ROGUE_SG], defaultSgIds)).toBe(false);
    expect(shouldFoldDefaultSgList(t, 'VpcSecurityGroupIds', [ROGUE_SG], undefined)).toBe(true);
  });

  it('gather registers Redshift::Cluster so the default-SG prefetch fires (classify/gather sync)', () => {
    // Miss the gather side and the prefetch never fires → defaultSgIds empty → the fold fails open
    // and an OOB swap/append is silently NOT detected. This guards that sync trap.
    expect(DEFAULT_SG_LIST_TYPES.has('AWS::Redshift::Cluster')).toBe(true);
  });
});

describe('#1492 FP2 Redshift::ScheduledAction Enable constant default', () => {
  const res: DesiredResource = {
    logicalId: 'PauseAction',
    resourceType: 'AWS::Redshift::ScheduledAction',
    physicalId: 'huntpause',
    // A ScheduledAction that declares no Enable.
    declared: { ScheduledActionName: 'pause', Schedule: 'cron(0 22 * * ? *)' },
  };

  it('folds the default Enable=true to atDefault', () => {
    const f = classifyResource(res, { Enable: true }, emptySchema);
    expect(tierOf(f, 'Enable')).toBe('atDefault');
  });

  it('surfaces an out-of-band disable (Enable=false)', () => {
    const f = classifyResource(res, { Enable: false }, emptySchema);
    expect(tierOf(f, 'Enable')).toBe('undeclared');
  });
});

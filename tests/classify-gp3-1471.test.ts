// #1471 — a gp3 EC2::Volume that declares no Iops/Throughput reads back AWS's gp3 baseline (3000
// IOPS + 125 MiB/s, size-independent) undeclared → first-run [Potential Drift]. #640 covered only
// gp2 (size-derived Iops); gp3 needs its own fixed-baseline derived fold. classify folds both
// atDefault when they equal the baseline, and surfaces a value provisioned away from it.
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
  logicalId: 'R',
  resourceType: 'AWS::EC2::Volume',
  physicalId: 'phys',
  declared,
});

describe('#1471 gp3 EC2::Volume undeclared Iops/Throughput baseline fold', () => {
  const gp3 = mk({ VolumeType: 'gp3', Size: 10 });

  it('folds the gp3 baseline Iops 3000 + Throughput 125 on a clean deploy', () => {
    const f = classifyResource(gp3, { Iops: 3000, Throughput: 125 }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('Iops');
    expect(tier(f, 'atDefault')).toContain('Throughput');
    expect(tier(f, 'undeclared')).not.toContain('Iops');
    expect(tier(f, 'undeclared')).not.toContain('Throughput');
  });

  it('is size-INDEPENDENT — a large gp3 still folds the fixed baseline (not gp2-style 3*Size)', () => {
    const big = mk({ VolumeType: 'gp3', Size: 4000 });
    const f = classifyResource(big, { Iops: 3000, Throughput: 125 }, emptySchema);
    expect(tier(f, 'atDefault')).toContain('Iops');
    expect(tier(f, 'atDefault')).toContain('Throughput');
  });

  it('SURFACES an Iops provisioned above the baseline (detection preserved)', () => {
    const f = classifyResource(gp3, { Iops: 6000, Throughput: 125 }, emptySchema);
    expect(tier(f, 'undeclared')).toContain('Iops');
    expect(tier(f, 'atDefault')).not.toContain('Iops');
  });

  it('SURFACES a Throughput provisioned above the baseline (detection preserved)', () => {
    const f = classifyResource(gp3, { Iops: 3000, Throughput: 250 }, emptySchema);
    expect(tier(f, 'undeclared')).toContain('Throughput');
    expect(tier(f, 'atDefault')).not.toContain('Throughput');
  });

  it('does NOT fold Throughput for a gp2 volume (gp2 has no Throughput knob)', () => {
    const gp2 = mk({ VolumeType: 'gp2', Size: 10 });
    const f = classifyResource(gp2, { Throughput: 125 }, emptySchema);
    expect(tier(f, 'atDefault')).not.toContain('Throughput');
  });
});

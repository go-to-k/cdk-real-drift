// #1070 — a few "constant" undeclared defaults are actually a function of an ACCOUNT/REGION-level
// setting the owner can change (a documented hardening control): ECS containerInsights, SSM default
// parameter tier, EBS encryption-by-default. A fixed KNOWN_DEFAULTS pin therefore FPs on every fresh
// deploy in an account that adopted the setting. gather.ts prefetches the effective setting into
// opts.accountDefaults; classify now DERIVE-gates the fold against it:
//   - live value EQUAL to the account default folds atDefault (clean deploy, no drift);
//   - a value CHANGED away from the account default surfaces as `undeclared` (an out-of-band edit);
//   - NO prefetch (denied/unavailable) FAILS OPEN to today's behavior — the factory KNOWN_DEFAULTS
//     constant (ECS/SSM) or plain `undeclared` (EBS, which has no constant).
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
// Declare NOTHING for the gated property, so the live value reaches the UNDECLARED fold path.
const mk = (resourceType: string, declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'R',
  resourceType,
  physicalId: 'phys',
  declared,
});

describe('#1070 ECS::Cluster containerInsights — account-derived default', () => {
  const res = mk('AWS::ECS::Cluster', { ClusterName: 'c' });
  const live = (v: string) => ({ ClusterSettings: [{ Name: 'containerInsights', Value: v }] });

  it('folds atDefault when the live value equals the account default (Insights ENABLED account)', () => {
    const f = classifyResource(res, live('enabled'), emptySchema, {
      accountDefaults: { ecsContainerInsights: 'enabled' },
    });
    expect(tier(f, 'atDefault')).toContain('ClusterSettings');
    expect(tier(f, 'undeclared')).not.toContain('ClusterSettings');
  });

  it('folds the newer `enhanced` account default too', () => {
    const f = classifyResource(res, live('enhanced'), emptySchema, {
      accountDefaults: { ecsContainerInsights: 'enhanced' },
    });
    expect(tier(f, 'atDefault')).toContain('ClusterSettings');
  });

  it('SURFACES an out-of-band disable in an Insights-enabled account (real downgrade)', () => {
    const f = classifyResource(res, live('disabled'), emptySchema, {
      accountDefaults: { ecsContainerInsights: 'enabled' },
    });
    expect(tier(f, 'undeclared')).toContain('ClusterSettings');
    expect(tier(f, 'atDefault')).not.toContain('ClusterSettings');
  });

  it('fail-open: no prefetch → factory KNOWN_DEFAULTS constant (disabled folds, enabled surfaces)', () => {
    // Insights disabled is the factory default → folds via the constant even without the prefetch.
    const disabled = classifyResource(res, live('disabled'), emptySchema, {});
    expect(tier(disabled, 'atDefault')).toContain('ClusterSettings');
    // Insights enabled with NO prefetch surfaces (today's behavior — the constant is 'disabled').
    const enabled = classifyResource(res, live('enabled'), emptySchema, {});
    expect(tier(enabled, 'undeclared')).toContain('ClusterSettings');
  });
});

describe('#1070 SSM::Parameter Tier — account-derived default', () => {
  const res = mk('AWS::SSM::Parameter', { Name: '/p', Type: 'String', Value: 'x' });

  it('folds atDefault when live Tier equals the account default (default-tier = Advanced)', () => {
    const f = classifyResource(res, { Tier: 'Advanced' }, emptySchema, {
      accountDefaults: { ssmParameterTier: 'Advanced' },
    });
    expect(tier(f, 'atDefault')).toContain('Tier');
    expect(tier(f, 'undeclared')).not.toContain('Tier');
  });

  it('SURFACES a Tier that differs from the account default', () => {
    const f = classifyResource(res, { Tier: 'Standard' }, emptySchema, {
      accountDefaults: { ssmParameterTier: 'Advanced' },
    });
    expect(tier(f, 'undeclared')).toContain('Tier');
    expect(tier(f, 'atDefault')).not.toContain('Tier');
  });

  it('fail-open: no prefetch → factory constant (Standard folds, Advanced surfaces)', () => {
    const std = classifyResource(res, { Tier: 'Standard' }, emptySchema, {});
    expect(tier(std, 'atDefault')).toContain('Tier');
    const adv = classifyResource(res, { Tier: 'Advanced' }, emptySchema, {});
    expect(tier(adv, 'undeclared')).toContain('Tier');
  });
});

describe('#1070 EC2::Volume Encrypted — account-derived default (EBS encryption-by-default)', () => {
  // A volume that declares no `Encrypted`; live reads back true when the account enabled EBS
  // encryption-by-default. No KNOWN_DEFAULTS constant exists for it — the fold ONLY exists via the
  // prefetch, so fail-open keeps today's behavior (surfaces).
  const res = mk('AWS::EC2::Volume', { Size: 10, VolumeType: 'gp3' });

  it('folds atDefault when encryption-by-default is ON and the volume reads Encrypted:true', () => {
    const f = classifyResource(res, { Encrypted: true }, emptySchema, {
      accountDefaults: { ebsEncryptionByDefault: true },
    });
    expect(tier(f, 'atDefault')).toContain('Encrypted');
    expect(tier(f, 'undeclared')).not.toContain('Encrypted');
  });

  it('SURFACES Encrypted:true when the account default is OFF (not account-derived)', () => {
    const f = classifyResource(res, { Encrypted: true }, emptySchema, {
      accountDefaults: { ebsEncryptionByDefault: false },
    });
    expect(tier(f, 'undeclared')).toContain('Encrypted');
    expect(tier(f, 'atDefault')).not.toContain('Encrypted');
  });

  it('fail-open: no prefetch → no fold (Encrypted:true surfaces, today`s behavior)', () => {
    const f = classifyResource(res, { Encrypted: true }, emptySchema, {});
    expect(tier(f, 'undeclared')).toContain('Encrypted');
    expect(tier(f, 'atDefault')).not.toContain('Encrypted');
  });
});

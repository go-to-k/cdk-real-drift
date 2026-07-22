// #1278 / #1263 — the EB `aws:ec2:instances|InstanceTypes` option used to fold
// VALUE-INDEPENDENT (EB_OPTION_VALUE_INDEPENDENT), so ANY value folded to `atDefault`.
// But InstanceTypes is the option a real out-of-band resize sets
// (`aws elasticbeanstalk update-environment --option-settings
// Namespace=aws:ec2:instances,OptionName=InstanceTypes,Value=p4d.24xlarge`), and EB mirrors
// the legacy `aws:autoscaling:launchconfiguration|InstanceType` scalar to match — so a silent
// p4d.24xlarge cost bomb folded through BOTH keys and read CLEAN (#1278). It also left the
// #893 InstanceType == InstanceTypes[0] derived gate anchored on an unvalidated (value-
// independent) source (#1263).
//
// InstanceTypes now folds ONLY when every element is one of the environment architecture's
// AWS-assigned default burstable types — a tier-2 DERIVED default keyed on the sibling
// `aws:ec2:instances|SupportedArchitectures` option (x86_64 → t3.micro/t3.small,
// arm64 → t4g.micro/t4g.small; x86_64 when the sibling is unset). Any other first element
// surfaces (`undeclared`).
import { describe, expect, it } from 'vite-plus/test';
import { ebOptionSettingTier } from '../src/normalize/noise.js';

const NS = 'aws:ec2:instances';
const OPT = 'InstanceTypes';

// Classify an InstanceTypes value with a given SupportedArchitectures sibling.
function tier(value: string, supportedArchitectures?: string): 'atDefault' | 'undeclared' {
  const siblingOption = (ns: string, opt: string): unknown =>
    ns === 'aws:ec2:instances' && opt === 'SupportedArchitectures'
      ? supportedArchitectures
      : undefined;
  return ebOptionSettingTier(NS, OPT, value, 'LoadBalanced', siblingOption);
}

describe('#1278 EB InstanceTypes folds against the architecture-derived default set', () => {
  it('folds the x86_64 default pair (sibling unset → x86_64)', () => {
    expect(tier('t3.micro, t3.small')).toBe('atDefault');
  });

  it('folds the single-element x86_64 default (harvested corpus form)', () => {
    expect(tier('t3.micro')).toBe('atDefault');
  });

  it('folds the x86_64 default when SupportedArchitectures is explicitly x86_64', () => {
    expect(tier('t3.micro, t3.small', 'x86_64')).toBe('atDefault');
  });

  it('SURFACES an out-of-band p4d.24xlarge resize (the silent cost bomb #1278)', () => {
    expect(tier('p4d.24xlarge')).toBe('undeclared');
    expect(tier('p4d.24xlarge', 'x86_64')).toBe('undeclared');
  });

  it('surfaces a bump even when only one element is non-default', () => {
    expect(tier('t3.micro, p4d.24xlarge')).toBe('undeclared');
  });

  it('surfaces a larger burstable bump away from the default (t3.2xlarge)', () => {
    expect(tier('t3.2xlarge')).toBe('undeclared');
  });

  it('folds the arm64 default pair when SupportedArchitectures is arm64', () => {
    expect(tier('t4g.micro, t4g.small', 'arm64')).toBe('atDefault');
  });

  // #1685 (ebarm-hunt 2026-07-22): the docs pair above was never what a live arm64 env
  // gets — AWS assigned "t4g.micro, t4g.large", which first-run-FP'd against the
  // docs-only set. The arm64 row is now the union of observed + documented pairs.
  it('folds the LIVE arm64 default pair t4g.micro,t4g.large (#1685)', () => {
    expect(tier('t4g.micro, t4g.large', 'arm64')).toBe('atDefault');
  });

  it('still SURFACES an arm64 family bump away from t4g burstables (#1685)', () => {
    expect(tier('m7g.large', 'arm64')).toBe('undeclared');
    expect(tier('t4g.micro, c7g.xlarge', 'arm64')).toBe('undeclared');
  });

  it('SURFACES an arm64 cost bomb (p4d) resize', () => {
    expect(tier('p4d.24xlarge', 'arm64')).toBe('undeclared');
  });

  it('surfaces the x86 default pair when the environment is arm64 (wrong-arch, not the default)', () => {
    // t3.* are not the arm64 default — an arm64 env showing t3 is a real (non-default) config.
    expect(tier('t3.micro, t3.small', 'arm64')).toBe('undeclared');
  });

  it('fails open (folds) for an unknown/future architecture rather than false-positive', () => {
    expect(tier('anything.large', 'riscv128')).toBe('atDefault');
  });

  it('folds an unset/empty value', () => {
    expect(tier('')).toBe('atDefault');
  });
});

// #1263 — with InstanceTypes now gated, the #893 legacy-scalar gate
// (InstanceType == InstanceTypes[0]) anchors on a VALIDATED option: a resize that moves BOTH
// keys together still surfaces via InstanceTypes, while the mirrored scalar folds (no double
// report). A legacy-only skew where InstanceType diverges from InstanceTypes[0] surfaces.
describe('#1263 InstanceType scalar gate anchors on the now-validated InstanceTypes option', () => {
  function instanceTypeTier(
    instanceType: string,
    instanceTypes: string
  ): 'atDefault' | 'undeclared' {
    const siblingOption = (ns: string, opt: string): unknown =>
      ns === 'aws:ec2:instances' && opt === 'InstanceTypes' ? instanceTypes : undefined;
    return ebOptionSettingTier(
      'aws:autoscaling:launchconfiguration',
      'InstanceType',
      instanceType,
      'LoadBalanced',
      siblingOption
    );
  }

  it('folds the mirrored scalar when it equals InstanceTypes[0] (bump reported once via InstanceTypes)', () => {
    // Both bumped to p4d: InstanceTypes surfaces the cost bomb; the scalar mirror folds.
    expect(instanceTypeTier('p4d.24xlarge', 'p4d.24xlarge')).toBe('atDefault');
    expect(tier('p4d.24xlarge')).toBe('undeclared');
  });

  it('surfaces a legacy-only scalar bump that diverges from InstanceTypes[0]', () => {
    expect(instanceTypeTier('p4d.24xlarge', 't3.micro, t3.small')).toBe('undeclared');
  });
});

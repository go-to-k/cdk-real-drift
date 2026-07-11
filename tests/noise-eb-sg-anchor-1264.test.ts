// #1264 — the EB SecurityGroups fold (#893) folded to `atDefault` when every
// comma-separated element merely CONTAINED "awseb" (an UNANCHORED `/awseb/i` substring).
// A user/attacker-controllable SG name that happens to contain "awseb"
// (`my-awseb-backdoor`, a lone `awseb-backdoor`) then folded, hiding a rogue security
// group. The fold must fire ONLY for EB's own anchored generated-group shapes:
//   - `awseb-e-<envid>-stack-AWSEBSecurityGroup-<suffix>` (the `awseb-e-` env prefix);
//   - a name carrying the exact `AWSEBSecurityGroup` / `AWSEBLoadBalancerSecurityGroup`
//     CFn logical fragment, or the bare `AWSEB…SecurityGroup` logical id (Ref echo).
// Anything else → `undeclared` (surfaces).
import { describe, expect, it } from 'vite-plus/test';
import { ebOptionSettingTier } from '../src/normalize/noise.js';

const KEY_NS = 'aws:autoscaling:launchconfiguration';
const KEY_OPT = 'SecurityGroups';
const ELB_NS = 'aws:elb:loadbalancer';

function tier(value: string, ns = KEY_NS, opt = KEY_OPT): 'atDefault' | 'undeclared' {
  return ebOptionSettingTier(ns, opt, value, 'LoadBalanced');
}

describe('#1264 EB SecurityGroups fold anchors on the generated-group shape', () => {
  it('folds the resolved awseb-e-…-AWSEBSecurityGroup-… generated name', () => {
    expect(tier('awseb-e-abc123-stack-AWSEBSecurityGroup-XYZ')).toBe('atDefault');
  });

  it('folds the bare AWSEBSecurityGroup logical-id (Ref echo)', () => {
    expect(tier('AWSEBSecurityGroup')).toBe('atDefault');
  });

  it('folds the load-balancer generated group on the ELB namespace', () => {
    expect(tier('awseb-e-abc123-stack-AWSEBLoadBalancerSecurityGroup-Q', ELB_NS)).toBe('atDefault');
  });

  it('folds when every element is a generated group', () => {
    expect(tier('awseb-e-abc123-stack-AWSEBSecurityGroup-XYZ,AWSEBLoadBalancerSecurityGroup')).toBe(
      'atDefault'
    );
  });

  it('surfaces a rogue backdoor mixed in with a generated group (#1264)', () => {
    expect(tier('awseb-e-abc123-stack-AWSEBSecurityGroup-Y,my-awseb-backdoor')).toBe('undeclared');
  });

  it('surfaces a lone awseb-backdoor (contains "awseb" but is not a generated shape)', () => {
    expect(tier('awseb-backdoor')).toBe('undeclared');
  });

  it('surfaces a rogue SG whose name merely contains awseb as a substring', () => {
    expect(tier('my-awseb-backdoor')).toBe('undeclared');
  });

  it('surfaces an explicit user-supplied sg-… id', () => {
    expect(tier('sg-0123456789abcdef0')).toBe('undeclared');
  });
});

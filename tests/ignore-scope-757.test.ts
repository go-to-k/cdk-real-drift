// Issue #757: the `ignore` verb / check's inline ignore used to write an UNSCOPED rule
// (just `{ path }`), whose absent scopes are match-all — so ignoring a within-stack path
// on one stack silently stopped watching the identical path on a same-named twin stack in
// every account/region, a durable false negative. The fix stamps the current stack /
// account / region identity onto each written rule so it only silences the SAME
// stack+account+region.
import { describe, expect, it } from 'vite-plus/test';
import {
  applyIgnores,
  type CdkrdConfig,
  type IgnoreScope,
  ignoreRuleFor,
} from '../src/config/config-file.js';
import type { Finding } from '../src/types.js';

const cfg = (ignore: CdkrdConfig['ignore']): CdkrdConfig => ({ ignore });
const sc = (stackName: string, accountId: string, region: string): IgnoreScope => ({
  stackName,
  accountId,
  region,
});

// A within-stack declared finding — the exact shape a user would ignore on one stack.
const finding = (): Finding => ({
  tier: 'declared',
  logicalId: 'ApiRole1234ABCD',
  constructPath: 'DevStack/ApiRole',
  resourceType: 'AWS::IAM::Role',
  path: 'Policies',
  desired: [{}],
  actual: [{ extra: true }],
});

describe('ignoreRuleFor stamps the current identity scope (issue #757)', () => {
  it('returns a rule carrying stack, account, and region — not just path', () => {
    const rule = ignoreRuleFor(finding(), 'DevStack', '111111111111', 'us-east-1');
    expect(rule).toEqual({
      path: 'ApiRole.Policies',
      stack: 'DevStack',
      account: '111111111111',
      region: 'us-east-1',
    });
  });

  it('omits a scope field that is genuinely unavailable (empty string), never writes stack: ""', () => {
    // no account/region known → those axes stay absent (match-any); a `stack: ""` glob
    // would match nothing and silently disable the rule, so it must not be written.
    expect(ignoreRuleFor(finding(), 'DevStack')).toEqual({
      path: 'ApiRole.Policies',
      stack: 'DevStack',
    });
    // with no stackName the stack prefix is not stripped and no scope is stamped
    expect(ignoreRuleFor(finding())).toEqual({ path: 'DevStack/ApiRole.Policies' });
  });
});

describe('the scoped rule no longer leaks across stacks/accounts/regions (issue #757)', () => {
  it('re-tags the SAME-identity finding but NOT a twin on a different stack/account/region', () => {
    // What the `ignore` verb now writes when the user ignores this finding on DevStack.
    const rule = ignoreRuleFor(finding(), 'DevStack', '111111111111', 'us-east-1');
    const config = cfg([rule]);

    // Same stack + account + region → silenced (re-tagged `ignored`).
    expect(
      applyIgnores([finding()], sc('DevStack', '111111111111', 'us-east-1'), config)[0]?.tier
    ).toBe('ignored');

    // The identical within-stack path on a DIFFERENT stack → still reported (the leak fixed).
    expect(
      applyIgnores([finding()], sc('ProdStack', '111111111111', 'us-east-1'), config)[0]?.tier
    ).toBe('declared');

    // Same stack name, DIFFERENT account → still reported (stack names are unique per account).
    expect(
      applyIgnores([finding()], sc('DevStack', '222222222222', 'us-east-1'), config)[0]?.tier
    ).toBe('declared');

    // Same stack + account, DIFFERENT region → still reported.
    expect(
      applyIgnores([finding()], sc('DevStack', '111111111111', 'eu-west-1'), config)[0]?.tier
    ).toBe('declared');
  });
});

// #805 — SDK writers that re-read the live model at apply time and re-canonicalize it
// (desiredModel for the policy writers, writeWafv2WebAcl) fix raw-vs-canonical ORDER, not index
// FRESHNESS. A revert op's numeric index (`…/Statement/1/Resource`, `/Rules/1/Action`) was
// computed against the CHECK-time model; if a statement/rule is added, removed, or reordered while
// the user sits on the confirm prompt (#760), the canonically-sorted FRESH array puts a DIFFERENT
// element at that index — so the whole-document PUT would corrupt an innocent (security-relevant)
// element AND write it. `assertIndexedPriorsFresh` fails CLOSED: before applying an index-bearing
// op it asserts the fresh node at the pointer still equals the op's `prior` (the check-time value),
// throwing (an honest FAILED the caller records as not-reverted) on any mismatch, so nothing is
// written. This is the SDK-path twin of #762/#853's Cloud Control `test` precondition.
import { GetWebACLCommand, UpdateWebACLCommand, WAFV2Client } from '@aws-sdk/client-wafv2';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import type { OverrideCtx } from '../src/read/overrides.js';
import type { PatchOp } from '../src/revert/plan.js';
import { SDK_WRITERS, assertIndexedPriorsFresh } from '../src/revert/writers.js';

const ctx = (over: Partial<OverrideCtx> = {}): OverrideCtx => ({
  physicalId: 'pid',
  declared: {},
  region: 'us-east-1',
  accountId: '123456789012',
  ...over,
});

describe('#805 assertIndexedPriorsFresh — precondition on index-bearing revert ops', () => {
  const op = (path: string, prior: unknown): PatchOp => ({
    op: 'add',
    path,
    value: 'anything',
    prior,
    human: 'x',
  });

  it('passes when the fresh node at the index still equals the check-time prior', () => {
    const fresh = { Statement: [{ Resource: 'arn:a' }, { Resource: 'arn:b' }] };
    expect(() =>
      assertIndexedPriorsFresh('AWS::S3::BucketPolicy', fresh, [
        op('/Statement/1/Resource', 'arn:b'),
      ])
    ).not.toThrow();
  });

  it('throws when the element at the index changed since check (reordered / replaced)', () => {
    // Someone added a statement out of band while the user sat on the confirm prompt, so the
    // canonically-sorted fresh array now has a DIFFERENT statement at index 1 than classify saw.
    const fresh = { Statement: [{ Resource: 'arn:a' }, { Resource: 'arn:NEW' }] };
    expect(() =>
      assertIndexedPriorsFresh('AWS::S3::BucketPolicy', fresh, [
        op('/Statement/1/Resource', 'arn:b'),
      ])
    ).toThrow(/changed since check/);
  });

  it('throws when the indexed element was removed (index now beyond array length)', () => {
    const fresh = { Statement: [{ Resource: 'arn:a' }] };
    expect(() =>
      assertIndexedPriorsFresh('AWS::S3::BucketPolicy', fresh, [
        op('/Statement/1/Resource', 'arn:b'),
      ])
    ).toThrow(/changed since check/);
  });

  it('does not check a non-indexed scalar pointer (a named property is stable under reorder)', () => {
    // Even a differing value: a named top-level prop cannot be aliased by an array reorder, so it
    // is not this guard's concern — the whole-document write still carries the desired value.
    const fresh = { Description: 'now-different' };
    expect(() =>
      assertIndexedPriorsFresh('AWS::WAFv2::WebACL', fresh, [op('/Description', 'was-this')])
    ).not.toThrow();
  });

  it('skips an index-bearing op with an undefined prior (an append at a new index)', () => {
    const fresh = { Statement: [{ Resource: 'arn:a' }] };
    expect(() =>
      assertIndexedPriorsFresh('AWS::S3::BucketPolicy', fresh, [
        op('/Statement/1/Resource', undefined),
      ])
    ).not.toThrow();
  });
});

describe('#805 WAFv2 WebACL writer aborts a stale-index revert before UpdateWebACL', () => {
  const wafv2 = mockClient(WAFV2Client);
  const PID = 'cdkrd-acl|abc-123|REGIONAL';
  beforeEach(() => wafv2.reset());

  // GetWebACL returns two rules; canonicalizeForCompare sorts them by Name to [alpha, zeta], so a
  // finding op on `/Rules/1/Action` targets ZETA. `prior` carries the Action classify saw on zeta.
  const stubGet = (zetaAction: unknown): void => {
    wafv2.on(GetWebACLCommand).resolves({
      LockToken: 'LOCK1',
      WebACL: {
        Name: 'cdkrd-acl',
        Id: 'abc-123',
        DefaultAction: { Allow: {} },
        Rules: [
          { Name: 'zeta', Priority: 0, Action: zetaAction },
          { Name: 'alpha', Priority: 1, Action: { Block: {} } },
        ],
        VisibilityConfig: {
          SampledRequestsEnabled: false,
          CloudWatchMetricsEnabled: true,
          MetricName: 'm',
        },
      },
    } as never);
    wafv2.on(UpdateWebACLCommand).resolves({});
  };
  const ruleActionOp = (prior: unknown): PatchOp => ({
    op: 'add',
    path: '/Rules/1/Action',
    value: { Block: {} },
    prior,
    human: 'Rules.1.Action -> deployed-template value',
  });

  it('aborts (no UpdateWebACL) when zeta.Action changed out of band since check', async () => {
    // check saw zeta.Action = Allow; the live rule is now Block (out-of-band change while the user
    // confirmed). The whole-ACL PUT would otherwise re-write zeta with the wrong basis.
    stubGet({ Block: {} });
    await expect(
      SDK_WRITERS['AWS::WAFv2::WebACL'](ctx({ physicalId: PID }), [ruleActionOp({ Allow: {} })])
    ).rejects.toThrow(/changed since check/);
    expect(wafv2.commandCalls(UpdateWebACLCommand)).toHaveLength(0);
  });

  it('proceeds to UpdateWebACL when the fresh zeta.Action still matches prior', async () => {
    stubGet({ Allow: {} });
    await SDK_WRITERS['AWS::WAFv2::WebACL'](ctx({ physicalId: PID }), [
      ruleActionOp({ Allow: {} }),
    ]);
    const calls = wafv2.commandCalls(UpdateWebACLCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as unknown as {
      Rules: { Name: string; Action: unknown }[];
    };
    // the op landed on ZETA (index aligned to the sorted model), leaving ALPHA untouched
    const zeta = input.Rules.find((r) => r.Name === 'zeta')!;
    const alpha = input.Rules.find((r) => r.Name === 'alpha')!;
    expect(zeta.Action).toEqual({ Block: {} });
    expect(alpha.Action).toEqual({ Block: {} });
  });
});

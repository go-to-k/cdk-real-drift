import { describe, expect, it } from 'vite-plus/test';
import { type RevertItem, toPatchDocument } from '../src/revert/plan.js';

// #762: a Cloud Control revert patch for an INDEX-BEARING pointer (`/Prop/0/Sub`) is
// positional — it addresses "whatever element is at index 0 right now". If the live array
// shifts (prepend/reorder in a same-length object array) between check/gather time and the
// user confirming the revert, a bare mutating op corrupts a SIBLING element. The fix emits a
// preceding RFC6902 `test` precondition asserting the addressed location still equals the
// value classify diffed against (`op.prior` = the finding's live `actual`), so Cloud Control
// REJECTS the whole patch on a shift instead of writing the wrong element.

const item = (ops: RevertItem['ops']): RevertItem => ({
  logicalId: 'Dist',
  displayId: 'Dist',
  resourceType: 'AWS::CloudFront::Distribution',
  physicalId: 'ABCDEF',
  kind: 'cc',
  ops,
});

describe('#762 CC index patch test-preconditions', () => {
  it('an index-bearing `add` op gets a preceding `test` asserting the live (prior) value', () => {
    const doc = JSON.parse(
      toPatchDocument(
        item([
          {
            op: 'add',
            path: '/CacheBehaviors/0/ViewerProtocolPolicy',
            value: 'https-only',
            prior: 'allow-all', // what classify saw live at that index
            human: 'CacheBehaviors[0].ViewerProtocolPolicy -> deployed-template value',
          },
        ])
      )
    );
    // the `test` precedes the mutating op and asserts the LIVE (prior) value at the pointer
    expect(doc).toEqual([
      { op: 'test', path: '/CacheBehaviors/0/ViewerProtocolPolicy', value: 'allow-all' },
      { op: 'add', path: '/CacheBehaviors/0/ViewerProtocolPolicy', value: 'https-only' },
    ]);
  });

  it('an index-bearing `remove` op gets a preceding `test` (leaf value), then a bare remove', () => {
    const doc = JSON.parse(
      toPatchDocument(
        item([
          {
            op: 'remove',
            path: '/Origins/1/CustomHeaders',
            prior: [{ HeaderName: 'X', HeaderValue: 'secret' }],
            human: 'Origins[1].CustomHeaders -> remove (undeclared)',
          },
        ])
      )
    );
    expect(doc).toEqual([
      {
        op: 'test',
        path: '/Origins/1/CustomHeaders',
        value: [{ HeaderName: 'X', HeaderValue: 'secret' }],
      },
      { op: 'remove', path: '/Origins/1/CustomHeaders' },
    ]);
  });

  it('a NON-indexed scalar op gets NO spurious `test` (no aliasing risk, keep patch minimal)', () => {
    const doc = JSON.parse(
      toPatchDocument(
        item([
          {
            op: 'add',
            path: '/Comment',
            value: 'intended',
            prior: 'drifted',
            human: 'Comment -> deployed-template value',
          },
        ])
      )
    );
    expect(doc).toEqual([{ op: 'add', path: '/Comment', value: 'intended' }]);
  });

  it('an index-bearing op with NO prior (undefined) emits NO test (cannot assert an absent value)', () => {
    const doc = JSON.parse(
      toPatchDocument(
        item([
          {
            op: 'add',
            path: '/Aliases/0',
            value: 'a.example.com',
            // no `prior` — e.g. a removed-undeclared re-add where actual was undefined
            human: 'Aliases[0] -> restore baseline value',
          },
        ])
      )
    );
    expect(doc).toEqual([{ op: 'add', path: '/Aliases/0', value: 'a.example.com' }]);
  });

  it('mixed ops: only the index-bearing one is guarded, order preserved', () => {
    const doc = JSON.parse(
      toPatchDocument(
        item([
          { op: 'add', path: '/Comment', value: 'x', prior: 'y', human: 'Comment' },
          {
            op: 'add',
            path: '/CacheBehaviors/2/Compress',
            value: true,
            prior: false,
            human: 'CacheBehaviors[2].Compress',
          },
        ])
      )
    );
    expect(doc).toEqual([
      { op: 'add', path: '/Comment', value: 'x' },
      { op: 'test', path: '/CacheBehaviors/2/Compress', value: false },
      { op: 'add', path: '/CacheBehaviors/2/Compress', value: true },
    ]);
  });

  it('a top-level array-INDEX scalar (`/Prop/0`) is also guarded (positional element)', () => {
    const doc = JSON.parse(
      toPatchDocument(
        item([
          {
            op: 'remove',
            path: '/CustomErrorResponses/0',
            prior: { ErrorCode: 404 },
            human: 'CustomErrorResponses[0] -> remove',
          },
        ])
      )
    );
    expect(doc).toEqual([
      { op: 'test', path: '/CustomErrorResponses/0', value: { ErrorCode: 404 } },
      { op: 'remove', path: '/CustomErrorResponses/0' },
    ]);
  });
});

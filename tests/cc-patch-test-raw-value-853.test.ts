import { describe, expect, it } from 'vite-plus/test';
import { type RevertItem, toPatchDocument } from '../src/revert/plan.js';

// #853: the RFC6902 `test` precondition (#762) asserts the addressed location still equals
// what classify diffed against — but `op.prior` = the finding's CANONICALIZED `f.actual`
// (aws:* tags stripped, readOnly/writeOnly stripped, `canonicalizeIdArraysDeep` SORTS sg-/
// subnet-id arrays, policy documents canonicalized, WAF `SearchString` base64-DECODED). Cloud
// Control evaluates `test` against its RAW resource model. Whenever normalization transformed
// the value at (or under) the tested pointer, the canonical `prior` mismatches the raw model
// and CC rejects the WHOLE patch though nothing raced — revert of genuine drift always fails
// (LIVE-confirmed on AWS::ECR::RegistryPolicy: the Action array is canonicalize-SORTED vs the
// raw model's append-last order). The fix sources the `test` VALUE from the RAW live model.

const item = (ops: RevertItem['ops'], liveRaw?: Record<string, unknown>): RevertItem => ({
  logicalId: 'R',
  displayId: 'R',
  resourceType: 'AWS::Test::Resource',
  physicalId: 'PID',
  kind: 'cc',
  ops,
  ...(liveRaw !== undefined && { liveRaw }),
});

describe('#853 CC index `test` value comes from the RAW live model, not canonical prior', () => {
  it('ECR RegistryPolicy Action array: `test` asserts the RAW (append-last) order, not the sorted prior', () => {
    // The live raw model appends the rogue action LAST; classify SORTS it into `prior`.
    const rawActions = ['ecr:ReplicateImage', 'ecr:BatchImportUpstreamImage'];
    const sortedPrior = ['ecr:BatchImportUpstreamImage', 'ecr:ReplicateImage'];
    const liveRaw = {
      PolicyText: { Statement: [{ Action: rawActions }] },
    };
    const doc = JSON.parse(
      toPatchDocument(
        item(
          [
            {
              op: 'add',
              path: '/PolicyText/Statement/0/Action',
              value: ['ecr:ReplicateImage'], // deployed-template intent
              prior: sortedPrior, // canonicalize-SORTED f.actual
              human: 'PolicyText.Statement[0].Action -> deployed-template value',
            },
          ],
          liveRaw
        )
      )
    );
    expect(doc).toEqual([
      // the `test` value is the RAW (unsorted) array, so CC's own raw model matches it
      { op: 'test', path: '/PolicyText/Statement/0/Action', value: rawActions },
      { op: 'add', path: '/PolicyText/Statement/0/Action', value: ['ecr:ReplicateImage'] },
    ]);
    // regression guard: it must NOT be the sorted canonical value
    expect(doc[0].value).not.toEqual(sortedPrior);
  });

  it('sorted sg-id array under an indexed pointer: `test` uses the RAW (AWS-order) list', () => {
    const rawGroups = ['sg-333', 'sg-111', 'sg-222']; // AWS order in the raw model
    const sortedPrior = ['sg-111', 'sg-222', 'sg-333']; // canonicalizeIdArraysDeep sorted
    const liveRaw = {
      NetworkInterfaces: [{ GroupSet: rawGroups }],
    };
    const doc = JSON.parse(
      toPatchDocument(
        item(
          [
            {
              op: 'add',
              path: '/NetworkInterfaces/0/GroupSet',
              value: ['sg-111'],
              prior: sortedPrior,
              human: 'NetworkInterfaces[0].GroupSet -> deployed-template value',
            },
          ],
          liveRaw
        )
      )
    );
    expect(doc).toEqual([
      { op: 'test', path: '/NetworkInterfaces/0/GroupSet', value: rawGroups },
      { op: 'add', path: '/NetworkInterfaces/0/GroupSet', value: ['sg-111'] },
    ]);
  });

  it('WAF SearchString: `test` uses the RAW base64 value, not the decoded prior', () => {
    const rawSearch = 'YmFkc3RyaW5n'; // base64 in the raw CC model
    const decodedPrior = 'badstring'; // classify base64-DECODES SearchString
    const liveRaw = {
      Rules: [
        {
          Statement: { ByteMatchStatement: { SearchString: rawSearch } },
        },
      ],
    };
    const doc = JSON.parse(
      toPatchDocument(
        item(
          [
            {
              op: 'add',
              path: '/Rules/0/Statement/ByteMatchStatement/SearchString',
              value: 'good',
              prior: decodedPrior,
              human: 'Rules[0]…SearchString -> deployed-template value',
            },
          ],
          liveRaw
        )
      )
    );
    expect(doc[0]).toEqual({
      op: 'test',
      path: '/Rules/0/Statement/ByteMatchStatement/SearchString',
      value: rawSearch,
    });
    expect(doc[0].value).not.toEqual(decodedPrior);
  });

  it('the raw live model carried ON the item (item.liveRaw) is used when no explicit arg', () => {
    const rawGroups = ['sg-b', 'sg-a'];
    const doc = JSON.parse(
      toPatchDocument(
        item(
          [
            {
              op: 'add',
              path: '/NetworkInterfaces/0/GroupSet',
              value: ['sg-a'],
              prior: ['sg-a', 'sg-b'], // sorted
              human: 'x',
            },
          ],
          rawGroups.length ? { NetworkInterfaces: [{ GroupSet: rawGroups }] } : undefined
        )
      )
      // NOTE: no second arg — liveRaw defaults to item.liveRaw
    );
    expect(doc[0].value).toEqual(rawGroups);
  });

  it('falls back to `prior` when NO raw model is available (offline / no gather)', () => {
    const doc = JSON.parse(
      toPatchDocument(
        item([
          {
            op: 'add',
            path: '/CacheBehaviors/0/ViewerProtocolPolicy',
            value: 'https-only',
            prior: 'allow-all',
            human: 'x',
          },
        ])
        // no liveRaw on the item, no explicit arg
      )
    );
    expect(doc).toEqual([
      { op: 'test', path: '/CacheBehaviors/0/ViewerProtocolPolicy', value: 'allow-all' },
      { op: 'add', path: '/CacheBehaviors/0/ViewerProtocolPolicy', value: 'https-only' },
    ]);
  });

  it('falls back to `prior` (fails-closed) when the pointer does NOT resolve — the index shifted away', () => {
    // The raw model has only ONE element, so `/Rules/2/...` is absent → keep the #762 guard
    // firing on the canonical prior (a shift should still REJECT the patch, not silently drop).
    const liveRaw = { Rules: [{ Statement: {} }] };
    const doc = JSON.parse(
      toPatchDocument(
        item(
          [
            {
              op: 'remove',
              path: '/Rules/2/Statement/ByteMatchStatement/SearchString',
              prior: 'canonical',
              human: 'x',
            },
          ],
          liveRaw
        )
      )
    );
    expect(doc).toEqual([
      {
        op: 'test',
        path: '/Rules/2/Statement/ByteMatchStatement/SearchString',
        value: 'canonical',
      },
      { op: 'remove', path: '/Rules/2/Statement/ByteMatchStatement/SearchString' },
    ]);
  });

  it('a RAW value of `null` at the pointer is a real value (not "absent"), so `test` asserts null', () => {
    const liveRaw = { Rules: [{ Setting: null }] };
    const doc = JSON.parse(
      toPatchDocument(
        item(
          [
            {
              op: 'add',
              path: '/Rules/0/Setting',
              value: 'x',
              prior: 'canonical-nonnull',
              human: 'x',
            },
          ],
          liveRaw
        )
      )
    );
    // raw is null → test asserts null (matching CC's raw model), NOT the canonical prior
    expect(doc[0]).toEqual({ op: 'test', path: '/Rules/0/Setting', value: null });
  });

  it('a non-indexed scalar op still gets NO `test`, even with a raw model present', () => {
    const doc = JSON.parse(
      toPatchDocument(
        item([{ op: 'add', path: '/Comment', value: 'intended', prior: 'drifted', human: 'x' }], {
          Comment: 'raw-drifted',
        })
      )
    );
    expect(doc).toEqual([{ op: 'add', path: '/Comment', value: 'intended' }]);
  });
});

// #864 — stripAwsTagsDeep must not strip `aws:*`-keyed elements from tag-FILTER
// properties (CodeDeploy Ec2TagFilters/Ec2TagSet, ResourceGroups TagFilters, DLM
// TargetTags). Those elements share the `{Key,...}` tag-element shape but are DECLARED
// targeting intent (select resources BY an `aws:*` tag), not tag LISTS — stripping the
// live echo leaves declared `[{Key:'aws:...'}]` vs live `[]`, a permanent declared FP.
// The genuine-`Tags`-list strip must still work.
import { describe, expect, it } from 'vite-plus/test';
import { stripAwsTagsDeep } from '../src/normalize/noise.js';

describe('#864 stripAwsTagsDeep tag-FILTER exclusion', () => {
  it('preserves an aws:* CodeDeploy Ec2TagFilters element on both sides', () => {
    const declared = {
      Ec2TagFilters: [
        { Key: 'aws:cloudformation:stack-name', Value: 'MyStack', Type: 'KEY_AND_VALUE' },
      ],
    };
    // The service echoes the declared filter verbatim, so the live side is identical.
    const live = {
      Ec2TagFilters: [
        { Key: 'aws:cloudformation:stack-name', Value: 'MyStack', Type: 'KEY_AND_VALUE' },
      ],
    };
    // Regression assertion: without the fix, the live element is stripped → [] and the
    // two sides diverge into a permanent declared-tier FP.
    expect(stripAwsTagsDeep(live)).toEqual(declared);
    expect(stripAwsTagsDeep(live)).toEqual(live);
    expect((stripAwsTagsDeep(live) as typeof live).Ec2TagFilters).toHaveLength(1);
  });

  it('preserves an aws:* CodeDeploy Ec2TagSet element (nested under Ec2TagGroup)', () => {
    const live = {
      Ec2TagSet: {
        Ec2TagSetList: [
          {
            Ec2TagGroup: [
              { Key: 'aws:cloudformation:stack-name', Value: 'MyStack', Type: 'KEY_AND_VALUE' },
            ],
          },
        ],
      },
    };
    // The CodeDeploy Ec2TagSet filter elements live under Ec2TagSetList[].Ec2TagGroup,
    // so the immediate array parent is `Ec2TagGroup` — which is in AWS_TAG_FILTER_PROPS.
    expect(stripAwsTagsDeep(live)).toEqual(live);
    expect(
      (stripAwsTagsDeep(live) as typeof live).Ec2TagSet.Ec2TagSetList[0].Ec2TagGroup
    ).toHaveLength(1);
  });

  it('preserves an aws:* ResourceGroups Query.TagFilters element', () => {
    const live = {
      Query: {
        TagFilters: [{ Key: 'aws:cloudformation:stack-name', Values: ['MyStack'] }],
      },
    };
    expect(stripAwsTagsDeep(live)).toEqual(live);
    expect((stripAwsTagsDeep(live) as typeof live).Query.TagFilters).toHaveLength(1);
  });

  it('preserves an aws:* DLM TargetTags element', () => {
    const live = { TargetTags: [{ Key: 'aws:cloudformation:stack-name', Value: 'MyStack' }] };
    expect(stripAwsTagsDeep(live)).toEqual(live);
    expect((stripAwsTagsDeep(live) as typeof live).TargetTags).toHaveLength(1);
  });

  it('still strips aws:* elements from a genuine Tags list', () => {
    const live = {
      Tags: [
        { Key: 'aws:cloudformation:stack-name', Value: 'MyStack' },
        { Key: 'MyTag', Value: 'mine' },
      ],
    };
    expect(stripAwsTagsDeep(live)).toEqual({ Tags: [{ Key: 'MyTag', Value: 'mine' }] });
  });

  it('still strips aws:* map keys under a Tags map', () => {
    const live = { Tags: { 'aws:cloudformation:stack-name': 'MyStack', MyTag: 'mine' } };
    expect(stripAwsTagsDeep(live)).toEqual({ Tags: { MyTag: 'mine' } });
  });
});

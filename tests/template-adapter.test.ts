import { describe, expect, it } from 'vite-plus/test';
import {
  buildResolverContext,
  collectRolesWithSiblingPolicies,
  parseTemplateBody,
} from '../src/desired/template-adapter.js';

describe('collectRolesWithSiblingPolicies', () => {
  it('finds roles referenced by a sibling AWS::IAM::Policy', () => {
    const resources = {
      MyRole: { Type: 'AWS::IAM::Role' },
      MyPolicy: { Type: 'AWS::IAM::Policy', Properties: { Roles: [{ Ref: 'MyRole' }] } },
      Other: { Type: 'AWS::S3::Bucket' },
    };
    expect([...collectRolesWithSiblingPolicies(resources)]).toEqual(['MyRole']);
  });

  it('ignores non-Ref role entries and non-policy resources', () => {
    const resources = {
      P: { Type: 'AWS::IAM::Policy', Properties: { Roles: ['literal-name'] } },
      Q: { Type: 'AWS::IAM::ManagedPolicy', Properties: { Roles: [{ Ref: 'R' }] } },
    };
    expect(collectRolesWithSiblingPolicies(resources).size).toBe(0); // literal not a Ref; ManagedPolicy not Policy
  });
});

describe('buildResolverContext', () => {
  it('merges template defaults with deployed params (deployed wins) + sets pseudo', () => {
    const template = {
      Parameters: { Env: { Default: 'dev' }, Other: { Default: 'x' } },
      Conditions: { C: true },
    };
    const ctx = buildResolverContext(
      template,
      { Env: 'prod' },
      { Log: 'phys' },
      'us-west-2',
      '999',
      'S',
      'arn:stack'
    );
    expect(ctx.params.Env).toBe('prod'); // deployed value wins
    expect(ctx.params.Other).toBe('x'); // template default kept
    expect(ctx.pseudo['AWS::Region']).toBe('us-west-2');
    expect(ctx.pseudo['AWS::AccountId']).toBe('999');
    expect(ctx.physIds.Log).toBe('phys');
    expect(ctx.conditions.C).toBe(true);
  });
});

describe('parseTemplateBody', () => {
  it('parses JSON and YAML bodies', () => {
    expect(parseTemplateBody('{"Resources":{}}')).toEqual({ Resources: {} });
    expect(parseTemplateBody('Resources: {}')).toEqual({ Resources: {} });
  });
});

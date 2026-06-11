import { describe, expect, it } from 'vite-plus/test';
import { stripCcApiAwsManagedFields } from '../src/normalize/cc-api-strip.js';
import {
  isAllAwsTags,
  isTrivialEmpty,
  KNOWN_DEFAULTS,
  stripAwsTagsDeep,
} from '../src/normalize/noise.js';
import { parseSchema } from '../src/schema/schema-strip.js';

describe('noise suppressors', () => {
  it('isTrivialEmpty: false / "" / [] / {} only', () => {
    expect(isTrivialEmpty(false)).toBe(true);
    expect(isTrivialEmpty('')).toBe(true);
    expect(isTrivialEmpty([])).toBe(true);
    expect(isTrivialEmpty({})).toBe(true);
    expect(isTrivialEmpty(0)).toBe(false); // 0 may be meaningful
    expect(isTrivialEmpty('x')).toBe(false);
    expect(isTrivialEmpty(true)).toBe(false);
  });

  it('isAllAwsTags: every element an aws:* {Key,Value}', () => {
    expect(isAllAwsTags([{ Key: 'aws:cloudformation:stack-id', Value: 'x' }])).toBe(true);
    expect(
      isAllAwsTags([
        { Key: 'aws:x', Value: '1' },
        { Key: 'Team', Value: 'a' },
      ])
    ).toBe(false);
    expect(isAllAwsTags([])).toBe(false);
    expect(isAllAwsTags('nope')).toBe(false);
  });

  it('isAllAwsTags: map shape (SSM) where every key is aws:*', () => {
    expect(
      isAllAwsTags({ 'aws:cloudformation:stack-name': 'S', 'aws:cloudformation:logical-id': 'X' })
    ).toBe(true);
    expect(isAllAwsTags({ 'aws:x': '1', Team: 'a' })).toBe(false);
    expect(isAllAwsTags({})).toBe(false);
  });

  it('IAM Role known defaults present', () => {
    expect(KNOWN_DEFAULTS['AWS::IAM::Role'].MaxSessionDuration).toBe(3600);
  });

  it('stripAwsTagsDeep removes aws:* tags (list + map), keeps the rest', () => {
    expect(
      stripAwsTagsDeep([
        { Key: 'aws:cloudformation:stack-name', Value: 'S' },
        { Key: 'aws-cdk:x', Value: 'y' },
      ])
    ).toEqual([{ Key: 'aws-cdk:x', Value: 'y' }]);
    expect(stripAwsTagsDeep({ Tags: { 'aws:cf': '1', Team: 'a' } })).toEqual({
      Tags: { Team: 'a' },
    });
  });
});

describe('cc-api strip', () => {
  it('removes managed fields at any depth, keeps the rest', () => {
    const out = stripCcApiAwsManagedFields({
      Name: 'n',
      Arn: 'a',
      CreationDate: 't',
      Nested: { LastModifiedTime: 't', Keep: 1 },
    });
    expect(out).toEqual({ Name: 'n', Arn: 'a', Nested: { Keep: 1 } }); // Arn intentionally kept
  });
});

describe('parseSchema', () => {
  it('reduces JSON-pointer paths to top-level names + extracts defaults', () => {
    const info = parseSchema(
      JSON.stringify({
        readOnlyProperties: ['/properties/Arn', '/properties/Lifecycle/Rules/*/X'],
        writeOnlyProperties: ['/properties/AccessControl'],
        properties: { Path: { default: '/' }, Name: {} },
      })
    );
    expect([...info.readOnly]).toEqual(['Arn']); // nested path NOT promoted to top-level
    expect(info.readOnlyPaths).toContain('Lifecycle.Rules.*.X');
    expect([...info.writeOnly]).toEqual(['AccessControl']);
    expect(info.defaults).toEqual({ Path: '/' });
  });
});

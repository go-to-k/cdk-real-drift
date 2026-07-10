import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// #723 — the parent-side AWS::CloudFormation::Stack resource of every CDK NestedStack is
// CC-read and returns the child's FULL live model, but the template declares only
// TemplateURL + Parameters + Tags. Three live props are therefore always UNDECLARED and
// surfaced on a clean first check (core-invariant violation), the worst being TemplateBody
// = the entire child template as one string (also a revert hazard: reverting it issues a
// CC UpdateResource against the live child stack). They are AWS-assigned / per-deploy and
// cannot be pinned or derived, so they fold value-independent (tier 3).
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
const tier = (fs: Finding[], t: string): string[] =>
  fs
    .filter((f) => f.tier === t)
    .map((f) => f.path)
    .sort();
const declared = {
  TemplateURL: 'https://s3.amazonaws.com/cdk-hnb659fds-assets/abc.json',
  Parameters: { referencetoParentBucket: 'parent-bucket' },
};
const mk = (): DesiredResource => ({
  logicalId: 'ChildNestedStackResource',
  resourceType: 'AWS::CloudFormation::Stack',
  physicalId: 'arn:aws:cloudformation:us-east-1:111111111111:stack/Child/uuid',
  declared,
});

describe('#723 nested-stack AWS::CloudFormation::Stack undeclared folds', () => {
  it('folds undeclared TemplateBody / RoleARN / Capabilities to atDefault (zero first-run FP)', () => {
    const f = classifyResource(
      mk(),
      {
        ...declared,
        TemplateBody: '{"Resources":{"CDKMetadata":{"Type":"AWS::CDK::Metadata"}}}',
        RoleARN:
          'arn:aws:iam::111111111111:role/cdk-hnb659fds-cfn-exec-role-111111111111-us-east-1',
        Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_AUTO_EXPAND'],
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toEqual(
      expect.arrayContaining(['Capabilities', 'RoleARN', 'TemplateBody'])
    );
    for (const p of ['TemplateBody', 'RoleARN', 'Capabilities'])
      expect(tier(f, 'undeclared')).not.toContain(p);
  });

  it('value-independent: any TemplateBody folds (it moves on every legitimate child redeploy)', () => {
    const f = classifyResource(
      mk(),
      {
        ...declared,
        TemplateBody: '{"Resources":{"NewChildResource":{"Type":"AWS::SQS::Queue"}}}',
      },
      emptySchema
    );
    expect(tier(f, 'atDefault')).toContain('TemplateBody');
    expect(tier(f, 'undeclared')).not.toContain('TemplateBody');
  });
});

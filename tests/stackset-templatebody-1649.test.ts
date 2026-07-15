// #1649 — StackSet TemplateBody first-run FP. An asset-based StackSet (CDK
// `StackSetTemplate.fromStackSetStack`) declares TemplateURL (write-only -> readGap)
// while the live read returns the materialized TemplateBody — the entire child template
// as one string — which surfaced as [Potential Drift] on every first check.
// AWS::CloudFormation::Stack already folds TemplateBody value-independently (#723);
// this adds the same entry for AWS::CloudFormation::StackSet. A DECLARED TemplateBody
// stays compared in the declared dimension (detection preserved for users who declare it).
import { describe, expect, it } from 'vite-plus/test';
import { classifyResource } from '../src/diff/classify.js';
import type { DesiredResource, Finding, SchemaInfo } from '../src/types.js';

// The StackSet registry schema marks TemplateURL writeOnly (why the declared side is a
// readGap, never a compare) and StackSetId readOnly.
const stackSetSchema: SchemaInfo = {
  readOnly: new Set(['StackSetId']),
  writeOnly: new Set(['TemplateURL']),
  createOnly: new Set(['StackSetName', 'PermissionModel']),
  readOnlyPaths: ['StackSetId'],
  writeOnlyPaths: ['TemplateURL'],
  createOnlyPaths: ['StackSetName', 'PermissionModel'],
  defaults: {},
  defaultPaths: {},
};
const BODY = '{"Resources":{"Topic":{"Type":"AWS::SNS::Topic"}}}';
const mk = (declared: Record<string, unknown>): DesiredResource => ({
  logicalId: 'ConfigStackSet',
  resourceType: 'AWS::CloudFormation::StackSet',
  physicalId: 'my-stackset:1111-2222',
  declared,
});
// FULL tier:path list (not tier-filtered) so double-reporting cannot hide (#747).
const all = (fs: Finding[]) => fs.map((f) => `${f.tier}:${f.path}`).sort();

describe('#1649 StackSet TemplateBody value-independent fold', () => {
  it('folds the UNDECLARED materialized TemplateBody of an asset-based StackSet — zero first-run drift', () => {
    const findings = classifyResource(
      mk({
        StackSetName: 'my-stackset',
        PermissionModel: 'SELF_MANAGED',
        TemplateURL: 'https://s3.us-east-1.amazonaws.com/cdk-assets/abc123.json',
      }),
      { StackSetName: 'my-stackset', PermissionModel: 'SELF_MANAGED', TemplateBody: BODY },
      stackSetSchema
    );
    // FULL list: the body folds atDefault (value-independent) and the write-only declared
    // TemplateURL stays an honest readGap — no undeclared leak, no declared finding.
    expect(all(findings)).toEqual(['atDefault:TemplateBody', 'readGap:TemplateURL']);
  });

  it('a DECLARED TemplateBody is still compared — declared drift surfaces', () => {
    const findings = classifyResource(
      mk({ StackSetName: 'my-stackset', PermissionModel: 'SELF_MANAGED', TemplateBody: BODY }),
      {
        StackSetName: 'my-stackset',
        PermissionModel: 'SELF_MANAGED',
        TemplateBody:
          '{"Resources":{"Topic":{"Type":"AWS::SNS::Topic","Properties":{"FifoTopic":true}}}}',
      },
      stackSetSchema
    );
    const declared = findings.filter((f) => f.tier === 'declared');
    expect(declared.map((f) => f.path)).toContain('TemplateBody');
    // the value-independent fold must NOT also swallow it into atDefault
    expect(all(findings).filter((p) => p === 'atDefault:TemplateBody')).toEqual([]);
  });

  it('a declared TemplateBody equal to the live one is clean', () => {
    const findings = classifyResource(
      mk({ StackSetName: 'my-stackset', PermissionModel: 'SELF_MANAGED', TemplateBody: BODY }),
      { StackSetName: 'my-stackset', PermissionModel: 'SELF_MANAGED', TemplateBody: BODY },
      stackSetSchema
    );
    expect(all(findings)).toEqual([]);
  });
});

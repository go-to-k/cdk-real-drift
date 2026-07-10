import { BatchGetProjectsCommand, CodeBuildClient } from '@aws-sdk/client-codebuild';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { SDK_OVERRIDES } from '../src/read/overrides.js';

// #1299 — readCodeBuildProject projected Tags (#1056) but OMITTED the other writable
// COLLECTION / config props BatchGetProjects returns: Triggers (from webhook),
// SecondarySources, SecondaryArtifacts, SecondarySourceVersions, BuildBatchConfig,
// AutoRetryLimit. For a project that DECLARES any of them, the live read carried NO
// counterpart, so the classify "removed collection" branch emitted a false DECLARED
// drift (actual=undefined) on every clean deploy. These tests FAIL without the
// projection (the model lacks the props) and PASS with it.
const codebuild = mockClient(CodeBuildClient);

const ctx = (declared: Record<string, unknown>, physicalId = '', accountId = '123456789012') => ({
  physicalId,
  declared,
  region: 'us-east-1',
  accountId,
});

beforeEach(() => {
  codebuild.reset();
});

describe('CodeBuild Project reader (#1299) — writable collection / config projection', () => {
  it('projects Triggers from webhook, SecondarySources/Artifacts/SourceVersions, BuildBatchConfig, AutoRetryLimit', async () => {
    codebuild.on(BatchGetProjectsCommand).resolves({
      projects: [
        {
          name: 'p',
          arn: 'arn:aws:codebuild:us-east-1:1:project/p',
          source: { type: 'GITHUB', location: 'https://github.com/o/r.git' },
          artifacts: { type: 'NO_ARTIFACTS' },
          secondarySources: [
            {
              type: 'GITHUB',
              location: 'https://github.com/o/lib.git',
              sourceIdentifier: 'lib',
              gitCloneDepth: 1,
              insecureSsl: false,
            },
          ],
          secondaryArtifacts: [
            {
              type: 'S3',
              location: 'bkt',
              path: 'out',
              namespaceType: 'BUILD_ID',
              packaging: 'ZIP',
              name: 'lib.zip',
              artifactIdentifier: 'libArtifact',
            },
          ],
          secondarySourceVersions: [{ sourceIdentifier: 'lib', sourceVersion: 'main' }],
          buildBatchConfig: {
            serviceRole: 'arn:aws:iam::1:role/batch',
            combineArtifacts: true,
            timeoutInMins: 60,
            batchReportMode: 'REPORT_INDIVIDUAL_BUILDS',
            restrictions: {
              maximumBuildsAllowed: 10,
              computeTypesAllowed: ['BUILD_GENERAL1_SMALL'],
            },
          },
          autoRetryLimit: 2,
          webhook: {
            url: 'https://api.github.com/hook/1', // AWS-managed, must NOT appear
            buildType: 'BUILD',
            filterGroups: [
              [
                { type: 'EVENT', pattern: 'PUSH' },
                { type: 'HEAD_REF', pattern: '^refs/heads/main$', excludeMatchedPattern: false },
              ],
            ],
          },
        },
      ],
    });
    const out = (await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'p'))) as Record<
      string,
      unknown
    >;

    // The core #1299 assertions: each collection now has a live counterpart so classify
    // sees actual != undefined and does NOT report a false declared drift.
    expect(out.SecondarySources).toEqual([
      {
        Type: 'GITHUB',
        Location: 'https://github.com/o/lib.git',
        SourceIdentifier: 'lib',
        GitCloneDepth: 1,
        InsecureSsl: false,
      },
    ]);
    expect(out.SecondaryArtifacts).toEqual([
      {
        Type: 'S3',
        Location: 'bkt',
        Path: 'out',
        NamespaceType: 'BUILD_ID',
        Packaging: 'ZIP',
        Name: 'lib.zip',
        ArtifactIdentifier: 'libArtifact',
      },
    ]);
    expect(out.SecondarySourceVersions).toEqual([
      { SourceIdentifier: 'lib', SourceVersion: 'main' },
    ]);
    expect(out.BuildBatchConfig).toEqual({
      ServiceRole: 'arn:aws:iam::1:role/batch',
      CombineArtifacts: true,
      TimeoutInMins: 60,
      BatchReportMode: 'REPORT_INDIVIDUAL_BUILDS',
      Restrictions: {
        MaximumBuildsAllowed: 10,
        ComputeTypesAllowed: ['BUILD_GENERAL1_SMALL'],
      },
    });
    expect(out.AutoRetryLimit).toBe(2);
    // The CFn Triggers.Webhook boolean IS the presence of the SDK webhook object; the
    // AWS-managed webhook url is NOT a CFn-declarable field, so it must not leak.
    expect(out.Triggers).toEqual({
      Webhook: true,
      BuildType: 'BUILD',
      FilterGroups: [
        [
          { Type: 'EVENT', Pattern: 'PUSH' },
          { Type: 'HEAD_REF', Pattern: '^refs/heads/main$', ExcludeMatchedPattern: false },
        ],
      ],
    });
  });

  it('emits none of the collection / config props for a plain project (no first-run noise)', async () => {
    codebuild.on(BatchGetProjectsCommand).resolves({
      projects: [{ name: 'p', source: { type: 'NO_SOURCE' }, artifacts: { type: 'NO_ARTIFACTS' } }],
    });
    const out = (await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'p'))) as Record<
      string,
      unknown
    >;
    expect(out.Triggers).toBeUndefined();
    expect(out.SecondarySources).toBeUndefined();
    expect(out.SecondaryArtifacts).toBeUndefined();
    expect(out.SecondarySourceVersions).toBeUndefined();
    expect(out.BuildBatchConfig).toBeUndefined();
    expect(out.AutoRetryLimit).toBeUndefined();
  });

  it('an EMPTY secondary array emits nothing (guarded on non-empty)', async () => {
    codebuild.on(BatchGetProjectsCommand).resolves({
      projects: [
        {
          name: 'p',
          source: { type: 'NO_SOURCE' },
          artifacts: { type: 'NO_ARTIFACTS' },
          secondarySources: [],
          secondaryArtifacts: [],
          secondarySourceVersions: [],
        },
      ],
    });
    const out = (await SDK_OVERRIDES['AWS::CodeBuild::Project'](ctx({}, 'p'))) as Record<
      string,
      unknown
    >;
    expect(out.SecondarySources).toBeUndefined();
    expect(out.SecondaryArtifacts).toBeUndefined();
    expect(out.SecondarySourceVersions).toBeUndefined();
  });
});

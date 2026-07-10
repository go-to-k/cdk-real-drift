import { describe, expect, it } from 'vite-plus/test';
import { FREE_FORM_MAP_PARENTS, TAG_PROPERTY_NAMES } from '../src/normalize/cc-api-strip.js';
import { stripAwsTagsDeep } from '../src/normalize/noise.js';

// #1300: primary/secondary tag property names from the CFn registry's
// tagInformation.tagPropertyName metadata were missing from TAG_PROPERTY_NAMES,
// causing (a) #862 first-run map-key FPs (aws:cloudformation:* keys surfacing) and
// (b) #952 revert drops of live aws:* managed tags.
describe('#1300 registry tag property names', () => {
  const NEW_NAMES = [
    'TieringConfigurationTags', // AWS::Backup::TieringConfiguration (map)
    'FrameworkTags', // AWS::Backup::Framework
    'ReportPlanTags', // AWS::Backup::ReportPlan
    'PipelineTags', // AWS::DataPipeline::Pipeline
    'AccessPointTags', // AWS::EFS::AccessPoint
    'BotAliasTags', // AWS::Lex::BotAlias
    'HealthCheckTags', // AWS::Route53::HealthCheck
    'TestBotAliasTags', // AWS::Lex::Bot secondary
    'TestAliasTags', // AWS::Bedrock::Agent / Flow secondary (map)
  ];

  it('membership gate: every new name is in TAG_PROPERTY_NAMES (revert preservation + aws:* strip)', () => {
    for (const name of NEW_NAMES) {
      expect(TAG_PROPERTY_NAMES.has(name)).toBe(true);
    }
  });

  it('map-shaped names are also in FREE_FORM_MAP_PARENTS (name-strip exemption)', () => {
    expect(FREE_FORM_MAP_PARENTS.has('TieringConfigurationTags')).toBe(true);
    expect(FREE_FORM_MAP_PARENTS.has('TestAliasTags')).toBe(true);
  });

  it('map-shaped strip: aws:cloudformation:* keys are stripped, user keys survive', () => {
    const live = {
      TieringConfigurationTags: {
        'aws:cloudformation:stack-name': 'x',
        'aws:cloudformation:logical-id': 'y',
        UserKey: 'z',
      },
    };
    const stripped = stripAwsTagsDeep(live) as {
      TieringConfigurationTags: Record<string, unknown>;
    };
    expect(stripped.TieringConfigurationTags).toEqual({ UserKey: 'z' });
  });
});

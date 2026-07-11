import {
  CloudFormationClient,
  DescribeStacksCommand,
  GetTemplateCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it, vi } from 'vite-plus/test';
import { changedDefaultParamInfo, loadDesired } from '../src/desired/template-adapter.js';

// #1292: under --pre-deploy a CHANGED local param Default wins over the deployed value
// (#1194) — but a plain `cdk deploy` sends UsePreviousValue: true for every EXISTING
// parameter, so the previewed drift is one the gated deploy will NOT apply. Resolution stays
// #1194's (local Default wins); changedDefaultParamInfo surfaces the divergence LOUDLY as one
// aggregated stderr note per stack, mirroring the #1215/#1221 unpreviewableParamInfo style.
describe('#1292 — changedDefaultParamInfo (--pre-deploy changed-Default caveat)', () => {
  // The canonical trigger: an existing param whose local Default changed since deploy.
  const changedTemplate = {
    Parameters: { Foo: { Type: 'String', Default: 'NEW' } },
    Resources: {
      R: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { Ref: 'Foo' } } },
    },
  };

  it('emits the note naming the param, BOTH values, and the UsePreviousValue caveat', () => {
    const note = changedDefaultParamInfo(changedTemplate, { Foo: 'OLD' }, 'MyStack');
    expect(note).not.toBeNull();
    expect(note?.startsWith('warning:')).toBe(true);
    expect(note).toContain('MyStack');
    expect(note).toContain('Foo');
    expect(note).toContain('"NEW"'); // the local Default
    expect(note).toContain('"OLD"'); // the deployed value a plain deploy keeps
    expect(note).toContain('UsePreviousValue');
    expect(note).toContain('--parameters');
    expect(note).toContain('--no-previous-parameters');
  });

  it('is null when the local Default EQUALS the deployed value (no divergence)', () => {
    expect(changedDefaultParamInfo(changedTemplate, { Foo: 'NEW' }, 'S')).toBeNull();
  });

  it('is null for a param with NO deployed value (a new param — that is #1221 territory)', () => {
    // A brand-new local param is either seeded from its Default (previewable, nothing to
    // caveat) or has no value at all (#1215/#1221's unpreviewable warning) — never this note.
    expect(changedDefaultParamInfo(changedTemplate, {}, 'S')).toBeNull();
  });

  it('is null for a param with no local Default (the deployed value fills it — no divergence)', () => {
    const template = {
      Parameters: { Bar: { Type: 'String' } },
      Resources: { R: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { Ref: 'Bar' } } } },
    };
    expect(changedDefaultParamInfo(template, { Bar: 'deployedVal' }, 'S')).toBeNull();
  });

  it('is null when the changed-Default param is not referenced anywhere (feeds no preview)', () => {
    const template = {
      Parameters: { Unused: { Type: 'String', Default: 'NEW' } },
      Resources: { R: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'literal' } } },
    };
    expect(changedDefaultParamInfo(template, { Unused: 'OLD' }, 'S')).toBeNull();
  });

  it('counts a param referenced ONLY through a Condition (it steers resource presence)', () => {
    const template = {
      Parameters: { Env: { Type: 'String', Default: 'prod' } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] } },
      Resources: { R: { Type: 'AWS::SNS::Topic', Condition: 'IsProd', Properties: {} } },
    };
    const note = changedDefaultParamInfo(template, { Env: 'dev' }, 'S');
    expect(note).toContain('Env');
  });

  it('excludes NoEcho and SSM ::Parameter::Value< params (their Defaults are never seeded)', () => {
    // A NoEcho Default is a placeholder and an SSM-typed Default is the SSM KEY — neither is
    // seeded (#744/#882), so no preview derives from them and a "differs" note would be false.
    const template = {
      Parameters: {
        Secret: { Type: 'String', NoEcho: true, Default: 'changeme' },
        Ssm: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/golden/ami' },
      },
      Resources: {
        R: { Type: 'AWS::SNS::Topic', Properties: { A: { Ref: 'Secret' }, B: { Ref: 'Ssm' } } },
      },
    };
    expect(
      changedDefaultParamInfo(template, { Secret: 'liveSecret', Ssm: 'ami-0abc' }, 'S')
    ).toBeNull();
  });

  it('does not false-note a CommaDelimitedList Default differing only in whitespace', () => {
    // CloudFormation trims list entries ("a, b" == "a,b") — mirror toParam's normalization.
    const template = {
      Parameters: { Csv: { Type: 'CommaDelimitedList', Default: 'a, b' } },
      Resources: { R: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { Ref: 'Csv' } } } },
    };
    expect(changedDefaultParamInfo(template, { Csv: 'a,b' }, 'S')).toBeNull();
    // A REAL list change still notes.
    expect(changedDefaultParamInfo(template, { Csv: 'a,c' }, 'S')).not.toBeNull();
  });

  it('caps the listed params at 10 with an overflow count', () => {
    const params: Record<string, { Type: string; Default: string }> = {};
    const deployed: Record<string, string> = {};
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) {
      const k = `P${String(i).padStart(2, '0')}`;
      params[k] = { Type: 'String', Default: 'new' };
      deployed[k] = 'old';
      props[k] = { Ref: k };
    }
    const template = {
      Parameters: params,
      Resources: { R: { Type: 'AWS::SNS::Topic', Properties: props } },
    };
    const note = changedDefaultParamInfo(template, deployed, 'S');
    expect(note).toContain('12 local parameter(s) changed their Default');
    expect(note).toContain('…(+2 more)');
  });
});

// The emission path: loadDesired prints the note to stderr ONLY under --pre-deploy
// (templateOverride set) — on the deployed path the declared source IS the deployed template,
// so its Defaults cannot "differ" in the #1292 sense and the note must never fire.
describe('#1292 — loadDesired emits the changed-Default note ONLY under --pre-deploy', () => {
  function stack(cfn: ReturnType<typeof mockClient>, deployedFoo: string): void {
    cfn.on(ListStackResourcesCommand).resolves({
      StackResourceSummaries: [
        {
          LogicalResourceId: 'Topic',
          PhysicalResourceId: 't-phys',
          ResourceType: 'AWS::SNS::Topic',
          LastUpdatedTimestamp: new Date(0),
          ResourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackId: 'arn:aws:cloudformation:us-east-1:111122223333:stack/S/x',
          StackName: 'S',
          CreationTime: new Date(0),
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [{ ParameterKey: 'Foo', ParameterValue: deployedFoo }],
        },
      ],
    });
  }

  const synthTemplate = {
    Parameters: { Foo: { Type: 'String', Default: 'NEW' } },
    Resources: {
      Topic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { Ref: 'Foo' } } },
    },
  };

  it('under --pre-deploy, a changed local Default is warned to stderr (resolution unchanged)', async () => {
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).rejects(new Error('GetTemplate must NOT be called in pre-deploy'));
    stack(cfn, 'OLD');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let msg = '';
    let desired;
    try {
      desired = await loadDesired(
        cfn as unknown as CloudFormationClient,
        'S',
        'us-east-1',
        synthTemplate
      );
      // read BEFORE mockRestore(): mockRestore() resets .mock.calls.
      msg = err.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      err.mockRestore();
    }
    expect(msg).toContain('UsePreviousValue');
    expect(msg).toContain('Foo (local Default "NEW", deployed "OLD")');
    // #1194 is KEPT: the local Default still wins in resolution — the note is additive.
    expect(desired.resources[0]!.declared).toEqual({ TopicName: 'NEW' });
  });

  it('no note when the deployed value equals the local Default', async () => {
    const cfn = mockClient(CloudFormationClient);
    cfn.on(GetTemplateCommand).rejects(new Error('GetTemplate must NOT be called in pre-deploy'));
    stack(cfn, 'NEW');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let msg = '';
    try {
      await loadDesired(cfn as unknown as CloudFormationClient, 'S', 'us-east-1', synthTemplate);
      msg = err.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      err.mockRestore();
    }
    expect(msg).not.toContain('UsePreviousValue');
  });

  it('on the NON-pre-deploy (deployed) path the note never fires', async () => {
    const cfn = mockClient(CloudFormationClient);
    // Deployed template carries the OLD Default; the deployed value differs — still no note,
    // because without --pre-deploy the deployed value wins in resolution (nothing previewed).
    cfn.on(GetTemplateCommand).resolves({ TemplateBody: JSON.stringify(synthTemplate) });
    stack(cfn, 'OLD');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let msg = '';
    try {
      await loadDesired(cfn as unknown as CloudFormationClient, 'S', 'us-east-1');
      msg = err.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      err.mockRestore();
    }
    expect(msg).not.toContain('UsePreviousValue');
  });
});

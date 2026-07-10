import { describe, expect, it } from 'vite-plus/test';
import {
  isRedactedPath,
  maskPlaceholder,
  redactFinding,
  redactValue,
} from '../src/report/redact.js';
import { buildStackJson, formatFinding, report } from '../src/report/report.js';
import type { Finding } from '../src/types.js';

// #798 — report-layer redaction: a secret-bearing live-readable VALUE (Lambda / CodeBuild
// env var, EC2 LaunchTemplate UserData, EB env-var OptionSetting) must be MASKED in BOTH
// the text report and the --json output, while the finding STILL surfaces as drift
// (detection preserved). A normal (non-secret) value must NEVER be masked.

const SECRET = 'super-secret-token-abcdef0123456789';

// A Lambda console-added env var surfaces as an undeclared per-key finding at
// `Environment.Variables.<KEY>` with the value as `actual` (classify.ts freeForm).
const lambdaEnvFinding = (): Finding => ({
  tier: 'undeclared',
  logicalId: 'Fn',
  resourceType: 'AWS::Lambda::Function',
  path: 'Environment.Variables.API_TOKEN',
  actual: SECRET,
  nested: true,
  freeFormKey: true,
});

// A CodeBuild PLAINTEXT env var surfaces at `Environment.EnvironmentVariables.<idx>.Value`.
const codeBuildEnvFinding = (): Finding => ({
  tier: 'undeclared',
  logicalId: 'Proj',
  resourceType: 'AWS::CodeBuild::Project',
  path: 'Environment.EnvironmentVariables.0.Value',
  actual: SECRET,
  nested: true,
});

// A normal (non-secret) property value — a Lambda Timeout — must print in full.
const normalFinding = (): Finding => ({
  tier: 'declared',
  logicalId: 'Fn',
  resourceType: 'AWS::Lambda::Function',
  path: 'Timeout',
  desired: 30,
  actual: 900,
});

function runText(findings: Finding[]): string {
  const lines: string[] = [];
  report(findings, 'stack (us-east-1)', { log: (s) => lines.push(s) });
  return lines.join('\n');
}

describe('#798 report redaction — text output masks secret VALUES', () => {
  it('a Lambda Environment.Variables secret value is masked in the text report', () => {
    const text = runText([lambdaEnvFinding()]);
    expect(text).not.toContain(SECRET); // plaintext never printed
    expect(text).toContain('<redacted:'); // masked placeholder present
    // the path / key stays visible (it is not secret)
    expect(text).toContain('Environment.Variables.API_TOKEN');
  });

  it('a CodeBuild EnvironmentVariables Value is masked in the text report', () => {
    const text = runText([codeBuildEnvFinding()]);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('<redacted:');
    expect(text).toContain('Environment.EnvironmentVariables.0.Value');
  });

  it('the secret finding STILL surfaces as a finding (masking never drops it)', () => {
    // a recorded (not unrecorded) undeclared secret is confirmed drift and counts
    const recorded: Finding = { ...lambdaEnvFinding(), desired: 'old-value' };
    const text = runText([recorded]);
    // the finding line is present (id.path + type), just with a masked value
    expect(text).toContain('Environment.Variables.API_TOKEN');
    expect(text).toContain('CFn-Undeclared Drift');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('old-value'); // the baseline side is masked too
  });

  it('a normal (non-secret) property value is NOT masked', () => {
    const text = runText([normalFinding()]);
    expect(text).toContain('900'); // the live Timeout prints in full
    expect(text).toContain('30');
    expect(text).not.toContain('<redacted');
  });

  it('a Lambda Environment.Variables map emitted WHOLE masks per-key values but keeps keys', () => {
    // whole-map emit (a key holds a `.`): path is `Environment.Variables`, both sides objects.
    // Masking is applied AFTER the per-key compare, so the CHANGED key still surfaces.
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'Fn',
      resourceType: 'AWS::Lambda::Function',
      path: 'Environment.Variables',
      desired: { 'a.b': 'old', KEEP: 'same' },
      actual: { 'a.b': SECRET, KEEP: 'same' },
    };
    const text = runText([f]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('old');
    expect(text).toContain('a.b'); // the changed key name stays visible
    expect(text).toContain('<redacted:'); // its value is masked
  });
});

describe('#798 report redaction — --json output masks secret VALUES', () => {
  it('a Lambda env secret is masked in the --json findings and still counts as drift', () => {
    const recorded: Finding = { ...lambdaEnvFinding(), desired: 'old-value' };
    const { json, code } = buildStackJson([recorded], 'stack (us-east-1)');
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('old-value');
    expect(serialized).toContain('<redacted:');
    // detection preserved: the finding is present and counts as drift
    expect(json.findings.length).toBe(1);
    expect(json.findings[0]?.path).toBe('Environment.Variables.API_TOKEN');
    expect(json.drifted).toBe(1);
    expect(code).toBe(1);
  });

  it('a CodeBuild env Value is masked in the --json findings', () => {
    const { json } = buildStackJson([codeBuildEnvFinding()], 'stack (us-east-1)');
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain('<redacted:');
  });

  it('a normal (non-secret) value is NOT masked in --json', () => {
    const { json } = buildStackJson([normalFinding()], 'stack (us-east-1)');
    const serialized = JSON.stringify(json);
    expect(serialized).toContain('900');
    expect(serialized).not.toContain('<redacted');
  });

  it('report() --json path also masks (single-report callers)', () => {
    const lines: string[] = [];
    report([lambdaEnvFinding()], 'stack (us-east-1)', { json: true, log: (s) => lines.push(s) });
    const out = lines.join('\n');
    expect(out).not.toContain(SECRET);
    expect(out).toContain('<redacted:');
  });
});

describe('#798 redact module unit behavior', () => {
  it('maskPlaceholder keeps the char length + a sha256 distinguisher for a string, length-less for non-string', () => {
    // #1308: `<redacted:<len> chars:<sha8>>` — the 8-hex sha256 prefix distinguishes two
    // same-length secrets. length-less form for a non-string (no stable byte string to hash).
    expect(maskPlaceholder('abcd')).toMatch(/^<redacted:4 chars:[0-9a-f]{8}>$/);
    expect(maskPlaceholder({ x: 1 })).toBe('<redacted>');
  });

  it('redactValue masks the secret paths and passes non-secret paths through unchanged', () => {
    expect(redactValue('AWS::Lambda::Function', 'Environment.Variables.T', SECRET)).toMatch(
      new RegExp(`^<redacted:${SECRET.length} chars:[0-9a-f]{8}>$`)
    );
    expect(
      redactValue('AWS::EC2::LaunchTemplate', 'LaunchTemplateData.UserData', '#!/bin/bash secret')
    ).toMatch(/^<redacted:18 chars:[0-9a-f]{8}>$/);
    // non-secret path / type -> unchanged
    expect(redactValue('AWS::Lambda::Function', 'Timeout', 900)).toBe(900);
    expect(redactValue('AWS::S3::Bucket', 'Environment.Variables.X', 'x')).toBe('x');
  });

  it('EB env-var OptionSetting masks the Value field, keeps Namespace/OptionName + other namespaces', () => {
    const entry = {
      Namespace: 'aws:elasticbeanstalk:application:environment',
      OptionName: 'DB_PASSWORD',
      Value: SECRET,
    };
    const masked = redactValue(
      'AWS::ElasticBeanstalk::Environment',
      'OptionSettings[aws:elasticbeanstalk:application:environment|DB_PASSWORD]',
      entry
    ) as Record<string, unknown>;
    expect(masked.Value).toMatch(new RegExp(`^<redacted:${SECRET.length} chars:[0-9a-f]{8}>$`));
    expect(masked.Namespace).toBe('aws:elasticbeanstalk:application:environment');
    expect(masked.OptionName).toBe('DB_PASSWORD');
    // a NON-env-namespace option value is not a secret path -> unchanged
    expect(
      redactValue(
        'AWS::ElasticBeanstalk::Environment',
        'OptionSettings[aws:autoscaling:launchconfiguration|InstanceType]',
        {
          Namespace: 'aws:autoscaling:launchconfiguration',
          OptionName: 'InstanceType',
          Value: 't3.micro',
        }
      )
    ).toEqual({
      Namespace: 'aws:autoscaling:launchconfiguration',
      OptionName: 'InstanceType',
      Value: 't3.micro',
    });
  });

  it('isRedactedPath is true only for secret paths', () => {
    expect(isRedactedPath('AWS::Lambda::Function', 'Environment.Variables.X')).toBe(true);
    expect(isRedactedPath('AWS::Lambda::Function', 'Timeout')).toBe(false);
    expect(
      isRedactedPath('AWS::CodeBuild::Project', 'Environment.EnvironmentVariables.2.Value')
    ).toBe(true);
  });

  it('redactFinding returns the finding unchanged for a non-secret path', () => {
    const f = normalFinding();
    expect(redactFinding(f)).toBe(f); // same reference — no copy for non-secret
  });

  it('formatFinding masks a secret scalar directly', () => {
    const line = formatFinding(lambdaEnvFinding());
    expect(line).not.toContain(SECRET);
    expect(line).toContain('<redacted:');
  });
});

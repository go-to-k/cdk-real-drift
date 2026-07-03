import { describe, expect, it } from 'vite-plus/test';
import { annotateHints, findingHint } from '../src/diff/hints.js';
import { report } from '../src/report/report.js';
import type { Finding } from '../src/types.js';

const INSIGHTS_LAYER =
  'arn:aws:lambda:ap-northeast-1:580247275435:layer:LambdaInsightsExtension:80';
const TRACER_POLICY =
  'arn:aws:iam::123456789012:policy/service-role/AWSLambdaTracerAccessExecutionRole-c63e7091-06fb-4d95-be6a-fcc3de761556';
const BASIC = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';

const HINT = 'CloudWatch Application Signals / Lambda Insights';

describe('findingHint — Application Signals / Lambda Insights footprint', () => {
  it('flags an undeclared Lambda Insights extension layer (whole-array path)', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'Fn',
      resourceType: 'AWS::Lambda::Function',
      path: 'Layers',
      actual: [INSIGHTS_LAYER],
    };
    expect(findingHint(f)).toContain(HINT);
  });

  it('flags the Arm64 insights layer and an indexed Layers path', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'Fn',
      resourceType: 'AWS::Lambda::Function',
      path: 'Layers[0]',
      actual: 'arn:aws:lambda:us-east-1:580247275435:layer:LambdaInsightsExtension-Arm64:20',
    };
    expect(findingHint(f)).toContain(HINT);
  });

  it('does NOT flag an ordinary user layer', () => {
    const f: Finding = {
      tier: 'undeclared',
      logicalId: 'Fn',
      resourceType: 'AWS::Lambda::Function',
      path: 'Layers',
      actual: ['arn:aws:lambda:us-east-1:111111111111:layer:my-shared-deps:3'],
    };
    expect(findingHint(f)).toBeUndefined();
  });

  it('flags the tracer policy added to a role (declared drift — only the LIVE-ONLY entry)', () => {
    const f: Finding = {
      tier: 'declared',
      logicalId: 'Role',
      resourceType: 'AWS::IAM::Role',
      path: 'ManagedPolicyArns',
      desired: [BASIC],
      actual: [TRACER_POLICY, BASIC],
    };
    expect(findingHint(f)).toContain(HINT);
  });

  it('flags the CloudWatchLambdaInsightsExecutionRolePolicy variant', () => {
    const f: Finding = {
      tier: 'declared',
      logicalId: 'Role',
      resourceType: 'AWS::IAM::Role',
      path: 'ManagedPolicyArns',
      desired: [BASIC],
      actual: [BASIC, 'arn:aws:iam::aws:policy/CloudWatchLambdaInsightsExecutionRolePolicy'],
    };
    expect(findingHint(f)).toContain(HINT);
  });

  it('does NOT flag when the tracer policy was ALREADY declared (no live-only add)', () => {
    // If the template already declares it, it is intent — not an out-of-band footprint.
    const f: Finding = {
      tier: 'declared',
      logicalId: 'Role',
      resourceType: 'AWS::IAM::Role',
      path: 'ManagedPolicyArns',
      desired: [BASIC, TRACER_POLICY],
      actual: [BASIC],
    };
    expect(findingHint(f)).toBeUndefined();
  });

  it('does NOT flag an unrelated role managed-policy drift', () => {
    const f: Finding = {
      tier: 'declared',
      logicalId: 'Role',
      resourceType: 'AWS::IAM::Role',
      path: 'ManagedPolicyArns',
      desired: [BASIC],
      actual: [BASIC, 'arn:aws:iam::aws:policy/AdministratorAccess'],
    };
    expect(findingHint(f)).toBeUndefined();
  });
});

describe('annotateHints', () => {
  it('sets hint on matching findings, leaves others and never mutates the input', () => {
    const layer: Finding = {
      tier: 'undeclared',
      logicalId: 'Fn',
      resourceType: 'AWS::Lambda::Function',
      path: 'Layers',
      actual: [INSIGHTS_LAYER],
    };
    const other: Finding = {
      tier: 'undeclared',
      logicalId: 'Fn',
      resourceType: 'AWS::Lambda::Function',
      path: 'Timeout',
      actual: 30,
    };
    const out = annotateHints([layer, other]);
    expect(out[0]?.hint).toContain(HINT);
    expect(out[1]?.hint).toBeUndefined();
    expect(layer.hint).toBeUndefined(); // input not mutated
  });
});

describe('report renders the hint (still real drift, just annotated)', () => {
  it('shows a dim trailing hint line under the finding — tier unchanged, counted as drift', () => {
    const lines: string[] = [];
    const f: Finding = {
      tier: 'declared',
      logicalId: 'Role',
      resourceType: 'AWS::IAM::Role',
      path: 'ManagedPolicyArns',
      desired: [BASIC],
      actual: [TRACER_POLICY, BASIC],
    };
    const code = report([f], 'stack (ap-northeast-1)', { log: (s) => lines.push(s) });
    const text = lines.join('\n');
    expect(text).toContain(`↳ looks like ${HINT}`);
    expect(text).toContain('CFn-Declared Drift'); // still classified & counted as real drift
    expect(code).toBe(1);
  });
});

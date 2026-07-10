import { describe, expect, it } from 'vite-plus/test';
import { buildRevertPlan, type PatchOp } from '../src/revert/plan.js';
import type { Finding } from '../src/types.js';

// #725: raw CFn / SAM templates legally declare integers/booleans as STRINGS
// ("DelaySeconds": "300"). Detection folds the stringly-equal difference, but the
// revert patch must not write the string into an integer/boolean-typed Cloud Control
// model property — CC rejects it with `ValidationException: expected type: Integer,
// found: String`, leaving the genuine drift permanently unrevertable. buildRevertPlan
// coerces the declared string scalar toward the LIVE value's real JSON type (the type
// CloudFormation already coerced the live value to), losslessly, and leaves anything
// non-clean verbatim (fail safe).

const F = (over: Partial<Finding>): Finding => ({
  tier: 'declared',
  logicalId: 'R',
  physicalId: 'phys-1',
  resourceType: 'AWS::SQS::Queue',
  path: 'DelaySeconds',
  ...over,
});

const op0 = (f: Finding): PatchOp => {
  const plan = buildRevertPlan([f], undefined);
  expect(plan.items).toHaveLength(1);
  return plan.items[0]!.ops[0]!;
};

describe('#725 revert scalar type coercion (declared drift)', () => {
  it('string "300" desired + integer live 100 → patch value is the NUMBER 300', () => {
    const op = op0(F({ desired: '300', actual: 100 }));
    expect(op).toMatchObject({ op: 'add', path: '/DelaySeconds' });
    expect(op.value).toBe(300);
    expect(typeof op.value).toBe('number');
  });

  it('string "true" desired + boolean live false → patch value is the boolean true', () => {
    const op = op0(
      F({
        resourceType: 'AWS::SQS::Queue',
        path: 'FifoQueue',
        desired: 'true',
        actual: false,
      })
    );
    expect(op.value).toBe(true);
    expect(typeof op.value).toBe('boolean');
  });

  it('string "false" desired + boolean live true → patch value is the boolean false', () => {
    const op = op0(F({ path: 'FifoQueue', desired: 'false', actual: true }));
    expect(op.value).toBe(false);
  });

  it('genuinely-string property (string desired + string live) is left as a string — no coercion', () => {
    // The property's real type is string, so the live value is a string too; nothing coerces.
    const op = op0(
      F({
        resourceType: 'AWS::SQS::Queue',
        path: 'QueueName',
        desired: 'my-queue',
        actual: 'other-queue',
      })
    );
    expect(op.value).toBe('my-queue');
    expect(typeof op.value).toBe('string');
  });

  it('a numeric-LOOKING string ("100") stays a string when the live value is also a string', () => {
    // Live is a string → the real type is string, so a numeric-looking value must NOT
    // be turned into a number (that would corrupt a genuinely-string property).
    const op = op0(F({ path: 'ContentBasedDeduplication', desired: '100', actual: '200' }));
    expect(op.value).toBe('100');
    expect(typeof op.value).toBe('string');
  });

  it('non-numeric string for an integer property is left VERBATIM (fail safe, no NaN)', () => {
    const op = op0(F({ desired: 'abc', actual: 100 }));
    expect(op.value).toBe('abc');
  });

  it('empty / whitespace string for an integer property is left verbatim (Number("") is a lossy 0)', () => {
    expect(op0(F({ desired: '', actual: 100 })).value).toBe('');
    expect(op0(F({ desired: '   ', actual: 100 })).value).toBe('   ');
  });

  it('non-"true"/"false" string for a boolean property is left verbatim', () => {
    const op = op0(F({ path: 'FifoQueue', desired: 'yes', actual: false }));
    expect(op.value).toBe('yes');
  });

  it('already-numeric desired + numeric live passes through unchanged', () => {
    const op = op0(F({ desired: 300, actual: 100 }));
    expect(op.value).toBe(300);
  });

  it('a non-scalar (object) declared drift is untouched by scalar coercion', () => {
    const desired = { deadLetterTargetArn: 'arn:x', maxReceiveCount: 5 };
    const op = op0(F({ path: 'RedrivePolicy', desired, actual: { maxReceiveCount: 3 } }));
    expect(op.value).toEqual(desired);
  });

  it('negative and decimal numeric strings coerce for a number-typed live value', () => {
    expect(op0(F({ desired: '-5', actual: 10 })).value).toBe(-5);
    expect(op0(F({ path: 'Weight', desired: '1.5', actual: 2 })).value).toBe(1.5);
  });
});

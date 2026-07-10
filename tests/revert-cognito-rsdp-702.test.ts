import { describe, expect, it } from 'vite-plus/test';
import { KNOWN_DEFAULTS } from '../src/normalize/noise.js';
import { REVERT_SET_DEFAULT_PATHS, buildRevertPlan } from '../src/revert/plan.js';
import type { BaselineFile } from '../src/baseline/baseline-file.js';
import type { Finding } from '../src/types.js';

const F = (over: Partial<Finding>): Finding => ({
  tier: 'undeclared',
  logicalId: 'R',
  physicalId: 'us-east-1_pool',
  resourceType: 'AWS::Cognito::UserPool',
  path: 'VerificationMessageTemplate',
  ...over,
});

const baseline = (recorded: BaselineFile['recorded']): BaselineFile => ({
  schemaVersion: 1,
  stackName: 's',
  region: 'r',
  accountId: '111122223333',
  capturedAt: '',
  templateHash: '',
  recorded,
});

// GUARD: UpdateUserPool is a full-PUT that IGNORES an omitted property, so a KNOWN_DEFAULTS
// UserPool fold WITHOUT a matching REVERT_SET_DEFAULT_PATHS entry plans a bare `remove` that
// the provider silently no-ops (#702). This test pairs every current + future UserPool
// KNOWN_DEFAULTS key with its RSDP entry so a forgotten pairing fails CI, not live revert.
describe('#702 guard: every Cognito UserPool KNOWN_DEFAULTS fold has an RSDP entry', () => {
  const userPoolDefaults = KNOWN_DEFAULTS['AWS::Cognito::UserPool'];

  it('KNOWN_DEFAULTS[AWS::Cognito::UserPool] is non-empty (guard has something to check)', () => {
    expect(userPoolDefaults).toBeDefined();
    expect(Object.keys(userPoolDefaults ?? {}).length).toBeGreaterThan(0);
  });

  for (const path of Object.keys(userPoolDefaults ?? {})) {
    it(`${path} is in REVERT_SET_DEFAULT_PATHS`, () => {
      expect(REVERT_SET_DEFAULT_PATHS.has(`AWS::Cognito::UserPool\0${path}`)).toBe(true);
    });
  }
});

// FUNCTIONAL: the remaining six paths (#702 addendum) must now plan an explicit set-default
// `add` write (value present, resolved from KNOWN_DEFAULTS), NOT a bare `remove`.
describe('#702: UserPool folded defaults revert as explicit set-default writes, not bare remove', () => {
  const cases: Array<[string, unknown, unknown]> = [
    [
      'VerificationMessageTemplate',
      { DefaultEmailOption: 'CONFIRM_WITH_LINK' },
      { DefaultEmailOption: 'CONFIRM_WITH_CODE' },
    ],
    [
      'AccountRecoverySetting',
      { RecoveryMechanisms: [{ Priority: 1, Name: 'admin_only' }] },
      {
        RecoveryMechanisms: [
          { Priority: 1, Name: 'verified_email' },
          { Priority: 2, Name: 'verified_phone_number' },
        ],
      },
    ],
    [
      'EmailConfiguration',
      { EmailSendingAccount: 'DEVELOPER' },
      { EmailSendingAccount: 'COGNITO_DEFAULT' },
    ],
    ['KeyConfiguration', { KeyType: 'CUSTOMER_KEY' }, { KeyType: 'AWS_OWNED_KEY' }],
    ['IssuerConfiguration', { Type: 'CUSTOM' }, { Type: 'ORIGINAL' }],
    ['WebAuthnFactorConfiguration', 'MULTI_FACTOR', 'SINGLE_FACTOR'],
  ];

  for (const [path, actual, expectedDefault] of cases) {
    it(`${path} -> add op writing the KNOWN_DEFAULTS default`, () => {
      const f = F({ path, actual });
      const plan = buildRevertPlan([f], baseline([]));
      const op = plan.items[0]!.ops[0]!;
      // NOT a bare no-op remove — an explicit set-default write.
      expect(op.op).toBe('add');
      expect(op.path).toBe(`/${path}`);
      expect(op.value).toEqual(expectedDefault);
      expect(op.prior).toEqual(actual);
    });
  }

  it('the set-default value is sourced from KNOWN_DEFAULTS (not hard-coded in plan.ts)', () => {
    const f = F({ path: 'VerificationMessageTemplate', actual: {} });
    const plan = buildRevertPlan([f], baseline([]));
    expect(plan.items[0]!.ops[0]!.value).toEqual(
      KNOWN_DEFAULTS['AWS::Cognito::UserPool']!.VerificationMessageTemplate
    );
  });
});

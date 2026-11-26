// #1971: the `--assume-role <arn>` value — pure parsing / placeholder resolution, no AWS.
//
// The value is an IAM role ARN TEMPLATE: `{account}` and `{region}` are replaced PER STACK
// (the stack's synthesized env account / its resolved region), so one flag serves a
// multi-account / multi-region app (`arn:aws:iam::{account}:role/MyReadRole`). Anything else
// in braces is rejected up front: a typo'd placeholder (`{Account}`, `{acount}`) would
// otherwise reach STS as a literal and fail per stack with an opaque validation error.

/** The placeholders an `--assume-role` value may carry. */
export const ASSUME_ROLE_PLACEHOLDERS = ['{account}', '{region}'] as const;

// arn:<partition>:iam::<12-digit account>:role/<optional path/><name> — the IAM role-name
// character set ([\w+=,.@-]); `/`-separated path segments, none empty.
const ROLE_ARN_RE = /^arn:aws(?:-[a-z]+)*:iam::\d{12}:role\/(?:[\w+=,.@-]+\/)*[\w+=,.@-]+$/;

function substitute(template: string, account: string, region: string): string {
  return template.replaceAll('{account}', account).replaceAll('{region}', region);
}

/**
 * Validate an `--assume-role` value at parse time (before any synth or AWS call), so a
 * malformed value fails the whole run with exit 2 instead of erroring once per stack.
 * Throws with a message naming the flag.
 */
export function validateAssumeRoleTemplate(template: string): void {
  // Probe with representative values: what is left after substitution must be a role ARN.
  const probe = substitute(template, '123456789012', 'us-east-1');
  const leftover = /\{[^}]*\}/.exec(probe);
  if (leftover) {
    throw new Error(
      `--assume-role: unknown placeholder "${leftover[0]}" in "${template}" — ` +
        `only ${ASSUME_ROLE_PLACEHOLDERS.join(' and ')} are supported`
    );
  }
  if (!ROLE_ARN_RE.test(probe)) {
    throw new Error(
      `--assume-role: "${template}" is not an IAM role ARN ` +
        `(expected arn:aws:iam::<account>:role/<name>; ${ASSUME_ROLE_PLACEHOLDERS.join(' / ')} placeholders allowed)`
    );
  }
}

/** Whether a RESOLVED value is an IAM role ARN. */
export function isRoleArn(arn: string): boolean {
  return ROLE_ARN_RE.test(arn);
}

/** Whether the template needs the stack's account to resolve. */
export function needsAccount(template: string): boolean {
  return template.includes('{account}');
}

/** Resolve the template for ONE stack. `account` must be a concrete 12-digit id. */
export function resolveAssumeRoleArn(template: string, account: string, region: string): string {
  return substitute(template, account, region);
}

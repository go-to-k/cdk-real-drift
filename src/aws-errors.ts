// Classify "this CloudFormation stack is not deployed (yet)" errors. Synth-based
// stack discovery can surface a stack that exists in the CDK code but has not been
// deployed (new stack, renamed stack, different region) — that is not an error, it
// just means there is nothing to drift-check.
export function isStackNotDeployed(e: unknown): boolean {
  const msg = (e as { message?: string })?.message ?? String(e);
  return /does not exist/i.test(msg) || (/ValidationError/i.test(msg) && /stack/i.test(msg));
}

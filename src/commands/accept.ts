// `cdkdrift accept <stack>` (alias of init) — write the current undeclared state
// into the baseline FILE. Writes ONLY the git-committed baseline; no AWS writes.
import { parseCommonArgs } from '../cli-args.js';
import { gatherFindings } from './gather.js';
import { buildAccepted, writeBaseline, hashTemplate } from '../baseline/baseline-file.js';

export async function runAccept(args: string[]): Promise<number> {
  const a = parseCommonArgs(args);
  if (!a.stackName) {
    console.error('usage: cdkdrift accept <stack> [--region r]');
    return 2;
  }
  const { desired, findings } = await gatherFindings(a.stackName, a.region);
  const accepted = buildAccepted(findings);
  const path = await writeBaseline({
    schemaVersion: 1,
    stackName: a.stackName,
    region: a.region,
    capturedAt: new Date().toISOString(),
    templateHash: hashTemplate(desired.rawTemplate),
    accepted,
  });
  console.log(`baseline written: ${path} (${accepted.length} undeclared value(s) blessed)`);
  console.log('commit this file so drift is detected against it going forward.');
  return 0;
}

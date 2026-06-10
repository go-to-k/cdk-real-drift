// `cdkrd accept [<stack>...] [--all]` (alias: init) — write the current undeclared
// state into the baseline FILE(s). Writes ONLY git-committed baselines; no AWS writes.
import { buildAccepted, hashTemplate, loadBaseline, writeBaseline } from "../baseline/baseline-file.js";
import { parseCommonArgs } from "../cli-args.js";
import { listAllStacks } from "../desired/list-stacks.js";
import { gatherFindings } from "./gather.js";

export async function runAccept(args: string[]): Promise<number> {
  const a = parseCommonArgs(args);
  const stacks = a.all ? await listAllStacks(a.region) : a.stackNames;
  if (stacks.length === 0) {
    console.error("usage: cdkrd accept <stack>... | --all [--region r] [--yes]");
    return 2;
  }

  let worst = 0;
  for (const stackName of stacks) {
    try {
      if (!a.yes && (await loadBaseline(stackName, a.region))) {
        console.error(`note: ${stackName}: overwriting existing baseline (it is git-tracked; review the diff). Pass --yes to silence.`);
      }
      const { desired, findings } = await gatherFindings(stackName, a.region);
      const accepted = buildAccepted(findings);
      const path = await writeBaseline({
        schemaVersion: 1,
        stackName,
        region: a.region,
        capturedAt: new Date().toISOString(),
        templateHash: hashTemplate(desired.rawTemplate),
        accepted,
      });
      console.log(`baseline written: ${path} (${accepted.length} undeclared value(s) blessed)`);
    } catch (e) {
      console.error(`error: ${stackName}: ${(e as Error).message}`);
      worst = Math.max(worst, 2);
    }
  }
  if (worst === 0) console.log("commit the baseline file(s) so drift is detected against them going forward.");
  return worst;
}

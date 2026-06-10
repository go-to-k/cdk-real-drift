// `cdkrd check [<stack>...] [--all] [--region r] [--json] [--fail-on declared|undeclared] [--no-baseline]`
// Read-only. Reports drift per stack; undeclared findings are filtered against the
// baseline file (if present) so a blessed stack reports CLEAN. Exit code is the
// worst across all checked stacks (0 clean / 1 drift / 2 error).
import { applyBaseline, loadBaseline } from "../baseline/baseline-file.js";
import { parseCommonArgs } from "../cli-args.js";
import { listAllStacks } from "../desired/list-stacks.js";
import { report } from "../report/report.js";
import { gatherFindings } from "./gather.js";

export async function runCheck(args: string[]): Promise<number> {
  const a = parseCommonArgs(args);
  const stacks = a.all ? await listAllStacks(a.region) : a.stackNames;
  if (stacks.length === 0) {
    console.error("usage: cdkrd check <stack>... | --all [--region r] [--json] [--fail-on declared|undeclared] [--no-baseline]");
    return 2;
  }

  let worst = 0;
  for (const stackName of stacks) {
    try {
      const { findings } = await gatherFindings(stackName, a.region);
      const baseline = a.noBaseline ? undefined : await loadBaseline(stackName, a.region);
      if (!a.json && !baseline) {
        console.error(
          `note: ${stackName}: no baseline — showing all non-default undeclared state. Run \`cdkrd accept ${stackName}\` to bless it.`,
        );
      }
      const code = report(applyBaseline(findings, baseline), `${stackName} (${a.region})`, { json: a.json, failOn: a.failOn });
      worst = Math.max(worst, code);
    } catch (e) {
      console.error(`error: ${stackName}: ${(e as Error).message}`);
      worst = Math.max(worst, 2);
    }
  }
  return worst;
}

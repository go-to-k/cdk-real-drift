// `cdkrd check <stack> [--region r] [--json] [--fail-on declared|undeclared] [--no-baseline]`
// Read-only. Reports drift; undeclared findings are filtered against the baseline
// file (if present) so a blessed stack reports CLEAN.

import { applyBaseline, loadBaseline } from "../baseline/baseline-file.js";
import { parseCommonArgs } from "../cli-args.js";
import { report } from "../report/report.js";
import { gatherFindings } from "./gather.js";

export async function runCheck(args: string[]): Promise<number> {
  const a = parseCommonArgs(args);
  if (!a.stackName) {
    console.error("usage: cdkrd check <stack> [--region r] [--json] [--fail-on declared|undeclared] [--no-baseline]");
    return 2;
  }
  const { findings } = await gatherFindings(a.stackName, a.region);
  const baseline = a.noBaseline ? undefined : await loadBaseline(a.stackName, a.region);
  const filtered = applyBaseline(findings, baseline);
  if (!a.json && !baseline) {
    console.error("note: no baseline file — showing all non-default undeclared state. Run `cdkrd accept` to bless the current state.");
  }
  return report(filtered, `${a.stackName} (${a.region})`, { json: a.json, failOn: a.failOn });
}

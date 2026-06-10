// `cdkdrift check <stack>` — the core, read-only.
// Pipeline (see DESIGN.md):
//   baseline load → desired(GetTemplate+resolve) → live read(CC/SDK)
//   → normalize/subtract → classify → report → exit code
//
// Exit: 0 clean / 1 drift / 2 error. --fail-on <tier> selects which tier fails CI.
export async function runCheck(_args: string[]): Promise<number> {
  // TODO(phase2): wire the pipeline:
  //   const { stack, region, preDeploy, failOn, json } = parseArgs(_args);
  //   const baseline = await loadBaseline(stack, region);
  //   const desired  = await loadDesired(stack, region);   // desired/template-adapter
  //   const live     = await readStack(desired.resources, region); // read/router
  //   const findings = classify(desired, live, baseline);  // diff + normalize
  //   return report(findings, { failOn, json });
  console.error('check: not implemented yet (phase 2 skeleton)');
  return 2;
}

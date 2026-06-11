// Resolve which stacks a command operates on, each with the region to query it in:
//   --all                  → every deployed stack in the region (needs --region)
//   <stack>... positional  → those names in --region (no synth — runs anywhere)
//   neither                → synth the CDK app (--app / $CDKRD_APP / cdk.json) and
//                            auto-discover its stacks, each in its OWN env.region
//                            (falling back to --region for env-agnostic stacks)
import type { CommonArgs } from '../cli-args.js';
import { listAllStacks } from '../desired/list-stacks.js';
import { resolveApp } from '../synth/resolve-app.js';
import { discoverStacks } from '../synth/synth.js';

export interface ResolvedStack {
  stackName: string;
  region: string | undefined; // region to query this stack in (may be undefined → caller errors)
}

export async function resolveStacks(a: CommonArgs): Promise<ResolvedStack[]> {
  if (a.all) {
    if (!a.region) return [];
    return (await listAllStacks(a.region)).map((stackName) => ({ stackName, region: a.region }));
  }
  if (a.stackNames.length > 0) {
    return a.stackNames.map((stackName) => ({ stackName, region: a.region }));
  }
  const app = resolveApp(a.app);
  if (app) {
    const discovered = await discoverStacks(app, {
      region: a.region,
      profile: a.profile,
      context: a.context,
    });
    return discovered.map((s) => ({ stackName: s.stackName, region: s.region ?? a.region }));
  }
  return [];
}

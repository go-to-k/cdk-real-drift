// Resolve which stacks a command operates on:
//   --all                  → every deployed stack in the region
//   <stack>... positional  → those names (no synth — runs anywhere by name)
//   neither                → synth the CDK app (--app / $CDKRD_APP / cdk.json)
//                            and auto-discover its stack names
import type { CommonArgs } from '../cli-args.js';
import { listAllStacks } from '../desired/list-stacks.js';
import { resolveApp } from '../synth/resolve-app.js';
import { discoverStackNames } from '../synth/synth.js';

export async function resolveStacks(a: CommonArgs, region: string): Promise<string[]> {
  if (a.all) return listAllStacks(region);
  if (a.stackNames.length > 0) return a.stackNames;
  const app = resolveApp(a.app);
  if (app) return discoverStackNames(app, region, a.context);
  return [];
}

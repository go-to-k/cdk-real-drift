// Resolve which stacks a command operates on, each with the region to query it in:
//   --all                  → every deployed stack in the region (needs --region)
//   <stack>... positional  → exact names in --region (no synth — runs anywhere);
//                            a name with a glob char (`*`/`?`) is matched against
//                            the synth-discovered stacks, keeping each match's own region
//   neither                → synth the CDK app (--app / $CDKRD_APP / cdk.json) and
//                            auto-discover its stacks, each in its OWN env.region
//                            (falling back to --region for env-agnostic stacks)
import type { CommonArgs } from '../cli-args.js';
import { listAllStacks } from '../desired/list-stacks.js';
import { resolveApp } from '../synth/resolve-app.js';
import { discoverStacks } from '../synth/synth.js';
import { isGlob, matchesGlob } from './glob-match.js';

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
    const patterns = a.stackNames.filter(isGlob);
    if (patterns.length === 0) {
      // pure-exact path: keep today's no-synth behavior
      return a.stackNames.map((stackName) => ({ stackName, region: a.region }));
    }
    // at least one glob → synth-discover candidates to match patterns against
    const app = resolveApp(a.app);
    if (!app) {
      throw new Error(
        `wildcard stack selection (${patterns.join(', ')}) needs a CDK app to discover stack names — run in a CDK app dir or pass --app`
      );
    }
    const discovered = await discoverStacks(app, {
      region: a.region,
      profile: a.profile,
      context: a.context,
    });
    const seen = new Set<string>();
    const out: ResolvedStack[] = [];
    const add = (stackName: string, region: string | undefined): void => {
      const key = `${stackName}\0${region ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ stackName, region });
    };
    for (const name of a.stackNames) {
      if (isGlob(name)) {
        for (const s of discovered) {
          if (matchesGlob(name, s.stackName)) add(s.stackName, s.region ?? a.region);
        }
      } else {
        // exact name in a mixed arg list: keep its discovered region if known
        const hit = discovered.find((s) => s.stackName === name);
        add(name, hit ? (hit.region ?? a.region) : a.region);
      }
    }
    if (out.length === 0) {
      throw new Error(
        `no stacks match ${patterns.join(', ')} (discovered: ${discovered.map((s) => s.stackName).join(', ') || 'none'})`
      );
    }
    return out;
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

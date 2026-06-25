// Resolve which stacks a command operates on, each with the region to query it in.
// cdkrd is CDK-only: it ALWAYS resolves a CDK app (synth, or a pre-synthesized
// `cdk.out` assembly via `--app`) and operates on the stacks that app defines —
// there is no "check an arbitrary deployed CloudFormation stack by name" mode. The
// drift comparison still reads each stack's DEPLOYED template + live state from AWS
// (reality vs intent); the app is used only to discover stack names + their regions
// (and, downstream, construct-path display).
//
//   no positional args    → every stack the app defines, each in its OWN env.region
//                           (falling back to --region for env-agnostic stacks)
//   <stack>... positional → exact names must exist in the app; a name with a glob
//                           char (`*`/`?`) is matched against the app's stack names
import type { CommonArgs } from '../cli-args.js';
import { resolveApp } from '../synth/resolve-app.js';
import { discoverStacks } from '../synth/synth.js';
import { isGlob, matchesGlob } from './glob-match.js';

export interface ResolvedStack {
  stackName: string;
  region: string | undefined; // region to query this stack in (may be undefined → caller errors)
  // the synthesized template for this stack — used by check to recover GetTemplate's
  // `?`-masked non-ASCII literals. Carried from the same synth that discovered the stack.
  template: Record<string, unknown>;
}

export async function resolveStacks(a: CommonArgs): Promise<ResolvedStack[]> {
  const app = resolveApp(a.app);
  if (!app) {
    throw new Error(
      'cdkrd needs a CDK app: run in a directory with cdk.json, pass --app "<cmd>" or --app <cdk.out> (a pre-synthesized assembly), or set $CDKRD_APP'
    );
  }
  const discovered = await discoverStacks(app, {
    region: a.region,
    profile: a.profile,
    context: a.context,
  });

  // --all, or no names → every stack the app defines. --all is the explicit form of the
  // no-argument default; it also overrides any positional names (target everything).
  if (a.all || a.stackNames.length === 0) {
    return discovered.map((s) => ({
      stackName: s.stackName,
      region: s.region ?? a.region,
      template: s.template,
    }));
  }

  // names (exact and/or glob) matched against the app's stacks
  const seen = new Set<string>();
  const out: ResolvedStack[] = [];
  const add = (
    stackName: string,
    region: string | undefined,
    template: Record<string, unknown>
  ): void => {
    const key = `${stackName}\0${region ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ stackName, region, template });
  };
  const known = (): string => discovered.map((s) => s.stackName).join(', ') || 'none';
  for (const name of a.stackNames) {
    if (isGlob(name)) {
      for (const s of discovered) {
        if (matchesGlob(name, s.stackName)) add(s.stackName, s.region ?? a.region, s.template);
      }
    } else {
      const hit = discovered.find((s) => s.stackName === name);
      if (!hit)
        throw new Error(`stack "${name}" is not defined by the CDK app (found: ${known()})`);
      add(hit.stackName, hit.region ?? a.region, hit.template);
    }
  }
  if (out.length === 0) {
    throw new Error(`no stacks match ${a.stackNames.join(', ')} (found: ${known()})`);
  }
  return out;
}

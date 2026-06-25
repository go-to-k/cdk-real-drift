// Synthesize a CDK app via @aws-cdk/toolkit-lib (the same dependency cdk-local
// uses) to discover stacks. Records a CDK app COMMAND (`node app.js`) or a
// pre-synthesized cloud-assembly DIRECTORY (`cdk.out`). Drift detection itself
// does not need this — it is used for stack auto-discovery (and later clobber).
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { BaseCredentials, CdkAppMultiContext, Toolkit } from '@aws-cdk/toolkit-lib';
import { QuietIoHost } from './io-host.js';

export interface SynthOptions {
  region?: string | undefined;
  profile?: string | undefined;
  context?: Record<string, string>;
}

export interface SynthStack {
  stackName: string;
  region: string | undefined; // the stack's own env.region (concrete) — for per-stack drift reads
  template: Record<string, unknown>;
}

const CONCRETE_REGION = /^[a-z]{2}-[a-z]+-\d+$/;

export async function synthApp(app: string, opts: SynthOptions = {}): Promise<SynthStack[]> {
  const { region, profile, context = {} } = opts;
  const toolkit = new Toolkit({
    ioHost: new QuietIoHost(),
    sdkConfig: {
      baseCredentials: BaseCredentials.awsCliCompatible({
        ...(region && { defaultRegion: region }),
        ...(profile && { profile }),
      }),
    },
  });

  const p = resolve(app);
  const isDir = existsSync(p) && statSync(p).isDirectory();
  let source;
  if (isDir) {
    // pre-synthesized assembly: no subprocess to feed region/profile/context to
    source = await toolkit.fromAssemblyDirectory(p, { failOnMissingContext: false });
  } else {
    const hasOverrides = Object.keys(context).length > 0;
    // feed the app subprocess the same region/profile the user gave so `this.region`
    // / env-based credential lookups resolve as they would under `cdk` (cdk-local).
    const env: Record<string, string> = {};
    if (region) {
      env.AWS_REGION = region;
      env.CDK_DEFAULT_REGION = region;
    }
    if (profile) env.AWS_PROFILE = profile;
    source = await toolkit.fromCdkApp(app, {
      ...(Object.keys(env).length > 0 && { env }),
      // CdkAppMultiContext reads cdk.json / cdk.context.json / ~/.cdk.json as the
      // base layer; our -c/--context overrides win on top (mirrors cdk CLI).
      ...(hasOverrides && { contextStore: new CdkAppMultiContext(process.cwd(), context) }),
    });
  }

  const cached = await toolkit.synth(source);
  try {
    // `stacksRecursively` (NOT `stacks`): `stacks` returns only the TOP-LEVEL
    // assembly's stacks, so every stack nested inside a CDK `Stage` (the CDK
    // Pipelines / multi-env pattern) is silently invisible — never discovered, never
    // checked, with no error. `stacksRecursively` descends into nested assemblies and
    // is a SUPERSET of `stacks`, so a non-staged app is unaffected. `s.stackName` is
    // the deployed CloudFormation stack name (CDK stage-qualifies it), which is the
    // correct live-read target.
    return cached.cloudAssembly.stacksRecursively.map((s) => ({
      stackName: s.stackName,
      region: CONCRETE_REGION.test(s.environment.region) ? s.environment.region : undefined,
      template: s.template as Record<string, unknown>,
    }));
  } finally {
    await cached.dispose();
  }
}

export interface DiscoveredStack {
  stackName: string;
  region: string | undefined; // the stack's own env.region, when concrete
  // the synthesized template — carried through so the check path can recover GetTemplate's
  // `?`-masked non-ASCII literals from it without re-synthesizing (synthApp already built it).
  template: Record<string, unknown>;
}

/** Synth and return each stack's name + its own (concrete) region + template, for discovery. */
export async function discoverStacks(
  app: string,
  opts: SynthOptions = {}
): Promise<DiscoveredStack[]> {
  return (await synthApp(app, opts)).map((s) => ({
    stackName: s.stackName,
    region: s.region,
    template: s.template,
  }));
}

// Synthesize a CDK app via @aws-cdk/toolkit-lib (the same dependency cdk-local
// uses) to discover stacks. Records a CDK app COMMAND (`node app.js`) or a
// pre-synthesized cloud-assembly DIRECTORY (`cdk.out`). Drift detection itself
// does not need this — it is used for stack auto-discovery (and later clobber).
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { BaseCredentials, CdkAppMultiContext, Toolkit } from '@aws-cdk/toolkit-lib';
import { QuietIoHost } from './io-host.js';
import {
  collectMissingRecursively,
  missingContextKeys,
  missingContextWarning,
} from './missing-context.js';

export interface SynthOptions {
  region?: string | undefined;
  profile?: string | undefined;
  context?: Record<string, string>;
  // When the caller uses the synth template as the DECLARED source (`--pre-deploy`), an
  // assembly synthesized with unresolved context lookups is fabricated (CDK's dummy
  // `vpc-12345` placeholders). Escalate the missing-context surface from a warning to a
  // hard refusal (throw) in that mode (#907). Discovery (default) only warns.
  preDeploy?: boolean;
}

export interface SynthStack {
  stackName: string;
  region: string | undefined; // the stack's own env.region (concrete) — for per-stack drift reads
  template: Record<string, unknown>;
}

// A concrete AWS region pin. Allows the multi-part infixes of GovCloud / ISO partitions
// (`us-gov-west-1`, `us-iso-east-1`, `us-isob-east-1`, `eu-isoe-west-1`), not just the
// three-segment commercial form — otherwise those pins test false and env.region is silently
// discarded, so the stack is read against the wrong region (#742).
export const CONCRETE_REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;

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
    // A CDK app whose context lookups are unresolved still synthesizes — CDK fills every
    // gap with a well-known DUMMY value (`vpc-12345`, ...) and records the gap in the
    // manifest's `missing` array. Surface that loudly (#907): a template carrying those
    // placeholders does not reflect real infrastructure. Always warn on discovery; under
    // `--pre-deploy` (synth template = declared source) REFUSE, because the fabricated
    // values would drive false declared drift and a revert would write them back to AWS.
    // Aggregate `missing` RECURSIVELY across nested-Stage assemblies (mirroring the
    // `stacksRecursively` descent below): a stack nested inside a CDK `Stage` records its
    // unresolved lookups in its OWN nested manifest, not the top-level one, so a
    // top-level-only read would let a dummy `vpc-12345` inside a staged stack slip past
    // `--pre-deploy` — reintroducing exactly the false declared drift #907 blocks (#987).
    const missingKeys = missingContextKeys(collectMissingRecursively(cached.cloudAssembly));
    if (missingKeys.length > 0) {
      const msg = missingContextWarning(missingKeys, { preDeploy: opts.preDeploy });
      if (opts.preDeploy) throw new Error(msg ?? 'unresolved CDK context lookups');
      console.error(`warning: ${msg}`);
    }

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
